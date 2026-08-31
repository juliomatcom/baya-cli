import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  PROTOCOL_VERSION,
  type ProviderEvent,
  type TaskRequest,
} from '../manifest/index.js';
import type { Logger } from '../log/index.js';
import type { ProviderAdapter } from '../providers/index.js';
import { runProcess } from '../executor/spawn.js';

/**
 * Runs the planner through a normal provider adapter. Planning is just a task
 * with an unusual schema, so it inherits argv construction, stdin discipline,
 * process-group spawning, and ANSI stripping for free rather than growing a
 * second, subtly different spawn path.
 */
export interface RunPlannerProviderOptions {
  adapter: ProviderAdapter;
  bin: string;
  cwd: string;
  model: string | null;
  /** The plan-draft schema, for providers that enforce one. */
  schemaPath: string;
  /** Where a `schema-file` provider leaves its JSON. Removed before each attempt. */
  resultFile: string;
  runId: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const PLANNER_TASK_ID = 'baya-planner';

export function runPlannerProvider(
  options: RunPlannerProviderOptions,
): (prompt: string, attempt: number) => Promise<string> {
  const request: TaskRequest = {
    baya: PROTOCOL_VERSION,
    kind: 'task_request',
    run_id: options.runId,
    task: { id: PLANNER_TASK_ID, title: 'Plan the task list', instruction: '' },
    workspace: { cwd: options.cwd, access: 'read-only', isolation: 'shared' },
    context: [],
    response_contract: { schema_path: options.schemaPath },
    constraints: { max_runtime_s: Math.floor((options.timeoutMs ?? 300_000) / 1000) },
  };

  return async (prompt: string): Promise<string> => {
    mkdirSync(dirname(options.resultFile), { recursive: true });
    // A leftover file from the previous attempt would be read as this
    // attempt's answer, and the repair loop would never see the repair.
    rmSync(options.resultFile, { force: true });

    const plan = options.adapter.buildRun({
      bin: options.bin,
      task: {
        id: PLANNER_TASK_ID,
        title: request.task.title,
        instruction: prompt,
        provider: options.adapter.id,
        model: options.model,
        depends_on: [],
        // Planning reads the repo; it never writes to it.
        access: 'read-only',
        cwd: null,
      },
      request,
      model: options.model,
      cwd: options.cwd,
      schemaPath: options.schemaPath,
      schemaContents: readFileSync(options.schemaPath, 'utf8'),
      resultFile: options.resultFile,
      prompt,
    });

    const events: ProviderEvent[] = [];
    const outcome = await runProcess({
      plan,
      ...(options.env ? { env: options.env } : {}),
      timeoutMs: options.timeoutMs ?? 300_000,
      onStdoutLine: (line) => {
        events.push(...options.adapter.parseEvents(line));
      },
    });

    try {
      const contents = readFileSync(options.resultFile, 'utf8');
      if (contents.trim() !== '') return contents;
    } catch {
      // No schema-enforced file: fall back to the assistant text below.
    }

    const text = events
      .filter(
        (event): event is Extract<ProviderEvent, { t: 'text' }> => event.t === 'text',
      )
      .map((event) => event.text)
      .join('\n');
    if (text.trim() !== '') return text;

    options.logger.warn('plan.received.empty', {
      exit_code: outcome.code,
      stderr_tail: outcome.stderr.trim().split('\n').slice(-3).join(' '),
    });
    return outcome.stdout;
  };
}
