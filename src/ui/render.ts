import type { LogLine } from "../log/index.js";
import type { Theme } from "./theme.js";
import { DEFAULT_WIDTH, firstLine, formatDuration, wrap } from "./text.js";

/**
 * Composes the terminal narrative from structured log fields (logging.md rule
 * 4: `{"event":"task.failed","kind":"quota"}`, never a pre-baked sentence).
 *
 * Returning `null` hides a line from the display only — the JSONL sink already
 * has it. Verbosity filters what you see, never what is recorded.
 */
export interface RendererOptions {
  theme: Theme;
  /** `--quiet`: warnings, failures, notes, and the final report only. */
  quiet?: boolean;
  width?: number;
}

const INDENT = "  ";
const PREFIX_WIDTH = 12;

function str(line: LogLine, key: string): string {
  const value = line[key];
  return typeof value === "string" ? value : "";
}

function num(line: LogLine, key: string): number | null {
  const value = line[key];
  return typeof value === "number" ? value : null;
}

export function createEventRenderer(
  options: RendererOptions,
): (line: LogLine) => string | null {
  const { theme } = options;
  const width = options.width ?? DEFAULT_WIDTH;
  const quiet = options.quiet === true;

  /** Attribution is mandatory: unprefixed output from parallel tasks is unreadable. */
  const prefixed = (
    taskId: string,
    body: string,
    style: (t: string) => string,
  ): string => {
    const label = theme.taskId(taskId.padEnd(PREFIX_WIDTH).slice(0, PREFIX_WIDTH));
    return wrap(body, width - PREFIX_WIDTH - 5)
      .map((row) => `${INDENT}${label} ${theme.pending("│")} ${style(row)}`)
      .join("\n");
  };

  /** Notes wrap under the task they belong to, so the association survives. */
  const noteLine = (glyph: string, taskId: string, message: string): string => {
    const rows = wrap(message, width - PREFIX_WIDTH - 8);
    const head = `${INDENT}${INDENT}${glyph} ${theme.taskId(taskId.padEnd(PREFIX_WIDTH))} ${rows[0] ?? ""}`;
    const rest = rows
      .slice(1)
      .map((row) => `${INDENT}${INDENT}  ${" ".repeat(PREFIX_WIDTH)} ${row}`);
    return [head, ...rest].join("\n");
  };

  return (line: LogLine): string | null => {
    const taskId = str(line, "task_id");
    const provider = str(line, "provider");
    const duration = num(line, "duration_ms");

    switch (line.event) {
      case "provider.text":
        return quiet ? null : prefixed(taskId, str(line, "text"), (t) => t);

      case "provider.tool": {
        if (quiet) return null;
        const input = str(line, "input");
        const name = str(line, "name");
        return prefixed(taskId, `⚒ ${name}${input ? ` ${input}` : ""}`, theme.note);
      }

      case "provider.stderr":
        return quiet ? null : prefixed(taskId, str(line, "text"), theme.note);

      case "task.succeeded": {
        if (quiet) return null;
        const summary = firstLine(str(line, "summary"));
        return `${INDENT}${theme.status("ok")} ${theme.taskId(taskId.padEnd(PREFIX_WIDTH))} ${theme.provider(provider.padEnd(9))} ${(duration === null ? "" : formatDuration(duration)).padStart(7)}  ${summary}`;
      }

      case "task.failed":
        return `${INDENT}${theme.status("fail")} ${theme.taskId(taskId.padEnd(PREFIX_WIDTH))} ${theme.provider(provider.padEnd(9))} ${(duration === null ? "" : formatDuration(duration)).padStart(7)}  ${theme.fail(firstLine(str(line, "message")))}`;

      case "task.parked":
        return `${INDENT}${theme.status("park")} ${theme.taskId(taskId.padEnd(PREFIX_WIDTH))} ${theme.provider(provider.padEnd(9))} ${theme.park(firstLine(str(line, "question")))}`;

      case "task.skipped":
        return `${INDENT}${theme.status("skip")} ${theme.taskId(taskId.padEnd(PREFIX_WIDTH))} ${theme.skip(`depends on ${str(line, "blocked_by")}`)}`;

      case "task.note": {
        const severity = str(line, "severity");
        const message = str(line, "message");
        // `warn` and `action_required` print the moment the task finishes — a
        // warning 3 minutes into a 20-minute run must not wait for the end.
        if (severity === "warn") return noteLine(theme.status("warn"), taskId, message);
        if (severity === "action_required") {
          return noteLine(theme.status("action"), taskId, message);
        }
        return null; // `info` is held for the end-of-run report.
      }

      case "provider.missing":
        return `${INDENT}${theme.status("fail")} provider ${theme.provider(str(line, "provider"))} not found — run \`baya doctor\``;

      case "config.default.inferred":
        return `${INDENT}${theme.status("warn")} ${theme.warn(str(line, "message"))}`;

      case "plan.fallback.linear":
        return `${INDENT}${theme.status("warn")} ${theme.warn(`planner produced no valid plan (${str(line, "reason")}); running tasks in document order`)}`;

      case "plan.repair.attempted":
        return `${INDENT}${theme.status("warn")} ${theme.warn("plan rejected; asking the planner to repair it")}`;

      case "lock.reclaimed":
        return `${INDENT}${theme.status("warn")} ${theme.warn("reclaimed a stale lock from a crashed run")}`;

      default:
        // Everything else — session ids, unknown events, checkpoints — is noise
        // at `info`. It reaches the terminal under --verbose via the fallback.
        return line.level === "debug" || line.level === "trace"
          ? `${INDENT}${theme.note(`${line.event} ${JSON.stringify(stripped(line))}`)}`
          : null;
    }
  };
}

function stripped(line: LogLine): Record<string, unknown> {
  const { ts: _ts, level: _level, event: _event, run_id: _runId, ...rest } = line;
  return rest;
}
