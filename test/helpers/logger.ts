import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type LogLine, type Logger } from "../../src/log/index.js";

export interface CapturedLogger {
  logger: Logger;
  lines: LogLine[];
  events: string[];
  traceFile: string;
}

/** A real logger with a throwaway sink, plus the structured lines it emitted. */
export function captureLogger(
  stderrLevel: "trace" | "debug" | "info" = "trace",
): CapturedLogger {
  const dir = mkdtempSync(join(tmpdir(), "baya-log-"));
  const traceFile = join(dir, "baya.jsonl");
  const lines: LogLine[] = [];
  const logger = createLogger({
    runId: "test-run",
    traceFile,
    stderrLevel,
    stderrStream: { write: () => true } as unknown as NodeJS.WritableStream,
    render: (line) => {
      lines.push(line);
      return null;
    },
  });
  return {
    logger,
    lines,
    get events() {
      return lines.map((line) => String(line.event));
    },
    traceFile,
  };
}
