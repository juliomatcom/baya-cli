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
    const lang = (match[1] ?? "").toLowerCase();
    const body = (match[2] ?? "").trim();
    if (lang !== "" && lang !== "json") continue;
    if (!body.startsWith("{") || !body.endsWith("}")) continue;
    last = body;
  }
  return last;
}

/**
 * Rungs 2–3 of the degradation ladder (protocol.md §4), for the providers that
 * enforce no schema (`opencode`, `copilot`). Given the final assistant message:
 *
 *   2. **Verbatim** — the whole message parses as a conforming `task_result`.
 *   3. **Fenced** — the last ` ```json ` block does.
 *
 * Returns `null` when neither rung lands; the caller falls to rung 5
 * (`synthesizeFailure`). Rung 4, the repair round-trip, is `later` — v1 skips it.
 */
export function extractResultFromText(taskId: string, text: string): ParsedResult | null {
  const trimmed = stripAnsi(text).trim();
  if (trimmed === "") return null;

  const verbatim = parseResultJson(taskId, trimmed);
  if (verbatim) return { result: verbatim, rung: "verbatim" };

  const fenced = lastJsonFence(trimmed);
  if (fenced !== null) {
    const parsed = parseResultJson(taskId, fenced);
    if (parsed) return { result: parsed, rung: "fenced" };
  }

  return null;
}
