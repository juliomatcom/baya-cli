import { z } from 'zod';

/**
 * `baya runs` (cli.md §Commands) — the resumable-run listing. Row construction
 * is pure: it takes a run id and the raw text of that run's `state.json` and
 * returns one row, so a half-written or corrupt checkpoint becomes a `damaged`
 * row instead of crashing the listing (recovery.md §Guards: a malformed state
 * file is reported, never silently skipped or acted on).
 */

export const RESUMABLE_STATUSES = ['running', 'paused', 'failed', 'interrupted'] as const;

const KNOWN_STATUSES = new Set<string>([...RESUMABLE_STATUSES, 'completed']);

export type RunRowStatus = (typeof RESUMABLE_STATUSES)[number] | 'completed' | 'damaged';

export interface RunRowTotals {
  succeeded: number;
  failed: number;
  skipped: number;
  parked: number;
  pending: number;
  running: number;
}

export interface RunRow {
  run_id: string;
  source_path: string | null;
  started_at: string | null;
  status: RunRowStatus;
  totals: RunRowTotals | null;
  /** `state.json` was truncated, unparseable, or not a recognizable run state. */
  damaged: boolean;
  /** Whether `baya resume` has unfinished work to re-run. Always false when damaged. */
  resumable: boolean;
}

const StoredRun = z
  .object({
    run_id: z.string().optional(),
    status: z.string().optional(),
    started_at: z.string().optional(),
    source: z.object({ path: z.string() }).partial().passthrough().optional(),
    totals: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const TOTAL_KEYS = [
  'succeeded',
  'failed',
  'skipped',
  'parked',
  'pending',
  'running',
] as const;

export function buildRunRow(runId: string, stateJson: string): RunRow {
  const damaged: RunRow = {
    run_id: runId,
    source_path: null,
    started_at: null,
    status: 'damaged',
    totals: null,
    damaged: true,
    resumable: false,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson);
  } catch {
    return damaged;
  }

  const result = StoredRun.safeParse(parsed);
  if (!result.success) return damaged;

  const stored = result.data;
  if (stored.status === undefined || !KNOWN_STATUSES.has(stored.status)) return damaged;
  const status = stored.status as RunRowStatus;

  return {
    run_id: stored.run_id && stored.run_id.length > 0 ? stored.run_id : runId,
    source_path: stored.source?.path ?? null,
    started_at: stored.started_at ?? null,
    status,
    totals: toTotals(stored.totals),
    damaged: false,
    resumable: (RESUMABLE_STATUSES as readonly string[]).includes(status),
  };
}

/** Damaged rows and resumable runs, newest first. Run ids sort by start time. */
export function selectRuns(rows: readonly RunRow[]): RunRow[] {
  return rows
    .filter((row) => row.damaged || row.resumable)
    .sort((a, b) => (a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0));
}

function toTotals(raw: Record<string, unknown> | undefined): RunRowTotals | null {
  if (raw === undefined) return null;
  const totals = {} as RunRowTotals;
  for (const key of TOTAL_KEYS) {
    totals[key] = typeof raw[key] === 'number' ? (raw[key] as number) : 0;
  }
  return totals;
}
