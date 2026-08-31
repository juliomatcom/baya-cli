# M2 — Concurrency & resilience, as a Baya task list

**What this is.** The M2 milestone of [`02-plan.md`](02-plan.md), decomposed into tasks small
enough for one agent process and written to be fed to Baya itself.

`02-plan.md` stays the milestone record and is not edited here. This file is the execution
order, the file-level detail, and the model assignment. Tick the plan's M2 rows only as
tasks land.

**Model assignment.** `luna` for mechanical plumbing with a known shape — flags, help text,
doc edits, pure list-building. `sonnet` for ordinary implementation plus its tests.
`opus` for the four tasks where getting the semantics wrong is expensive and hard to
detect: the parallel loop, retries inside a group, signal teardown, and resume. Baya groups
tasks that share a model into one process, so the assignment is also the cost lever — keep
`luna` work together rather than sprinkling it between `opus` tasks.

## Rules every task follows

- Read `wiki-llm/index.md`, then only the page it names, before touching a subsystem.
  `execution.md` covers the scheduler, semaphore, failure semantics and signals;
  `recovery.md` covers `state.json`, the failure taxonomy and resume.
- Update the affected `wiki-llm/` page in the **same change** as the code. A scheduler,
  lock, or signal change that leaves `execution.md` stale is not done.
- `npm run typecheck && npm run lint && npm test` must pass. Run `npm run format` before
  finishing.
- No new comments except a true edge-case _why_. No comment that narrates the edit.
- Test the rule, not the wording. Assert that concurrency never exceeded the budget, that
  a writer never overlapped another writer, that no pid survived — never that a spinner
  printed a particular string.
- The fake-provider harness already has every knob these tasks need
  (`test/fixtures/fake-provider.mjs`): `hang_ms`, `on_signal: "ignore"`, `spawn_child`,
  `writes_file`, `by_task`, and `error.kind` for classification. Do not add a new knob
  before checking the existing list in `wiki-llm/testing.md`.
- Do **not** rename `src/executor/sequential.ts`. Several of these tasks edit it at once and
  a rename mid-flight costs more than the stale name does.

---

## Tasks

### Admission — the pure half (M2.1, M2.2)

1 Create `src/executor/budget.ts` holding the pure admission rules for the parallel
scheduler, with no I/O and no clock. It answers one question: given the groups already in
flight, may this candidate group start? Enforce a global cap and a per-provider cap, where
the per-provider number comes from the adapter's `capabilities.maxConcurrency`
(`src/providers/types.ts:34`; codex 2, opencode 2, claude 1, copilot 1) and the global cap
is passed in. Model it as a small state object with `admit`/`release` rather than free
functions over a count, because the scheduler has to release on settle. Cover it with unit
tests in `test/unit/executor/`. Use sonnet.

2 Add the single-writer semaphore to `src/executor/budget.ts` from task 1: a group whose
`access` is `read-write` may only start when no other writer is in flight, while
`read-only` groups are limited by the budgets alone. This is `--isolation shared`, the v1
default described in `wiki-llm/execution.md` §Workspace isolation — in-memory only, nothing
on disk, because `.baya/baya.lock` already guarantees one Baya per directory. Unit-test
that two writers serialize, that readers do not block each other, and that a writer waiting
on the semaphore does not starve behind an unbounded run of readers. Depends on task 1.
Use sonnet.

3 Add `--max-parallel <n>` to `src/cli/args.ts` with the other numeric flags, default
`min(4, os.cpus().length)` resolved in `src/cli/run.ts`, and a one-line entry in the
OPTIONS block of `src/cli/help.ts` next to `--group-size`. Thread it through
`RunSequentialOptions` (`src/executor/sequential.ts:50`) as `maxParallel`, unused for now —
task 4 consumes it. Record the resolved value in the run's `config_snapshot`. Use luna.

### Admission — the loop (M2.1)

4 Rewrite the scheduler loop at `src/executor/sequential.ts:165` to run several groups at
once. Today it forms one group, awaits it, and re-evaluates; it must instead admit every
ready group that tasks 1–2 allow, hold the in-flight executions as promises, wake on the
first to settle, settle its members exactly as now, and re-evaluate the ready set. The
existing shape is already close — `readySet` + `formGroup` per pass — so the change is
admission and the await, not the settle logic, which must not be duplicated. Two things
will break if they are not held: a group must be formed from tasks still `pending` at
admission time (`formGroup` reads the pending set, and a concurrent settle mutates it), and
the loop must terminate when nothing is in flight and the ready set is empty, not when the
ready set alone is empty — otherwise a run with one slow group exits early. Update the
module's header comment, which currently describes the sequential design, and
`wiki-llm/execution.md` §Scheduler, which says "Sequential today". Depends on tasks 1, 2
and 3. Use opus.

5 Add an integration test for the parallel scheduler in `test/integration/`, driving the
real CLI through `test/helpers/runCli.ts` against the fake provider: a fan-out/fan-in graph
whose middle layer is wide, with `writes_file` markers and `hang_ms` so overlap is
observable, asserting that the number of concurrently running processes never exceeded
`--max-parallel` nor the per-provider cap, and that the fan-in task ran only after every
upstream finished. Depends on task 4. Use sonnet.

6 Add an integration test for the writer semaphore: two independent `access: "read-write"`
tasks on providers with spare budget must never overlap, while two `read-only` tasks on the
same providers do. Use the fake provider's `writes_file` start/end markers as the overlap
record — a test that infers serialization from timing alone will flake. Depends on tasks 4
and 2. Use sonnet.

### Failure semantics (M2.3, M2.5b)

7 Add `--on-error continue|stop` to `src/cli/args.ts`, default `continue`, with its help
entry and `RunSequentialOptions` field. Parse-and-plumb only; task 8 implements the
behavior. Reject an unknown value with the same shape as the other enum flags. Use luna.

8 Implement `--on-error stop` in the scheduler loop: on the first failure, stop admitting
new groups, let everything in flight finish, then report. Tasks that were never admitted
end as `skipped` with `blocked_by` naming the failure that stopped the run, so the report
and `baya resume` can tell them apart from tasks skipped for a broken dependency. `continue`
keeps today's behavior — descendants `skipped`, independent branches finish. Cover both
modes in `test/integration/failure.test.ts`. Depends on tasks 4 and 7. Use sonnet.

9 Implement provider exhaustion: a failure classified `quota` (`retry: "later"`,
`src/executor/classify.ts:82`) stops scheduling for **that provider only**, while other
providers' branches finish and the run stays resumable. Tasks stranded by the exhausted
provider must be distinguishable in `state.json` from tasks that failed on their own —
decide the state and write the rule into `wiki-llm/execution.md` §Failure semantics, which
already promises this behavior. Add an integration test with two providers where one
quota-fails and the other completes its branch. Depends on task 4. Use sonnet.

10 Implement `--retries <n>` (default 1) with exponential backoff plus jitter, for
`retry: "now"` failures only: `quota`/`rate_limit` (`later`) and `auth`/`permission`
(`never`) must consume zero attempts, which is the rule that keeps a run from burning its
budget on a wall it cannot get through. The subtlety is grouping: the retryable unit is the
**process**, and a group that died partway has banked results for the members the model did
report (`wiki-llm/execution.md` §Grouping). Decide what a retry re-runs — the whole group,
or only the members that never settled — and make sure a retry can never re-run a task
already `succeeded` or double-count its usage in the run totals. Record attempts in
`state.json`'s existing `attempts` field (`src/executor/state.ts:55`), write the rule into
`wiki-llm/execution.md`, and test both a retried transient failure and a `later` failure
that consumed no attempt. Depends on task 4. Use opus.

### Signals (M2.4)

11 Fix the teardown wiring in `src/cli/run.ts:292`: `activePids` is created, passed to the
interrupt handler, and **never populated**, so Ctrl+C today signals nothing and every live
provider process survives it. Add a spawn/exit callback pair to `RunSequentialOptions` —
`executeGroup` already surfaces the pid through `onSpawn` (`src/executor/task.ts:50`) and
the scheduler already uses it to checkpoint — so `run.ts` can add the pid on spawn and drop
it on settle. Keep the set correct under parallelism: several pids are live at once, and a
stale entry means signalling a pid the OS may have reused. Depends on task 4. Use sonnet.

12 Implement the full signal contract in `src/cli/interrupt.ts` and
`src/executor/spawn.ts`: SIGTERM to the process group, a 5-second grace window, then
SIGKILL to whatever is still alive; a second Ctrl-C kills immediately instead of waiting out
the grace; and the same teardown path on SIGTERM, SIGHUP and `uncaughtException`, each
exiting with the right code. The timeout path at `src/executor/spawn.ts:92` sends SIGTERM
and never escalates, so a provider that ignores it currently hangs the run to its deadline
and beyond. `killGroup` (`src/executor/spawn.ts:138`) already signals the group rather than
the leader — keep that, it is what reaps grandchildren. The cursor restore must survive
every path (`wiki-llm/conventions.md` rule 15): an exit that skips it leaves the user's terminal
with no cursor. Update `wiki-llm/execution.md` §Interrupts. Depends on task 11. Use opus.

13 Add the teardown integration test: a fake provider with `spawn_child: true`,
`on_signal: "ignore"` and a long `hang_ms`, interrupted mid-run, asserting **zero surviving
pids** via `ps` and exit code 130. Assert the grandchild is gone, not just the leader —
that is the case process-group signalling exists for. `ps` is unavailable in some sandboxes;
if it is missing, skip with an explicit reason rather than silently passing. Depends on
task 12. Use sonnet.

### Live status (M2.7)

14 Make the progress line parallel-aware. `src/cli/run.ts` drives a single ora line through
`spinGroup` with one elapsed ticker, which was right when one group ran at a time and will
show only the most recently started group once task 4 lands. Render every in-flight group
with its own task ids, provider, model and elapsed time, still through `src/ui/progress.ts`
as the single owner of the terminal line (never a bare `process.stderr.write`), still
stderr-only so `--json` on stdout stays pipeable, and still silent under `--no-progress`,
`--quiet` and a non-TTY. A model that emits nothing until it finishes must still look alive:
the elapsed counter is the only signal the user gets on `claude --output-format json`.
Depends on task 4. Use sonnet.

### Resume (M2.8, M2.9)

15 Add a `paused` member to the run status enum at `src/executor/state.ts:119` and set it
when a run ends with parked tasks and nothing failed — today such a run is recorded
`completed`, which is what `baya resume` will read to decide whether there is anything left
to do. Decide whether this needs a `STATE_VERSION` bump: `recovery.md` requires schema
changes to bump it, and an older Baya reading a `paused` state.json would fail validation.
Write the decision into `wiki-llm/recovery.md` next to the status list. The terminal report
already renders a paused run correctly (`src/ui/report.ts`) — do not change its wording.
This task depends on nothing and must not wait on the scheduler work: it touches only the
status enum, the single line that sets the final status (`src/cli/run.ts:588`), and the
wiki page. Use sonnet.

16 Implement `baya runs`: list resumable runs by reading `.baya/runs/*/state.json`, newest
first, showing run id, source path, start time, status and totals. Remove `runs` from
`UNIMPLEMENTED_COMMANDS` (`src/cli/args.ts:26`), add its help entry, and support `--json`
exactly as `baya models` does. Keep the row-building pure and unit-test it against fixture
states, including a state.json that is truncated or unparseable — a half-written run must
be listed as damaged, never crash the listing. Depends on task 15. Use sonnet.

17 Implement `baya resume <runId>`: re-run every `failed`, `skipped`, `parked` and
interrupted task while keeping each `succeeded` task's output as upstream context, and
never re-running a task that already succeeded — that guarantee is the whole point of the
checkpointing machinery. Reproduce the original run's settings from `config_snapshot`
rather than the current config, honor a `--provider` override for re-running elsewhere, and
warn when the source file's `sha256` no longer matches what the run was planned from. With
no `runId`, offer a picker and never guess, since several runs may sit paused at once; with
no TTY and no `runId`, exit 2. A resume regroups from scratch and never reconstructs the
previous run's groups (`wiki-llm/recovery.md`). Decide whether a resume writes into the
original run directory or opens a new one linked to it, and document the decision in
`recovery.md` — everything downstream (`baya runs`, the report, cost totals) depends on it.
Cover interrupt → resume → completion, and assert no succeeded task ran twice. Remove
`resume` from `UNIMPLEMENTED_COMMANDS`. Depends on task 16. Use opus.

18 Implement the recovery prompt as a pure `buildRecoveryChoices(state)` plus a thin
`@inquirer/prompts` caller, following the wizard's split in `src/config/wizard.ts` where
the choice-building is pure and unit-tested and no test ever opens a prompt. Order the
options by `failure.kind`: "retry on a different provider" first for `quota` and `auth`,
plain retry first for the `now` kinds, and never offer a retry for a `never` kind. Show the
run summary, the failure detail and the log path. Non-TTY must fall through to a printed
summary, never a hang. Depends on task 17. Use sonnet.

### Close-out

19 Sync the docs to what M2 actually shipped. `README.md`'s feature list currently claims
**Parallel execution** and **Resume** as done — verify each claim against the merged code
and correct any that is still ahead of it; the same list also carries claims from earlier
milestones worth re-checking while you are there. Confirm `wiki-llm/execution.md` no longer
says the scheduler is sequential, that `wiki-llm/cli.md` documents `--max-parallel`,
`--on-error` and `--retries`, and that every M2 row in `specs/001/02-plan.md` that landed is
ticked. Change no code. Depends on tasks 13, 14, 17 and 18. Use luna.
