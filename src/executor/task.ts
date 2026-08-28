import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ProviderEventSchema,
  type ProviderEvent,
  type Task,
  type TaskRequest,
  type TaskResult,
} from "../manifest/index.js";
import type { Logger } from "../log/index.js";
import type { ProviderAdapter, ProviderUsage } from "../providers/index.js";
import { runProcess } from "./spawn.js";
import type { RunPaths } from "./paths.js";
import { renderPrompt } from "./prompt.js";

/**
 * One task, start to finish: write the request, spawn the adapter's plan,
 * forward every provider event up as it arrives, then persist the full record.
 *
 * Everything the child emits reaches the main process (logging.md §Provider
 * output bubbles up as `info`) — a running task is never a black box between
 * spawn and result.
 */
export interface ExecuteTaskOptions {
  task: Task;
  request: TaskRequest;
  adapter: ProviderAdapter;
  bin: string;
  model: string | null;
  cwd: string;
  paths: RunPaths;
  schemaPath: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  dangerouslyAllowAll?: boolean;
  onSpawn?: (pid: number, pgid: number) => void;
}

export interface TaskExecution {
  result: TaskResult;
  events: ProviderEvent[];
  sessionId: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  usage: ProviderUsage;
  argv: string[];
}

function writeFileEnsuringDir(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/** Display abbreviation only — the file keeps the full input (logging.md rule 3). */
function abbreviateToolInput(input: unknown, limit = 120): string {
  if (input === undefined) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export async function executeTask(options: ExecuteTaskOptions): Promise<TaskExecution> {
  const { task, adapter, logger, paths } = options;
  const taskId = task.id;

  const prompt = renderPrompt(options.request);
  writeFileEnsuringDir(
    paths.request(taskId),
    `${JSON.stringify(options.request, null, 2)}\n`,
  );
  logger.debug("task.request.written", {
    task_id: taskId,
    path: paths.request(taskId),
    bytes: Buffer.byteLength(prompt, "utf8"),
  });

  const plan = adapter.buildRun({
    bin: options.bin,
    task,
    request: options.request,
    model: options.model,
    cwd: options.cwd,
    schemaPath: options.schemaPath,
    resultFile: paths.result(taskId),
    prompt,
    ...(options.dangerouslyAllowAll ? { dangerouslyAllowAll: true } : {}),
  });

  for (const file of plan.files ?? []) {
    writeFileEnsuringDir(file.path, file.contents);
  }
  mkdirSync(paths.taskDir(taskId), { recursive: true });

  const events: ProviderEvent[] = [];
  let sessionId: string | null = null;
  const eventsPath = paths.events(taskId);

  const record = (event: ProviderEvent): void => {
    events.push(event);
    // Validated on the way out so a malformed adapter mapping fails here, not
    // three layers downstream where the origin is unrecoverable.
    appendFileSync(eventsPath, `${JSON.stringify(ProviderEventSchema.parse(event))}\n`);

    switch (event.t) {
      case "session":
        sessionId = event.id;
        logger.debug("provider.session", { task_id: taskId, session_id: event.id });
        break;
      case "text":
        logger.info("provider.text", {
          task_id: taskId,
          provider: adapter.id,
          text: event.text,
        });
        break;
      case "tool":
        logger.info("provider.tool", {
          task_id: taskId,
          provider: adapter.id,
          name: event.name,
          input: abbreviateToolInput(event.input),
        });
        break;
      case "error":
        logger.warn("provider.error", {
          task_id: taskId,
          provider: adapter.id,
          kind: event.kind,
          message: event.message,
        });
        break;
      default:
        logger.debug("provider.event.unknown", { task_id: taskId, raw: event.raw });
    }
  };

  // Log before acting (logging.md rule 1): a crash must leave evidence of the
  // last thing attempted. The prompt is elided at the sink, not inlined here.
  logger.info("task.spawned", {
    task_id: taskId,
    provider: adapter.id,
    model: options.model,
    argv: plan.argv,
    delivery: plan.stdin === "pipe" ? "stdin" : "argv",
    prompt: prompt,
    request: paths.request(taskId),
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
      logger.info("provider.stderr", {
        task_id: taskId,
        provider: adapter.id,
        text: line,
      });
    },
  });
  const durationMs = Date.now() - startedAt;

  writeFileEnsuringDir(paths.stdout(taskId), outcome.stdout);
  writeFileEnsuringDir(paths.stderr(taskId), outcome.stderr);

  let resultFileContents: string | null = null;
  try {
    resultFileContents = readFileSync(paths.result(taskId), "utf8");
  } catch {
    resultFileContents = null;
  }

  const result = adapter.extractResult({
    taskId,
    events,
    resultFileContents,
    exitCode: outcome.code,
    stderr: outcome.stderr,
  });

  // Rewrite result.json from the validated object: whatever the provider left
  // there was untrusted, and downstream context reads this file.
  writeFileEnsuringDir(paths.result(taskId), `${JSON.stringify(result, null, 2)}\n`);
  writeFileEnsuringDir(paths.output(taskId), result.output);

  return {
    result,
    events,
    sessionId,
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    durationMs,
    usage: adapter.extractUsage?.(events) ?? {},
    argv: plan.argv,
  };
}
