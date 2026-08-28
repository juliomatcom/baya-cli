import ora, { type Ora } from "ora";

/**
 * The single owner of the spinner line (conventions.md #16b). Every persistent
 * terminal write goes through `write()`: ora repaints one line in place, so a
 * bare `process.stderr.write` while it spins garbles both.
 *
 * The spinner is stderr-only, always — stdout carries the `--json` report and
 * nothing else, so `baya … --json | jq` stays valid (cli.md §Color rule 2).
 */
const SHOW_CURSOR = "\u001B[?25h";

export interface ProgressOptions {
  stream?: NodeJS.WriteStream | NodeJS.WritableStream;
  /** `--no-progress`. */
  disabled?: boolean;
  /** `--json`: a spinner frame in a pipe is noise. */
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Register the `exit` guard that restores the cursor. Off in tests. */
  installExitGuard?: boolean;
}

export interface Progress {
  readonly enabled: boolean;
  start(text: string): void;
  update(text: string): void;
  /** Clear, write a line that must persist, re-render. Never bypass this. */
  write(line: string): void;
  /** Stop spinning but keep the instance usable (e.g. before a prompt). */
  stop(): void;
  /** Stop and restore the cursor. Idempotent; safe from a signal handler. */
  dispose(): void;
}

function isTty(stream: NodeJS.WritableStream): boolean {
  return (stream as NodeJS.WriteStream).isTTY === true;
}

/**
 * ora hides the cursor, and a hard exit without cleanup leaves the user's
 * terminal with no visible cursor long after Baya is gone. Exported so signal
 * handlers can call it directly rather than reconstructing the escape.
 */
export function restoreCursor(stream: NodeJS.WritableStream = process.stderr): void {
  if (isTty(stream)) stream.write(SHOW_CURSOR);
}

export function createProgress(options: ProgressOptions = {}): Progress {
  const stream = options.stream ?? process.stderr;
  const env = options.env ?? process.env;

  const enabled =
    options.disabled !== true &&
    options.json !== true &&
    !(env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") &&
    isTty(stream);

  let spinner: Ora | null = null;
  let disposed = false;

  const guard = (): void => {
    if (disposed) return;
    disposed = true;
    spinner?.stop();
    restoreCursor(stream);
  };
  if (enabled && options.installExitGuard !== false) {
    process.once("exit", guard);
  }

  return {
    enabled,

    start(text: string): void {
      if (!enabled || disposed) return;
      spinner ??= ora({ stream: stream as NodeJS.WriteStream, text });
      spinner.text = text;
      spinner.start();
    },

    update(text: string): void {
      if (!enabled || disposed || !spinner) return;
      spinner.text = text;
    },

    write(line: string): void {
      const payload = line.endsWith("\n") ? line : `${line}\n`;
      if (!enabled || disposed || !spinner?.isSpinning) {
        stream.write(payload);
        return;
      }
      spinner.clear();
      stream.write(payload);
      spinner.render();
    },

    stop(): void {
      spinner?.stop();
    },

    dispose(): void {
      if (disposed) {
        // Still restore: a second dispose from a signal handler after a normal
        // stop must not leave the cursor hidden.
        restoreCursor(stream);
        return;
      }
      disposed = true;
      spinner?.stop();
      restoreCursor(stream);
      process.removeListener("exit", guard);
    },
  };
}
