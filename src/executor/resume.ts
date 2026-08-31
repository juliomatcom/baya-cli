import type { RunState, TaskStateEntry } from './state.js';

/**
 * What a resume re-runs (recovery.md §Resume). Pure: it reads a checkpoint and
 * answers which tasks are unfinished, so the decision is testable without a
 * run directory.
 *
 * A `succeeded` task is never re-run and never re-planned. Not redoing work
 * that was already paid for is the whole point of the checkpointing; every
 * other state — `failed`, `skipped`, `parked`, and the `running`/`pending`
 * tasks a crash or an interrupt left behind — is unfinished work.
 */
export interface ResumeTargets {
  /** Unfinished tasks, in manifest order. */
  rerun: string[];
  /** Tasks already `succeeded`. Their outputs stay on disk as upstream context. */
  keep: string[];
}

export function resumeTargets(
  state: RunState,
  taskIds: readonly string[],
): ResumeTargets {
  const rerun: string[] = [];
  const keep: string[] = [];
  for (const id of taskIds) {
    if (state.tasks[id]?.state === 'succeeded') keep.push(id);
    else rerun.push(id);
  }
  return { rerun, keep };
}

/**
 * The patch that puts an unfinished task back on the runway.
 *
 * `attempts` and the recorded usage are deliberately left alone: they are the
 * run's history, and the next attempt adds to them rather than replacing them
 * — a failed attempt still cost money.
 */
export function resumeReset(): Partial<TaskStateEntry> {
  return {
    state: 'pending',
    failure: null,
    blocked_by: null,
    pid: null,
    started_at: null,
    ended_at: null,
    duration_ms: null,
    exit_code: null,
    group_id: null,
  };
}
