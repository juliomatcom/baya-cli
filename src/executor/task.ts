import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ProviderEventSchema,
  type ProviderEvent,
  type Task,
  type TaskRequest,
  type TaskResult,
} from '../manifest/index.js';
import type { Logger } from '../log/index.js';
import type { Observation } from '../memory/index.js';
import type {
  ProviderAdapter,
  ProviderUsage,
  ToolCapability,
} from '../providers/index.js';
import { runProcess } from './spawn.js';
import type { RunPaths } from './paths.js';
import { renderGroupPrompt } from './prompt.js';

/**
 * One provider process, start to finish: write a request per task, spawn the
 * adapter's plan, forward every provider event up as it arrives, then persist
 * the full record.
 *
 * The unit here is a **group** (execution.md §Grouping), not a task — a
 * process may carry several tasks and answers with one document holding one
 * result per task. A group of one is the ordinary case and takes exactly the
 * path it always did, down to the wire format.
 *
 * Everything the child emits reaches the main process (logging.md §Provider
 * output bubbles up as `info`) — a running group is never a black box between
 * spawn and result.
 */
export interface ExecuteGroupOptions {
  /** The group's tasks, in execution order. The first is the group leader. */
  tasks: readonly Task[];
  /** One request per task, same order. Each is persisted to its own file. */
  requests: readonly TaskRequest[];
  adapter: ProviderAdapter;
  bin: string;
  model: string | null;
  cwd: string;
  paths: RunPaths;
  /**
   * The response contract for this process: the `task_result` schema for one
   * task, the `task_result_batch` schema for a group.
   */
  schemaPath: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  dangerouslyAllowAll?: boolean;
  /** Capabilities restored on top of this provider's lean tool set. */
  tools?: readonly ToolCapability[];
  /** Raw argv from `providers.<id>.extraArgs`, appended to the spawn. */
  extraArgs?: readonly string[];
  onSpawn?: (pid: number, pgid: number) => void;
  /** Rendered memory block, injected into the prompt. `""`/absent => no section. */
  memory?: string;
}

export interface GroupExecution {
  /** One per task in `tasks`, in that order. Never short, never reordered. */
  results: TaskResult[];
  events: ProviderEvent[];
  sessionId: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  /**
   * The **process's** usage, not any one task's. A group shares one context
   * window and one bill; splitting that per task would be inventing numbers.
   * The scheduler records it against the group leader.
   */
  usage: ProviderUsage;
  argv: string[];
  /** What the agent did, for cross-task memory. Empty for `observations: 'none'`. */
  observations: Observation[];
}

function writeFileEnsuringDir(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/**
 * Flatten a tool input to one line for the terminal — whitespace collapsed so
 * it sits on the `⚒` line, but never truncated. The renderer wraps it; the file
 * keeps the exact bytes either way (logging.md rule 3).
 */
function flattenToolInput(input: unknown): string {
  if (input === undefined) return '';
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return text.replace(/\s+/g, ' ').trim();
}

export async function executeGroup(
  options: ExecuteGroupOptions,
): Promise<GroupExecution> {
  const { adapter, logger, paths } = options;
  const tasks = options.tasks;
  const leader = tasks[0] as Task;
  const leaderId = leader.id;
  const taskIds = tasks.map((task) => task.id);
  const grouped = tasks.length > 1;

  // Read once: an adapter that enforces no schema needs it inlined in the
  // prompt, and every adapter needs it for `buildRun`.
  const schemaContents = readFileSync(options.schemaPath, 'utf8');
  const prompt = renderGroupPrompt(options.requests, {
    ...(options.memory ? { memory: options.memory } : {}),
    // Only for the adapters that enforce nothing. Handing a path to one that
    // does enforce makes the agent go and read it — a tool call, and then the
    // whole conversation re-sent, for a guarantee it already had.
    ...(adapter.capabilities.structuredOutput === 'none'
      ? { schema: schemaContents }
      : {}),
  });
  for (const request of options.requests) {
    writeFileEnsuringDir(
      paths.request(request.task.id),
      `${JSON.stringify(request, null, 2)}\n`,
    );
  }
  logger.debug('group.request.written', {
    group_id: leaderId,
    tasks: taskIds,
    bytes: Buffer.byteLength(prompt, 'utf8'),
  });

  // A group answers with one document, so it needs one place to put it. The
  // ungrouped case keeps writing straight to `result.json` — the path the
  // adapters, their tests, and every recorded run already use.
  const resultFile = grouped ? paths.batch(leaderId) : paths.result(leaderId);
  const buildInput = {
    bin: options.bin,
    task: leader,
    request: options.requests[0] as TaskRequest,
    model: options.model,
    cwd: options.cwd,
    schemaPath: options.schemaPath,
    // Inline schema for providers that reject a file path (`claude --json-schema`).
    schemaContents,
    resultFile,
    prompt,
    ...(options.dangerouslyAllowAll ? { dangerouslyAllowAll: true } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
  };
  const plan = adapter.buildRun(buildInput);

  for (const file of plan.files ?? []) {
    writeFileEnsuringDir(file.path, file.contents);
  }
  for (const id of taskIds) mkdirSync(paths.taskDir(id), { recursive: true });

  const events: ProviderEvent[] = [];
  let sessionId: string | null = null;
  // One process, one event stream. It lands in the leader's task directory and
  // every member's `artifacts` points at it, rather than being copied N times
  // into directories that would each claim to be the whole story.
  const eventsPath = paths.events(leaderId);

  const record = (event: ProviderEvent): void => {
    events.push(event);
    // Validated on the way out so a malformed adapter mapping fails here, not
    // three layers downstream where the origin is unrecoverable.
    appendFileSync(eventsPath, `${JSON.stringify(ProviderEventSchema.parse(event))}\n`);

    switch (event.t) {
      case 'session':
        sessionId = event.id;
        logger.debug('provider.session', { task_id: leaderId, session_id: event.id });
        break;
      case 'text':
        logger.info('provider.text', {
          task_id: leaderId,
          provider: adapter.id,
          text: event.text,
        });
        break;
      case 'tool':
        logger.info('provider.tool', {
          task_id: leaderId,
          provider: adapter.id,
          name: event.name,
          input: flattenToolInput(event.input),
        });
        break;
      case 'error':
        logger.warn('provider.error', {
          task_id: leaderId,
          provider: adapter.id,
          kind: event.kind,
          message: event.message,
        });
        break;
      default:
        logger.debug('provider.event.unknown', { task_id: leaderId, raw: event.raw });
    }
  };

  // Log before acting (logging.md rule 1): a crash must leave evidence of the
  // last thing attempted. The prompt is elided at the sink, not inlined here.
  logger.info('task.spawned', {
    task_id: leaderId,
    group: taskIds,
    provider: adapter.id,
    model: options.model,
    argv: plan.argv,
    delivery: plan.stdin === 'pipe' ? 'stdin' : 'argv',
    prompt: prompt,
    request: paths.request(leaderId),
  });

  const startedAt = Date.now();
  const outcome = await runProcess({
    plan,
    ...(options.env ? { env: options.env } : {}),
    timeoutMs: options.timeoutMs,
    ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}),
    onStdoutLine: (line) => {
      for (const event of adapter.parseEvents(line)) record(event);
    },
    onStderrLine: (line) => {
      // Where these CLIs put their own diagnostics — worth a human's attention.
      logger.info('provider.stderr', {
        task_id: leaderId,
        provider: adapter.id,
        text: line,
      });
    },
  });
  const durationMs = Date.now() - startedAt;

  writeFileEnsuringDir(paths.stdout(leaderId), outcome.stdout);
  writeFileEnsuringDir(paths.stderr(leaderId), outcome.stderr);

  let resultFileContents: string | null = null;
  try {
    resultFileContents = readFileSync(resultFile, 'utf8');
  } catch {
    resultFileContents = null;
  }

  const extractContext = {
    taskIds,
    events,
    resultFileContents,
    exitCode: outcome.code,
    stderr: outcome.stderr,
  };
  const results = adapter.extractResults(extractContext);
  const observations = adapter.extractObservations?.(extractContext) ?? [];
  logger.debug('group.observations', {
    group_id: leaderId,
    provider: adapter.id,
    count: observations.length,
  });

  // Rewrite each result.json from the validated object: whatever the provider
  // left there was untrusted, and downstream context reads these files.
  results.forEach((result, index) => {
    const id = taskIds[index] as string;
    writeFileEnsuringDir(paths.result(id), `${JSON.stringify(result, null, 2)}\n`);
    writeFileEnsuringDir(paths.output(id), result.output);
  });

  return {
    results,
    events,
    sessionId,
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    durationMs,
    usage: adapter.extractUsage?.(events) ?? {},
    argv: plan.argv,
    observations,
  };
}
