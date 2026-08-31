import { select } from "@inquirer/prompts";
import type { RunRow } from "../executor/index.js";

/**
 * The `baya resume` run picker (recovery.md §Resume).
 *
 * **Never guesses.** Several runs can sit unfinished at once, and resuming the
 * wrong one spends real credits, so "most recent" is not an acceptable default.
 * With no terminal to ask at, this refuses rather than picking.
 *
 * Choice building is pure and carries the tests; the prompt call is a thin
 * shell around it (conventions.md #13 — no test may open a prompt).
 */
export interface RunChoice {
  value: string;
  name: string;
  description: string;
}

export function buildRunChoices(rows: readonly RunRow[]): RunChoice[] {
  return rows.map((row) => {
    const totals = row.totals;
    const left = totals
      ? totals.failed + totals.skipped + totals.parked + totals.pending + totals.running
      : null;
    return {
      value: row.run_id,
      name: `${row.run_id}  ${row.source_path ?? "—"}  ${row.status}  ${left === null ? "unknown" : `${left} left`}`,
      description: `${totals?.succeeded ?? 0} succeeded · started ${row.started_at ?? "—"}`,
    };
  });
}

export type PickRunOutcome =
  { decision: "picked"; runId: string } | { decision: "blocked"; message: string };

export async function pickRun(options: {
  rows: readonly RunRow[];
  stdinIsTty: boolean;
  beforePrompt?: () => void;
}): Promise<PickRunOutcome> {
  if (options.rows.length === 0) {
    return { decision: "blocked", message: "no resumable runs — `baya runs` lists them" };
  }
  if (!options.stdinIsTty) {
    return {
      decision: "blocked",
      message:
        "stdin is not a TTY, so there is nobody to pick a run: pass a run id (`baya runs` lists them).",
    };
  }
  options.beforePrompt?.();
  const runId = await select({
    message: "Resume which run?",
    choices: buildRunChoices(options.rows),
  });
  return { decision: "picked", runId };
}
