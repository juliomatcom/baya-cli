import { existsSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * A `$PATH` holding node and nothing else.
 *
 * ⚠️ The obvious value — `dirname(process.execPath)`, "the directory node
 * lives in" — is under nvm (and any npm prefix sharing it) also where
 * `npm i -g` puts its binaries. A test asserting that no provider resolves
 * therefore found whichever provider CLI the developer happened to have
 * installed.
 *
 * Created once per worker and shared: one symlink, read-only to every test.
 */
export const NODE_ONLY_BIN = ((): string => {
  const dir = mkdtempSync(join(tmpdir(), 'baya-node-bin-'));
  const link = join(dir, 'node');
  if (!existsSync(link)) symlinkSync(process.execPath, link);
  return dir;
})();

/** A `$HOME` that does not exist, so nothing under it can ever resolve. */
export const NO_HOME = join(tmpdir(), 'baya-absent-home');

/**
 * The environment every test runs the CLI under.
 *
 * Binary resolution reads the machine through exactly two variables — `$PATH`
 * and `$BAYA_KNOWN_LOCATIONS` — and this seals both. Tests must not build an
 * env literal by hand: `{ PATH: '/nonexistent', HOME: home }` looks sealed and
 * is not, because the known-location defaults still reach the active nvm bin,
 * `/opt/homebrew/bin` and `/usr/local/bin`. That is what made four tests fail
 * on a laptop with `copilot` installed and pass in CI.
 *
 * Pass `BAYA_KNOWN_LOCATIONS` explicitly to test known-location resolution —
 * scoped to a temp directory the test owns, never to a real one.
 */
export function sealedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: NODE_ONLY_BIN,
    HOME: NO_HOME,
    BAYA_KNOWN_LOCATIONS: '',
    NO_COLOR: '1',
    ...overrides,
  };
}

/** The three provider directories Baya looks for under a `$HOME`. */
export function homeLocations(home: string): string {
  return [
    join(home, '.local', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.claude', 'local'),
  ].join(delimiter);
}
