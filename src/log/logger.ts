import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { stripAnsi } from "./ansi.js";
import { type LogLevel, isAtLeast } from "./levels.js";
import { elidePrompt, redactDeep } from "./redact.js";

export interface LogFields {
  [key: string]: unknown;
}

/**
 * Events that reach the terminal whatever the level filter says.
 *
 * Verbosity filters **chatter, never outcomes**: `--quiet` asks Baya to stop
 * narrating the work, not to stop reporting it. The other three outcomes
 * already survived on level alone — `task.failed` is `error`, `task.parked`
 * and `task.skipped` are `warn` — so `--quiet` showed every bad outcome and no
 * good one, which is exactly backwards for the common case.
 *
 * `task.note` is deliberately **not** here. A note is attached to an outcome,
 * and the end-of-run **Flagged** section reprints every one of them at any
 * level, so nothing is lost by letting the inline copy be filtered.
 *
 * For genuinely no stderr: `--json` (which nulls it) or a shell redirect.
 */
export const ALWAYS_DISPLAYED: ReadonlySet<string> = new Set(["task.succeeded"]);

export interface LoggerOptions {
  runId: string;
  /** Path to the JSONL trace sink (`.baya/runs/<runId>/baya.jsonl`). Always receives every level. */
  traceFile: string;
  /** stderr filter level; resolve via `resolveStderrLevel`. Defaults to `info`. */
  stderrLevel?: LogLevel;
  /** Injectable for tests; defaults to `process.stderr`. Never `process.stdout` (logging.md). */
  stderrStream?: NodeJS.WritableStream;
  /**
   * Composes the terminal sentence from structured fields (logging.md rule 4).
   * Return `null` to keep a line out of the display — it is still written to
   * the file in full, because verbosity filters the *display*, never the record.
   * Defaults to a flat `ts level event k=v` rendering.
   */
  render?: (line: LogLine) => string | null;
}

export interface Logger {
  trace(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function deepStripAnsi<T>(value: T): T {
  if (typeof value === "string") {
    return stripAnsi(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => deepStripAnsi(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepStripAnsi(val);
    }
    return out as T;
  }
  return value;
}

function sanitize(fields: LogFields): LogFields {
  const elided = elidePrompt(fields);
  const stripped = deepStripAnsi(elided);
  return redactDeep(stripped);
}

export interface LogLine extends LogFields {
  ts: string;
  level: LogLevel;
  event: string;
  run_id: string;
}

function renderStderrLine(line: LogLine): string {
  const { ts, level, event, run_id: _runId, ...rest } = line;
  const kv = Object.entries(rest)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(" ");
  return `${ts} ${level.padEnd(5)} ${event}${kv ? ` ${kv}` : ""}\n`;
}

/**
 * Two sinks, different volumes (logging.md): the file gets everything, stderr
 * gets a level-filtered narrative. Redaction and ANSI-stripping happen once,
 * here, so no call site can leak a secret or a raw escape sequence.
 */
export function createLogger(options: LoggerOptions): Logger {
  const stderrLevel = options.stderrLevel ?? "info";
  const stderrStream = options.stderrStream ?? process.stderr;
  const render = options.render ?? renderStderrLine;
  mkdirSync(dirname(options.traceFile), { recursive: true });

  function write(level: LogLevel, event: string, fields: LogFields = {}): void {
    const clean = sanitize(fields);
    const line: LogLine = {
      ts: new Date().toISOString(),
      level,
      event,
      run_id: options.runId,
      ...clean,
    };

    appendFileSync(options.traceFile, `${JSON.stringify(line)}\n`);

    if (isAtLeast(level, stderrLevel) || ALWAYS_DISPLAYED.has(event)) {
      const rendered = render(line);
      if (rendered !== null) stderrStream.write(rendered);
    }
  }

  return {
    trace: (event, fields) => write("trace", event, fields),
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
