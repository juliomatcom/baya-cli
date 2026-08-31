import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRunRow, runPaths, selectRuns, type RunRow } from '../executor/index.js';
import type { Theme } from '../ui/theme.js';
import type { CliIo } from './run.js';

/**
 * `baya runs` (cli.md, recovery.md) — the resumable runs a `baya resume` can
 * pick from, newest first. Reads every run's `state.json` under `.baya/runs`; a
 * truncated or unparseable one lists as `damaged` rather than taking the whole
 * listing down. `--json` emits the rows the same way `baya models` emits the
 * catalog: one clean document on stdout, no banner.
 */
export interface RunsCommandOptions {
  cwd: string;
  io: CliIo;
  theme: Theme;
  json: boolean;
}

/**
 * Every resumable run under `.baya/runs`, newest first. Shared with `baya
 * resume`, whose picker offers exactly the rows this listing shows.
 */
export function readRunRows(cwd: string): RunRow[] {
  const runsDir = runPaths(cwd, '-').runsDir;

  let dirs: string[] = [];
  try {
    dirs = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    dirs = [];
  }

  return selectRuns(
    dirs.flatMap((id) => {
      let stateJson: string;
      try {
        stateJson = readFileSync(join(runsDir, id, 'state.json'), 'utf8');
      } catch {
        return [];
      }
      return [buildRunRow(id, stateJson)];
    }),
  );
}

export function runsCommand(options: RunsCommandOptions): number {
  const { io, theme } = options;
  const rows = readRunRows(options.cwd);

  if (options.json) {
    io.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  const lines = ['', `  ${theme.taskId('Runs')}`];
  if (rows.length === 0) {
    lines.push('', `  ${theme.note('no resumable runs')}`, '');
    io.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  const idWidth = Math.max(...rows.map((row) => row.run_id.length));
  const srcWidth = Math.max(...rows.map((row) => (row.source_path ?? '—').length));
  for (const row of rows) {
    lines.push(
      `    ${row.run_id.padEnd(idWidth)}  ${(row.source_path ?? '—').padEnd(srcWidth)}  ${started(row)}  ${status(row, theme)}  ${theme.note(totals(row))}`,
    );
  }
  lines.push('', `  ${theme.note('baya resume <id>')}   re-run one`, '');
  io.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** ISO to minutes — the second and the timezone marker add nothing to a glance. */
function started(row: RunRow): string {
  return row.started_at ? row.started_at.slice(0, 16).replace('T', ' ') : '—'.padEnd(16);
}

function status(row: RunRow, theme: Theme): string {
  if (row.damaged) return theme.warn('damaged');
  if (row.status === 'failed') return theme.fail('failed');
  if (row.status === 'interrupted') return theme.warn('interrupted');
  if (row.status === 'paused') return theme.park('paused');
  return theme.note(row.status);
}

function totals(row: RunRow): string {
  if (row.totals === null) return '—';
  const parts: string[] = [`${row.totals.succeeded} ok`];
  if (row.totals.failed > 0) parts.push(`${row.totals.failed} failed`);
  if (row.totals.skipped > 0) parts.push(`${row.totals.skipped} skipped`);
  if (row.totals.parked > 0) parts.push(`${row.totals.parked} parked`);
  if (row.totals.pending > 0) parts.push(`${row.totals.pending} pending`);
  return parts.join(' · ');
}
