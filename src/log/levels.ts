export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export function isAtLeast(level: LogLevel, threshold: LogLevel): boolean {
  return RANK[level] >= RANK[threshold];
}

export interface LogLevelFlags {
  logLevel?: LogLevel;
  verbose?: boolean;
  quiet?: boolean;
}

/**
 * stderr filter precedence (logging.md): `--log-level` wins outright; else
 * `--verbose` => debug, `--quiet` => warn; else the `info` default.
 */
export function resolveStderrLevel(flags: LogLevelFlags): LogLevel {
  if (flags.logLevel) return flags.logLevel;
  if (flags.verbose) return 'debug';
  if (flags.quiet) return 'warn';
  return 'info';
}
