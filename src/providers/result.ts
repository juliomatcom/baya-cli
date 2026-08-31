import {
  PROTOCOL_VERSION,
  TaskResultBatchSchema,
  TaskResultSchema,
  type TaskResult,
} from '../manifest/index.js';
import { stripAnsi } from '../log/index.js';

/**
 * The degradation ladder (protocol.md §4), and the one place that knows a
 * provider process can serve **several** tasks (execution.md §Grouping).
 *
 * Every adapter's happy path funnels through `parseResultJson` or
 * `extractResultFromText`, and every failure path through `synthesizeFailure`.
 * Making those three group-aware is what let grouping land without teaching
 * any adapter about it: an adapter still just says "here is where this
 * provider put the answer", and the shape of the answer is settled here.
 *
 * One task in the process => the plain `task_result` of protocol.md §3, byte
 * for byte what it always was. Two or more => a `task_result_batch` holding
 * one `task_result` per task.
 */

/** Which rung of the degradation ladder (protocol.md §4) produced a result. */
export type ResultRung = 'native' | 'verbatim' | 'fenced' | 'synthesized';

export interface ParsedResults {
  results: TaskResult[];
  rung: ResultRung;
}

/**
 * Rung 5. Never throws, never returns null: a provider that produced nothing
 * usable still has to become a `task_result`, or the scheduler has no state
 * transition to make. One per task in the process — a process that died took
 * every task in it down, and each needs its own transition.
 */
export function synthesizeFailure(
  taskIds: readonly string[],
  message: string,
  options: { retryable?: boolean } = {},
): TaskResult[] {
  return taskIds.map((taskId) => ({
    baya: PROTOCOL_VERSION,
    kind: 'task_result' as const,
    task_id: taskId,
    status: 'failed' as const,
    summary: '',
    output: '',
    notes: [],
    question: null,
    error: { message, retryable: options.retryable ?? true },
    artifacts: [],
    files_changed: [],
  }));
}

/**
 * Line the batch's results up with the tasks that were asked for, **by
 * `task_id`** and never by position.
 *
 * Position would be the forgiving read, and that is exactly the problem: a
 * model that returns its results out of order would have one task's work
 * filed under another task's id, and downstream tasks read those results as
 * fact. A task the model did not name is reported as failed, which is
 * recoverable; a task credited with someone else's output is not.
 */
function alignToTasks(taskIds: readonly string[], results: TaskResult[]): TaskResult[] {
  const byId = new Map(results.map((result) => [result.task_id, result]));
  return taskIds.map(
    (taskId) =>
      byId.get(taskId) ??
      (synthesizeFailure(
        [taskId],
        `the provider returned ${String(results.length)} result(s) but named none of them "${taskId}"`,
      )[0] as TaskResult),
  );
}

/**
 * Parse a candidate payload against the contract for this process.
 *
 * For a single task the id is **normalized** rather than matched — a provider
 * echoing back the wrong id must not be able to misroute a result, and with
 * one task there is only one place it can go. For a group that same leniency
 * would be misrouting, so `alignToTasks` matches instead.
 */
export function parseResultJson(
  taskIds: readonly string[],
  raw: string,
): TaskResult[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stripAnsi(raw));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;

  const only = taskIds.length === 1 ? taskIds[0] : null;
  if (only !== undefined && only !== null) {
    const candidate = { ...(value as Record<string, unknown>), task_id: only };
    const parsed = TaskResultSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : null;
  }

  const batch = TaskResultBatchSchema.safeParse(value);
  if (!batch.success) return null;
  return alignToTasks(taskIds, batch.data.results);
}

/**
 * Rung 3 support: the body of the **last** fenced code block that looks like
 * JSON. Last, not first, because a model often shows a draft then a corrected
 * final block, and the final one is the answer. The info string is optional —
 * ` ```json ` and a bare ` ``` ` wrapping `{ … }` both count; prose fences do
 * not.
 */
export function lastJsonFence(text: string): string | null {
  const clean = stripAnsi(text);
  const fence = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
  let last: string | null = null;
  for (const match of clean.matchAll(fence)) {
    const lang = (match[1] ?? '').toLowerCase();
    const body = (match[2] ?? '').trim();
    if (lang !== '' && lang !== 'json') continue;
    if (!body.startsWith('{') || !body.endsWith('}')) continue;
    last = body;
  }
  return last;
}

/**
 * Rungs 2–3 of the degradation ladder (protocol.md §4), for the providers that
 * enforce no schema (`opencode`, `copilot`). Given the final assistant message:
 *
 *   2. **Verbatim** — the whole message parses as the conforming document.
 *   3. **Fenced** — the last ` ```json ` block does.
 *
 * Returns `null` when neither rung lands; the caller falls to rung 5
 * (`synthesizeFailure`). Rung 4, the repair round-trip, is `later` — v1 skips it.
 */
export function extractResultFromText(
  taskIds: readonly string[],
  text: string,
): ParsedResults | null {
  const trimmed = stripAnsi(text).trim();
  if (trimmed === '') return null;

  const verbatim = parseResultJson(taskIds, trimmed);
  if (verbatim) return { results: verbatim, rung: 'verbatim' };

  const fenced = lastJsonFence(trimmed);
  if (fenced !== null) {
    const parsed = parseResultJson(taskIds, fenced);
    if (parsed) return { results: parsed, rung: 'fenced' };
  }

  return null;
}
