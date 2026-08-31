import { Chalk } from 'chalk';

/**
 * The sole chalk importer (conventions.md #11, cli.md "Color"). Everywhere
 * else uses these semantic tokens — a bare `chalk.green` outside this file
 * is a lint error (`no-restricted-imports` in eslint.config.js).
 */
export type StatusToken =
  'ok' | 'fail' | 'skip' | 'park' | 'run' | 'pending' | 'warn' | 'action' | 'note';

/** Meaning is never carried by color alone — every status token pairs with a glyph. */
export const GLYPHS: Record<StatusToken, string> = {
  ok: '✓',
  fail: '✗',
  skip: '⊘',
  park: '⏸',
  run: '▸',
  pending: '·',
  warn: '!',
  action: '⚑',
  note: '·',
};

export type ColorMode = 'auto' | 'always' | 'never';

function resolveLevel(mode: ColorMode): 0 | 1 | 2 | 3 {
  if (mode === 'never') return 0;
  if (mode === 'always') return 1;
  // "auto": chalk's own detection already honors NO_COLOR, FORCE_COLOR, and TTY.
  return new Chalk().level;
}

export interface Theme {
  ok: (text: string) => string;
  fail: (text: string) => string;
  skip: (text: string) => string;
  park: (text: string) => string;
  run: (text: string) => string;
  pending: (text: string) => string;
  taskId: (text: string) => string;
  provider: (text: string) => string;
  warn: (text: string) => string;
  action: (text: string) => string;
  note: (text: string) => string;
  glyphs: Record<StatusToken, string>;
  /** The glyph for `token`, colored with that token's style — the compact "✓ " marker. */
  status: (token: StatusToken) => string;
  /**
   * A filled block, for the one line in a run that must not be scrolled past.
   * Deliberately rare: it is the loudest thing this theme can do, so a second
   * caller would cost the first its emphasis.
   *
   * The foreground is always set explicitly. A background paired with the
   * terminal's default foreground is the classic way to produce unreadable
   * output on somebody else's color scheme.
   */
  badge: (token: 'ok' | 'warn' | 'fail', text: string) => string;
  readonly level: 0 | 1 | 2 | 3;
}

export function createTheme(mode: ColorMode = 'auto'): Theme {
  const level = resolveLevel(mode);
  const c = new Chalk({ level });

  const ok = (text: string): string => c.green(text);
  const fail = (text: string): string => c.red(text);
  const skip = (text: string): string => c.dim(text);
  const park = (text: string): string => c.yellow(text);
  const run = (text: string): string => c.cyan(text);
  const pending = (text: string): string => c.dim(text);
  const taskId = (text: string): string => c.bold(text);
  const provider = (text: string): string => c.magenta(text);
  const warn = (text: string): string => c.yellow(text);
  const action = (text: string): string => c.bold.yellow(text);
  const note = (text: string): string => c.dim(text);

  const badge = (token: 'ok' | 'warn' | 'fail', text: string): string =>
    token === 'ok'
      ? c.bgGreen.black(text)
      : token === 'warn'
        ? c.bgYellow.black(text)
        : c.bgRed.white(text);

  const byToken: Record<StatusToken, (text: string) => string> = {
    ok,
    fail,
    skip,
    park,
    run,
    pending,
    warn,
    action,
    note,
  };

  return {
    ok,
    fail,
    skip,
    park,
    run,
    pending,
    taskId,
    provider,
    warn,
    action,
    note,
    glyphs: { ...GLYPHS },
    status: (token) => byToken[token](GLYPHS[token]),
    badge,
    level,
  };
}

/**
 * Forced ANSI-free instance for machine-readable paths — `--json`,
 * `report.json`, `result.json`, `events.jsonl`, `stdout.log` (cli.md, forced
 * rather than TTY-inferred so a piped `--json` run never emits ANSI).
 */
export const machineTheme: Theme = createTheme('never');

/**
 * Default theme, auto-detected (NO_COLOR/FORCE_COLOR/TTY via chalk). Command
 * routing (M1.9) builds a theme from `--color`/`--no-color` per invocation;
 * this singleton serves modules that render before that's wired up.
 */
export const theme: Theme = createTheme('auto');
