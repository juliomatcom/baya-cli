import type { Theme } from "./theme.js";

/**
 * The wordmark printed once at the top of every human-facing invocation.
 *
 * Written to **stderr** so it never contaminates a piped `--json` payload or
 * `$(baya config path)`, and suppressed outright for the machine/quiet modes
 * (`--json`, `--version`, `--quiet`) — see `shouldShowBanner` in `cli/index.ts`.
 */
const LINES = [
  "▗▄▄▖  ▗▄▖▗▖  ▗▖▗▄▖      ▗▄▄▖▗▖   ▗▄▄▄▖",
  "▐▌ ▐▌▐▌ ▐▌▝▚▞▘▐▌ ▐▌    ▐▌   ▐▌     █",
  "▐▛▀▚▖▐▛▀▜▌ ▐▌ ▐▛▀▜▌    ▐▌   ▐▌     █",
  "▐▙▄▞▘▐▌ ▐▌ ▐▌ ▐▌ ▐▌    ▝▚▄▄▖▐▙▄▄▖▗▄█▄▖",
];

export function renderBanner(theme: Theme): string {
  return `${LINES.map((line) => theme.run(line)).join("\n")}\n\n`;
}
