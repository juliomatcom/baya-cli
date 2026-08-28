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

/** The completion line's rule: first line only, capped (cli.md §Run output). */
export function firstLine(text: string, max = 120): string {
  const line = (
    text.split("\n").find((candidate) => candidate.trim() !== "") ?? ""
  ).trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
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
