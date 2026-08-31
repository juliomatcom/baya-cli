# M2 continuation — the minimum, as a Baya task list

**What this is.** The part of [`03-tasks-M2-baya.md`](03-tasks-M2-baya.md) worth finishing
now, re-sliced. That run died mid-flight on 2026-08-30 (`session limit`, run
`20260830T191301Z-0b651b-1458`) and its `state.json` under-reports badly: the last process
did its work and hit the limit **before it could report**, so several finished tasks are
recorded with `files_changed: []` or as `skipped`. **Disk is the source of truth, not
`state.json`.** A consequence worth holding: that code landed without its author's own
review, which is how the two stale tests in task 1 and 2 survived.

**Scope — deliberately cut to nine tasks.** Only the work that loses money or leaves
processes alive is here. What was dropped, and why, is listed below so nobody re-adds it by
accident.

**Concurrency is closed** ([`02-plan.md`](02-plan.md) §M2, decided 2026-08-31). Independent
`read-only` tasks run at once; every `read-write` task takes the single writer key and runs
alone. Parallel writers are worktree isolation — a later milestone, not this list. **No task
here touches `src/executor/budget.ts`'s writer key or argues about it.**

**Model assignment.** `sonnet` throughout except task 1, which is mechanical enough for
`luna`. **No `opus`.** The previous run gave it four tasks and each was large enough to burn
a session limit before returning a result; the fix is the slicing below, not a bigger model.
Nothing here is more than one file's worth of thinking.

## Already landed — do not redo

Verified on disk 2026-08-31: `npm run typecheck` passes, 803/805 tests green.

| Landed                                                             | Where                                                                      |
| :----------------------------------------------------------------- | :------------------------------------------------------------------------- |
| Parallel scheduler loop, admission, writer key                     | `src/executor/sequential.ts`, `src/executor/budget.ts`                     |
| `--max-parallel`, `--on-error`, `--retries` parsing and plumbing   | `src/cli/args.ts`, `src/cli/help.ts`, `src/cli/run.ts`                     |
| Retries with exponential backoff + jitter, `now` kinds only        | `src/executor/sequential.ts:142` (`backoffMs`), `:440`                     |
| Parallel + writer-serialization integration tests                  | `test/integration/parallel.test.ts`                                        |
| `baya runs`, `baya resume`, run picker, `paused` status            | `src/cli/runs.ts`, `src/cli/resume.ts`, `src/ui/run-picker.ts`             |
| `fail_attempts` harness knob for retry tests                       | `test/fixtures/fake-provider.mjs:101`                                      |

## Deliberately deferred — not forgotten

| Deferred                     | State today                                                                                                                  | Why it can wait                                                          |
| :--------------------------- | :--------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| `--on-error stop` behavior   | Parsed at `args.ts:244`, never read — `sequential.ts:89` is its only mention, so `stop` silently behaves like `continue`.     | A flag that lies. Task 3 builds the drain-and-halt machinery it needs, so afterwards it is a trigger, not a feature — or delete the flag. |
| Parallel-aware progress      | `src/cli/spinner.ts` disposes and restarts per group, so with readers fanning out only the last-started group is visible.     | Cosmetic. The run is still correct, just under-reported while it runs.     |
| Recovery prompt (`M2.9`)     | `buildRecoveryChoices` does not exist; `wiki-llm/recovery.md:164` says "not built yet".                                       | `baya resume <runId>` already works without being asked what to do.       |
| Retry test coverage          | Retries work; nothing asserts them, including "`quota` consumes zero attempts".                                              | Cheap insurance, no live defect.                                          |
| Docs close-out               | `README.md:20/94/98` and `wiki-llm/cli.md:48-49` still describe some of this as planned.                                      | Every task below updates its own wiki page, so nothing new goes stale.    |

## Rules every task follows

- Read `wiki-llm/index.md`, then only the page it names, before touching a subsystem.
  `execution.md` covers the scheduler, failure semantics and signals; `recovery.md` covers
  `state.json`, the failure taxonomy and resume.
- Update the affected `wiki-llm/` page in the **same change** as the code. A scheduler or
  signal change that leaves `execution.md` stale is not done.
- `npm run typecheck && npm run lint && npm test` must pass. Run `npm run format` before
  finishing.
- No new comments except a true edge-case _why_. No comment that narrates the edit.
- Test the rule, not the wording. Assert that no pid survived, that no further process
  spawned — never that a spinner printed a particular string.
- The fake-provider harness already has every knob these tasks need
  (`test/fixtures/fake-provider.mjs`): `hang_ms`, `on_signal: "ignore"`, `spawn_child`,
  `writes_file`, `by_task`, `fail_attempts` and `error.kind`. Check the list in
  `wiki-llm/testing.md` before adding one.
- Do **not** rename `src/executor/sequential.ts`. Several tasks edit it at once.
- Do **not** implement anything in the deferred table above, even where a task lands next to
  it. Leave the gap and say so in a note.

---

## Tasks

### Green the tree first

1 Two mechanical fixes. Refresh the help snapshot at
`test/unit/cli/__snapshots__/help.test.ts.snap` — it predates the `--retries` row, which is
the only diff, so `npm test -- -u` and confirm nothing else moved. Then stop Jest walking
`.history/`, the editor's local-history directory, which currently makes every run report
two obsolete snapshot files that do not exist in the repo; add it to
`testPathIgnorePatterns` in `jest.config.js:21`, beside the other excluded paths. Depends on
nothing. Use luna.

2 Settle what `attempts` means across a resume, then fix
`test/integration/resume.test.ts:99`. It expects `build.attempts === 2` and gets `3`: the
test was written before `--retries` landed, so the failed run now burns a retry of its own
before the resume adds another. Decide which is right — a resume continues the task's
lifetime attempt count, or it starts a fresh one — and make the code and the test agree.
The `attempts` field is documented in `wiki-llm/recovery.md` §`state.json`; whichever way
you decide, say so there in one line, because `--retries` is a budget and a reader has to
know whether a resume refills it. Depends on nothing. Use sonnet.

### Provider exhaustion (M2.5b)

3 A `quota` failure stops the **whole run**, not just that provider. When any task fails
classified `quota` (`retry: "later"`, `src/executor/classify.ts:82`), the scheduler stops
admitting new groups, lets everything already in flight run to completion — that work is
paid for either way — and then reports. Nothing needs adding to `src/executor/budget.ts`:
this is a halt flag on the loop, checked in `admitReady` (`sequential.ts:288`), not a
per-provider budget. The loop's termination condition already handles a drain correctly
(`inFlight.size === 0` **and** an empty ready set, `:260`), so this is a guard on admission
alone.

Every task that never started ends `skipped`, with `blocked_by` naming the quota failure
that stopped the run — distinct from the dependency case `markDescendantsSkipped`
(`sequential.ts:875`) already writes, because "we stopped early, nothing is wrong with it"
and "its upstream broke" mean different things to the report and to `baya resume`. The run
must stay resumable: a resume with `--provider` is the intended recovery, so nothing here
may mark the run unrecoverable.

`wiki-llm/execution.md` §Failure semantics currently promises the opposite at `:136` —
"stop scheduling **for that provider**; other providers' branches continue". That rule is
withdrawn; rewrite the row to say the run halts, and note in one line **why**: a quota wall
usually means the session or the billing account is done, not that one CLI is, and finishing
half a graph on a second provider spends money to arrive somewhere no more resumable than
stopping cleanly would have been. Depends on nothing. Use sonnet.

> Leaves behind the drain-and-halt machinery `--on-error stop` needs (deferred above). A
> later task should trigger the same halt from the flag rather than build a second one.

4 Add the integration test: two providers, one quota-fails partway, the other has work still
pending. Assert the run stops — **no further process spawned on either provider** after the
quota failure — that anything already in flight was allowed to finish rather than killed,
that the never-started tasks are `skipped` with a `blocked_by` distinguishable from a
dependency skip, and that the resulting `state.json` is resumable: a `baya resume` of it
targets exactly the tasks that never ran. Depends on task 3. Use sonnet.

### Signals — the pid set (M2.4)

5 Populate `activePids`. It is created at `src/cli/run.ts:287`, handed to the interrupt
handler at `:294`, and **never added to** — so Ctrl+C today signals nothing, Baya exits, and
every live provider process keeps running and keeps billing. `src/cli/resume.ts:199` has the
identical hole. Add a spawn/exit callback pair to `RunSequentialOptions`; the scheduler
already has both edges — `onSpawn` at `sequential.ts:414` and the settle at `:271` — so this
is surfacing what is already there, not new plumbing. Keep the set correct under
parallelism: several pids are live at once, and a stale entry means signalling a pid the OS
may have reused, so a settle must remove exactly its own. Both shells wire it the same way.
Depends on nothing. Use sonnet.

### Signals — the contract (M2.4)

6 Make a timed-out process actually die. `src/executor/spawn.ts:92` sends SIGTERM at the
deadline and never escalates, so a provider that ignores it hangs the run past its timeout
indefinitely. Add the escalation: SIGTERM, a grace window, then SIGKILL to whatever is still
alive, both through `killGroup` (`:138`) which signals the process group rather than the
leader — keep that, it is what reaps grandchildren. Unit-test the escalation with an
injected timer rather than by waiting out a real five seconds. Depends on nothing.
Use sonnet.

7 Implement the grace window in `src/cli/interrupt.ts`. Today `createInterruptHandler`
sends one SIGTERM per live group and exits immediately; the contract in
`wiki-llm/execution.md` §Interrupts is SIGTERM → 5s grace → SIGKILL to survivors, and a
**second Ctrl+C kills immediately** instead of waiting the grace out. The current handler
returns early on re-entry (`if (firing) return`) — that early return is where the second
Ctrl+C has to escalate instead. Take the clock and the timer as injected dependencies, as
`InterruptDeps` already does for `killGroup` and `exit`, so the unit test runs instantly and
no test sends a real signal to the test runner. Depends on tasks 5 and 6. Use sonnet.

8 Route the other exits through the same teardown: SIGTERM, SIGHUP and `uncaughtException`
each take the handler from task 7 and exit with their own code (SIGINT is 130, already
`SIGINT_EXIT_CODE`). The cursor restore must survive **every** path — `restoreCursor` in
`src/ui/progress.ts:45` is exported precisely so a handler can call it without
reconstructing the escape, and an exit that skips it leaves the user's terminal with no
cursor long after Baya is gone (`wiki-llm/conventions.md` rule 15). Wire it in both
`src/cli/run.ts` and `src/cli/resume.ts`. Update `wiki-llm/execution.md` §Interrupts in the
same change. Depends on task 7. Use sonnet.

9 Add the teardown integration test: a fake provider with `spawn_child: true`,
`on_signal: "ignore"` and a long `hang_ms`, interrupted mid-run. Assert **zero surviving
pids** via `ps` and exit code 130, and assert the **grandchild** is gone, not just the
leader — that is the case process-group signalling exists for. `ps` is unavailable in some
sandboxes: skip with an explicit reason rather than passing silently, which is how a
teardown regression would go unnoticed. Depends on task 8. Use sonnet.
