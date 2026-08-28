import {
  PROTOCOL_VERSION,
  TaskResultSchema,
  type TaskResult,
} from "../manifest/index.js";
import { stripAnsi } from "../log/index.js";

/** Which rung of the degradation ladder (protocol.md §4) produced a result. */
export type ResultRung = "native" | "verbatim" | "fenced" | "synthesized";

export interface ParsedResult {
  result: TaskResult;
  rung: ResultRung;
}

/**
 * Rung 5. Never throws, never returns null: a provider that produced nothing
 * usable still has to become a `task_result`, or the scheduler has no state
 * transition to make.
 */
export function synthesizeFailure(
  taskId: string,
  message: string,
  options: { retryable?: boolean } = {},
): TaskResult {
  return {
    baya: PROTOCOL_VERSION,
    kind: "task_result",
    task_id: taskId,
    status: "failed",
    summary: "",
    output: "",
    notes: [],
    question: null,
    error: { message, retryable: options.retryable ?? true },
    artifacts: [],
    files_changed: [],
  };
}

/**
 * Parse a candidate payload against the schema, normalizing the task id — a
 * provider echoing back the wrong id must not be able to misroute a result.
 */
export function parseResultJson(taskId: string, raw: string): TaskResult | null {
  let value: unknown;
  try {
    value = JSON.parse(stripAnsi(raw));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const candidate = { ...(value as Record<string, unknown>), task_id: taskId };
  const parsed = TaskResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
