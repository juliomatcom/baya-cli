/**
 * Task grouping (execution.md §Grouping). Pure: no I/O, no clock.
 *
 * A provider process is the expensive unit, not a task. Every spawn re-pays
 * the system prompt, the tool definitions, and the agent's own orientation —
 * re-reading `package.json`, re-running the type-checker, rediscovering the
 * layout. Measured across 23 recorded runs: `wiki-llm/index.md` independently
 * re-read by 7 tasks, `package.json` by 6.
 *
 * So the scheduler admits a **group** — several tasks into one process, worked
 * through in order — rather than a task. Within a group that rediscovery cost
 * is paid once instead of N times, and it is paid by the process itself rather
 * than by a prompt section trying to describe what an earlier process learned.
 *
 * This subsumes the session-resume path it replaced. A chain `a` then `b`
 * collapsed by resuming `a`'s session and the same chain collapsed into one
 * process are the same execution, except that the process needs no session id,
 * no warm-cache window, and no provider-specific resume verb — so it also
 * works on the two adapters that have no resume at all.
 */

/**
 * Max tasks per process.
 *
 * ⚠️ **Unmeasured.** Grouping's saving is the fixed per-spawn cost paid once
 * instead of N times, so the return curve is `(N-1)/N` — 50% of it at 2, 75%
 * at 4, 83% at 6, 88% at 8. Most of the win is early, and what grows with N is
 * the risk: a longer prompt to conflate or skip a task in, a longer session to
 * drift or exhaust its context in, and more unreached members when a process
 * dies. 6 takes the knee of the curve and stops.
 *
 * Settle it with the data rather than by argument: `.baya/runs/*` already
 * records `cost_usd` and the cache-split token counts per run, so the same A/B
 * that `M6.6` specifies for `--no-memory` reads this too.
 */
export const DEFAULT_GROUP_SIZE = 6;

export interface GroupCandidate {
  id: string;
  depends_on: readonly string[];
  /**
   * What makes two tasks runnable in one process. Every component is load
   * bearing:
   *
   * - **provider** and **model**, because a process is one CLI talking to one
   *   model. This is where per-task model routing and grouping genuinely
   *   conflict, and routing wins by construction.
   * - **access**, because a process gets one sandbox. Grouping a `read-only`
   *   task with a `read-write` one would silently widen the first task's
   *   permissions, which is precisely what task-level `access` exists to stop.
   * - **cwd**, because a process has one working directory.
   */
  key: string;
}

/** The grouping key. Order fixed so it is stable across runs. */
export function groupKey(parts: {
  provider: string;
  model: string | null;
  access: string;
  cwd: string;
}): string {
  return [parts.provider, parts.model ?? "", parts.access, parts.cwd].join(" ");
}

export interface FormGroupInput {
  /** The task the scheduler already decided to run. Always in the result. */
  seedId: string;
  /** Every task, in topological order. Fixes the order tasks are prompted in. */
  order: readonly string[];
  candidates: ReadonlyMap<string, GroupCandidate>;
  /** Tasks still `pending`. A task in any other state is not up for grouping. */
  pending: ReadonlySet<string>;
  /** Tasks already `succeeded`, whose outputs are on disk. */
  succeeded: ReadonlySet<string>;
  /** Max members. `1` gives one process per task — the pre-grouping behavior. */
  cap: number;
}

/**
 * Grow a group outward from the seed.
 *
 * A task joins when it shares the seed's key and every dependency it has is
 * either already `succeeded` or is itself in the group. Those two admission
 * routes are what collapse the two shapes people actually have:
 *
 * - **siblings** — deps all succeeded, so a whole DAG layer on one model
 *   becomes one process;
 * - **chains** — the dep is in the group, so `a` then `b` then `c` becomes one
 *   process, with `b` prompted after `a` and reading `a`'s work directly out
 *   of the conversation rather than out of a file.
 *
 * Walking `order` (topological) means a task is only ever considered after its
 * dependencies, so one pass admits a whole chain and the result is already in
 * a valid execution order.
 *
 * ## Why the cap is small
 *
 * Grouping trades isolation for cost. One long prompt holding many tasks
 * invites the failure 1:1 execution cannot have — the model conflating two
 * tasks, or drifting, or quietly skipping one. The cap is the dial for that,
 * and `--group-size 1` opts out entirely.
 *
 * It also bounds the blast radius, which is the honest cost of grouping. The
 * scheduler commits to a group *before* the first task runs, so a process that
 * dies partway fails the members it never reached — they had no process left
 * to run in. Tasks the model *did* report are kept: results are read per task,
 * so finished work in a failed group is banked rather than lost. The cap is
 * what bounds how much is at stake in any one process.
 */
export function formGroup(input: FormGroupInput): string[] {
  const seed = input.candidates.get(input.seedId);
  if (!seed || input.cap <= 1) return [input.seedId];

  const group = new Set<string>([input.seedId]);
  for (const id of input.order) {
    if (group.size >= input.cap) break;
    if (group.has(id) || !input.pending.has(id)) continue;
    const candidate = input.candidates.get(id);
    if (!candidate || candidate.key !== seed.key) continue;
    const admissible = candidate.depends_on.every(
      (dep) => input.succeeded.has(dep) || group.has(dep),
    );
    if (admissible) group.add(id);
  }

  // Topological order, not insertion order: the seed may sit downstream of a
  // task admitted after it, and the prompt has to present them in an order
  // the agent can actually execute.
  return input.order.filter((id) => group.has(id));
}
