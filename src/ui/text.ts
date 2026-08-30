/** Terminal text helpers. Pure — no chalk, no stream, no width detection. */

export const DEFAULT_WIDTH = 100;

/** Word-wrap, preserving existing newlines. Never splits a word that fits. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === "") {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line !== "") out.push(line);
  }
  return out;
}

/**
 * The completion line's rule: the first non-empty line, in full (cli.md §Run
 * output). Not truncated — a status line is never cut with an ellipsis; the
 * terminal soft-wraps a long one and the end-of-run report has the rest.
 */
export function firstLine(text: string): string {
  return (text.split("\n").find((candidate) => candidate.trim() !== "") ?? "").trim();
}

/** Single-quote an argv token for display when it holds anything shell-special. */
function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9,._+:@%/=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Render a spawn argv as a copy-pasteable command line, with the bulky
 * arguments (the prompt, an inlined JSON schema) collapsed to a marker so the
 * flags stay readable. `promptBytes` — from the elided `task.spawned` line —
 * lets the exact prompt argument be labelled `<prompt>` rather than `<N chars>`.
 */
export function formatCommand(
  argv: readonly string[],
  opts: { promptBytes?: number } = {},
): string {
  return argv
    .map((arg) => {
      // Collapse only the genuinely bulky arguments — a prose prompt (always
      // has whitespace) or an inlined JSON blob (very long). A long but
      // whitespace-free token is a path/URL/id and stays readable in full.
      const bulky = /\s/.test(arg) ? arg.length > 100 : arg.length > 400;
      if (!bulky) return shellQuote(arg);
      const bytes = Buffer.byteLength(arg, "utf8");
      return opts.promptBytes !== undefined && bytes === opts.promptBytes
        ? "<prompt>"
        : `<${arg.length} chars>`;
    })
    .join(" ");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
}

/**
 * Whole seconds, for a line that repaints once a second: `9s` · `59s` ·
 * `1m04s`. `formatDuration`'s tenths would flicker on a live spinner without
 * telling anyone anything.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Compact token count: 942 · 3.1k · 128k · 1.4M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
