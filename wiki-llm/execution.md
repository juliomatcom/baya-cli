# Execution

> **Maintenance Invariant:** Runtime semantics only. `later` items are out of v1 — do not implement without moving the tag. Update in the SAME commit as any scheduler, lock, or signal change. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** Task scheduling + parallelism. Failure, question, Ctrl+C behavior. Writer protection.

## Scheduler

Loop, per pass: compute ready-set (all `depends_on` `succeeded`) → **form a group** (§Grouping) from the tasks still `pending` → offer it to the **global budget**, the **per-provider budget** and the **writer semaphore** → spawn every group admitted, holding each as a promise → wake on the first to settle → settle its members → offer again. Parallel: `src/executor/sequential.ts`.

**Terminates when the ready-set is empty AND nothing is in flight.** On the ready-set alone a run whose last groups are slow exits while they are still out.

State is re-read **per offer**, not per pass — a settle moves tasks out of `pending`, and a group formed from a stale pending set puts one task in two processes.

A refused group is re-offered on a later pass; a refused writer holds readers back until it gets in (§Workspace isolation). Its id is released when regrouping retires it — a group that re-forms around a task that became ready meanwhile has a new leader, and the retired id would block readers for the rest of the run.

The admitted unit is a **group**, not a task. Grouping decides what goes in a process; parallelism decides how many processes run at once. They compose — do not conflate them.

| Budget       | Source                                | Default                                             |
| :----------- | :------------------------------------ | :-------------------------------------------------- |
| Global       | `--max-parallel`                      | `min(4, cpus)`                                      |
| Per-provider | adapter `capabilities.maxConcurrency` | `codex` 2 · `opencode` 2 · `claude` 1 · `copilot` 1 |

Per-provider caps conservative — consumer subscriptions throttle. Raise via the user config once measured.

Both budgets live in a pure in-memory state object, `src/executor/budget.ts` (`AdmissionState`): `admit(group)` on spawn, `release(id)` on settle, no clock, nothing on disk. A provider absent from the per-provider map is bounded by the global cap alone.

## Workspace isolation

**v1 — `--isolation shared` (default).** `access:"read-only"` tasks run fully parallel. Any `access:"read-write"` task takes the **single-writer semaphore** — writers serialize against each other, readers continue.

Semaphore is **in-memory in the scheduler**, nothing on disk — one Baya per directory ([recovery.md](recovery.md)) means no second process to coordinate with. It lives with the count budgets in `src/executor/budget.ts` (`AdmissionState`, keyed on the group's `access`).

**Writer fairness.** Once a `read-write` group has been offered and refused, no new `read-only` group is admitted until that writer gets its slot — a readers-only wait would otherwise starve it indefinitely. In-flight readers still finish; only new ones are held.

**`later` — `--isolation worktree`.** `git worktree add .baya/wt/<id>` per writing task for true parallel writes + end-of-run merge/report. Deferred until write-parallelism is a measured bottleneck. A user-level worktree already covers "two task lists, one repo".

## Permissions

Never guessed. Task policy → adapter mapping: `access:"read-only"` ⇒ read-only; `access:"read-write"` ⇒ workspace-write. Full bypass requires explicit `--dangerously-allow-all` on the `baya` invocation — **never inferred from the task list**. Per-adapter flags: `providers.md`.

## Context bus

Upstream results persist to `tasks/<id>/result.json` + `output.md`. A downstream `task_request.context[]` entry always carries `summary` + absolute paths; `inline` carries text only when it fits.

| `--context-strategy`      | Behavior                                                         |
| :------------------------ | :--------------------------------------------------------------- |
| `link-only` (**default**) | `summary` + paths. Agent reads the file for detail.              |
| `truncate`                | Inline head+tail to the per-edge budget, with an elision marker. |
| `summarize` `later`       | LLM-compress upstream output before injection.                   |

Budgets: `--context-budget` 12000 chars total, 6000 per edge. `link-only` default: these providers are agentic and open files; a path costs ~40 tokens (unbounded), inlining 40 KB costs ~10k and still truncates. Fan-in of five 40 KB upstreams is the breaking case for naive prepending.

## Grouping

> **The project's core cost lever. Read this before proposing anything cheaper.**

A **process** is the expensive unit, not a task. Every spawn re-pays the system prompt, tool definitions, and the agent's own orientation. Measured across 23 recorded runs: `wiki-llm/index.md` independently re-read by 7 tasks, `package.json` by 6, `npm run typecheck` re-run by 4.

**The rule — one sentence, and it is the whole feature:**

> Group any set of tasks sharing `(provider, model, access, cwd)` whose dependencies are either already `succeeded` or inside the group.

Grow outward from the seed the ready-set picked, walking tasks in topological order. Two admission routes fall out of that one rule:

| Shape        | Why it is admitted          | What collapses                                           |
| :----------- | :-------------------------- | :------------------------------------------------------- |
| **siblings** | deps already `succeeded`    | a DAG layer on one model ⇒ one process                   |
| **chains**   | the dep is **in** the group | `a`→`b`→`c` ⇒ one process, `b` reading `a` from the chat |

Every component of the key is load bearing:

| Key part           | Why                                                                                                                                    |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`,`model` | A process is one CLI talking to one model. Where per-task model routing and grouping conflict, **routing wins by construction**.       |
| `access`           | A process gets **one sandbox**. Grouping read-only with read-write would silently widen permissions — the one thing `access` prevents. |
| `cwd`              | A process has one working directory.                                                                                                   |

**Cap:** `--group-size` (default 3, **unmeasured**). Two jobs. It bounds prompt length, because a long prompt holding many tasks invites the failure 1:1 execution cannot have — conflating two tasks, drifting, quietly skipping one. And it bounds blast radius: the scheduler commits to a group **before** the first task runs, so a process that dies partway fails the members it never reached. `--group-size 1` is a true bypass — one process per task, and byte-for-byte the pre-grouping prompt and wire format.

The saving is the fixed per-spawn cost paid once instead of N times, so the return curve is `(N-1)/N`: 50% at 2, 67% at 3, 75% at 4, 83% at 6. Most of the win is early; what grows with N is the risk. 3 takes two thirds of the saving and keeps the blast radius small enough to re-run by hand. Settle it with `.baya/runs/*` (`cost_usd` + the cache split are already recorded per run), not by argument.

**Preview:** the plan gate projects the groups before the run is confirmed (`projectGroups`, cli.md §Plan gate) — which tasks share a process, and a warning when one fills the cap. It replays this scheduler loop rather than restating the rule, so it cannot drift; it is exact on the happy path and guaranteed only for the first group.

**Response:** one process returns one document. A group answers with a `task_result_batch` (protocol.md §3b) holding one `task_result` per task; a lone task answers with the plain `task_result`, unchanged. Results are matched back **by `task_id`, never by position** — a task the model did not name is reported failed, which is recoverable, where crediting one task with another's output is not.

**Deadline:** members' `max_runtime_s` summed, capped at `MAX_GROUP_RUNTIME_S` = `DEFAULT_GROUP_SIZE × 900` = 2700. Derived, not an independent number: a cap below `size × budget` silently gives every task **less** time than it was budgeted, so it must never bite at the default size. Above the default it bites on purpose — `--group-size 12` asks to pack more into one process, not for a three-hour process with no checkpoint granularity inside it.

**Dependency order is the orchestrator's, not the model's.** A member downstream of a member that failed is `skipped` whatever the model reported for it. Within a dead process (non-zero exit or timeout), the first casualty is `failed` and everything after it is `skipped` — it never ran.

**Artifacts:** `request.json` / `result.json` / `output.md` are per task. `events.jsonl` / `stdout.log` / `stderr.log` are per **process** and live in the group leader's directory; every member's `artifacts` points at them. Usage is the process's and is recorded on the leader with zero on the rest, so run totals stay honest; `group_id` in `state.json` puts them back together.

**Why this replaced session reuse.** Chain-collapse-by-`--resume` and chain-collapse-by-one-prompt are the same execution — but the prompt needs no session id, no warm-cache window, no per-adapter resume verb, and no cold-retry fallback for a resume the CLI might reject. It also covers siblings, which resume never could, and works on all four adapters including the two with no resume path. Grouping is strictly more capable and strictly less machinery. **Do not reintroduce session management to solve a cost problem grouping already solves.**

## Memory

The context bus follows **edges**. Two tasks in different branches share none, so both pay to rediscover the same repo facts. Memory is the **edgeless** channel: derived facts fan out to every later task regardless of the graph.

**Derived only — never self-reported.** No `learnings[]` field on `task_result`. Every fact is read back out of a record the provider already wrote, so producing memory costs **zero tokens** and nothing in it can be hallucinated. Delivery costs ~1200 chars (~300 tokens) per prompt.

Grouping already kills rediscovery **within** a process. Memory is what crosses a group boundary — a different model, a different access level, a later layer.

Pipeline: adapter `extractObservations` + each result's `files_changed` → `Observation[]` → `deriveMemory` (pure) → `MemoryEntry[]` → `renderMemory` (pure) → one `# Known about this workspace` section in the prompt, placed with `# Workspace` (memory is workspace knowledge; `# Upstream results` means edges). Snapshot per run at `runs/<runId>/memory.json`.

| Observation source                   | Provider                        | Read from                                                                                                |
| :----------------------------------- | :------------------------------ | :------------------------------------------------------------------------------------------------------- |
| `observations: "events"`             | `codex`                         | Baya's own `events.jsonl` — `command_execution{command,exit_code,status}`, `file_change{changes[].path}` |
| `observations: "none"`               | `claude`, `copilot`, `opencode` | no commands — `--output-format json` is one object and carries no tool events                            |
| `files_changed` (**every** provider) | all four                        | the `task_result` itself; protocol-level, so it needs no adapter support                                 |

⚠️ **Documented sources only.** Reading a provider's private session log off disk was built and removed: the path was undocumented, it worked for exactly one provider, and it made memory's quality depend on a file nobody promises to keep. A new observation source must be something the provider documents and more than one provider can offer. `files_changed` is the model for that — protocol-level, cross-provider, free.

Fact kinds, in value-per-token order — the budget is spent in this order, after every kind is guaranteed 2 items:

| Kind               | Why it earns prompt space                                                                                                  |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `command.deadend`  | Failed and never later succeeded. Most expensive thing to rediscover: rediscovering it means paying for the failure again. |
| `command.verified` | Exit 0. Stops the "how do I check this" probe.                                                                             |
| `file.changed`     | **Correctness**, not just cost — a later task must know what was already edited.                                           |
| `file.hot`         | Read by ≥2 tasks. Kills the orientation phase.                                                                             |

Keyed (`command:<cmd>` / `file:<path>`), so a later fact **replaces** an earlier one instead of appending a contradiction. Exploration commands (`sed`, `rg`, `git`, `env`, …) contribute paths only — `rg` exits 1 on "no matches", which is not a dead end. Caps: 6 items per kind, 120 chars per command. Both measured: without them, one task flailing through variations of one invocation produced 14 dead ends and crowded out every other kind.

⚠️ **A command that never executed is not a dead end.** Measured 2026-08-29: a denied `npm test` was filed under "Commands that FAILED (do not repeat them)", the next task read that and refused to try, and by the fourth task the block held five dead ends none of which had ever run — a survivable permission warning became a cascading run failure. Any new observation source must answer "did this actually execute?" before it emits a dead end.

**Never carries command output** (`aggregated_output`, `tool_result.content`). It is most of the bytes and the only route by which untrusted repository text could enter memory. The block is framed as evidence, not instruction.

Flags: `--no-memory` (off, for A/B measurement) · `--memory-budget <chars>` (default 1200).

## Failure semantics

| Concern            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task fails         | **Descendants** ⇒ `skipped`, never `failed`. Independent branches continue.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--on-error stop`  | Stop admitting new tasks; let in-flight finish; then report.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Retries            | `--retries` (default 1), `retry:"now"` failures only. **`quota`/`rate_limit` ⇒ `retry:"later"`, `auth`/`permission` ⇒ `"never"` — none consume attempts.** Exponential backoff + jitter. Taxonomy: [recovery.md](recovery.md).                                                                                                                                                                                                                                                                                         |
| Quota failure      | `quota` (`retry:"later"`) ⇒ **halt the whole run**: stop admitting groups, let in-flight work finish, then `skipped` every unstarted task — independent branches included — `blocked_by` the quota task and carrying its `failure` (so it reads apart from a dependency skip). Run stays resumable; `baya resume --provider` is the recovery. A quota wall is the session or the billing account, not one CLI — finishing half the graph elsewhere spends money to land somewhere no more resumable than a clean stop. |
| Timeout            | `constraints.max_runtime_s` (default 900, summed per group) ⇒ SIGTERM via `killGroup`, a grace window (`killGraceMs`, default 5s), then SIGKILL to whatever is still alive — `status:failed`, `retryable:true`. Same escalation as SIGINT, so a provider that traps SIGTERM cannot outlive its deadline.                                                                                                                                                                                                               |
| Group dies partway | First casualty `failed`; every later member `skipped` — it never ran. Members the model **did** report are kept, so finished work in a failed group is banked.                                                                                                                                                                                                                                                                                                                                                         |

Exit: `0` all succeeded · `1` any failed/skipped/parked (or `uncaughtException`) · `2` planner/validation/model-gate error · `130` SIGINT · `143` SIGTERM · `129` SIGHUP.

## Escalation — Pause & Resume

Headless CLIs never ask mid-run — no stdin channel to answer into. Escalation is structural:

1. Provider returns `status:"needs_input"` + `question.text`.
2. Node ⇒ `parked`. **Independent branches keep running.**
3. Questions enter a **serialized prompt queue** — exactly one owns stdin at a time. Render task id, provider, title, question, options.
4. On answer, resume that provider's **own session** (`codex exec resume <id>` · `claude --resume <id>` · `copilot --resume=<id>` · `opencode run -s <id>`) with a `task_request` whose context carries the answer.
   - **Session ids:** `claude`/`copilot` accept a **pre-assigned** `--session-id <uuid>` — id known before the process starts, resume never parses. `codex` (`thread_id`) / `opencode` (`sessionID`) captured from `ProviderEvent {t:'session'}`.
   - **Disable the provider's question tool** where one exists (`copilot --no-ask-user`) — a blocking prompt defeats the design.
5. `resume:'none'` providers ⇒ **cold resume**: re-run with question+answer in context. `later`.

Non-TTY (`--on-input`): `ask` (default; errors immediately if stdin not a TTY) · `fail` · `skip` · `default` (use `question.default`). `--yes` auto-confirms the plan gate only — never answers a task question.

Out of scope permanently: PTY multiplexing, keystroke injection, alternate-buffer scraping.

## Interrupts

Every spawn sets `stdin` explicitly (prompt pipe or `/dev/null`) — inherited stdin makes `claude -p` block 3s/task. Children spawn `detached:true` in their own process group — Node's `child_process` does not kill grandchildren; agentic CLIs spawn subprocesses.

Teardown contract (`src/cli/interrupt.ts`, `createInterruptHandler`), on the first signal:

1. `logger.warn("signal.received")`, then `checkpointInterrupted()` — evidence + a resumable run **before** anything is killed.
2. `killGroup(pgid,'SIGTERM')` for every live pid; log `process.killed`.
3. Wait an injected grace window (`graceMs`, default 5s, matching `DEFAULT_KILL_GRACE_MS` in `src/executor/spawn.ts`). Clock + timer are injected so tests are deterministic and send no real signal.
4. On grace elapse: `killGroup(pgid,'SIGKILL')` for every pid the scheduler **still lists live** (a provider that exited on SIGTERM was already dropped by `onProcessExit`), log `run.interrupted` with `grace_ms`, `progress.dispose()` (restores the cursor — never reconstruct the escape), `releaseLock()`, `exit(code)`.

Nothing in flight ⇒ the grace window is skipped. **A second Ctrl+C during the grace window escalates immediately** — SIGKILL + teardown now, the first signal's exit code stands.

`installInterruptHandlers` registers SIGINT, SIGTERM, SIGHUP and `uncaughtException` on that one handler in both `src/cli/run.ts` and `src/cli/resume.ts`, and returns the unregister function called in `finally`. Every route runs the identical teardown; only the exit code differs: SIGINT `130`, SIGTERM `143`, SIGHUP `129`, `uncaughtException` `1` (logged as `run.crashed`). A crash therefore reaps its child process groups instead of orphaning them. Live pids are checkpointed so a later `baya doctor` can reap strays.

The set of live pids the handler signals is maintained by `onProcessSpawn`/`onProcessExit` callbacks: add on spawn, remove the exact pid on settle, so parallel groups are all signalled and a settled or reused pid is never carried. **Two producers feed it** — the scheduler (`RunSequentialOptions`) and the planner (`RunPlannerProviderOptions`, `src/planner/provider.ts`).

⚠️ The planner half was missing until 2026-08-31, and planning is the one phase where the set was therefore always empty. Ctrl+C then hit the "nothing in flight" fast path: baya exited 130 while its planner child — `detached:true`, so the terminal's SIGINT never reached its group — kept running orphaned and kept spending. Reproduced with `opencode` as planner, and pinned by `test/unit/planner/planner-pid.test.ts`. Any future provider spawn outside the scheduler must register the same pair.

A per-process **timeout** runs the same SIGTERM → grace → SIGKILL escalation inside `src/executor/spawn.ts` (`killGroup`, injectable timers).

## Run state

`runs/<runId>/state.json` rewritten **atomically** (tmp + `rename`) after every transition — task states, pids, session ids, timings, cost, normalized `failure` record. `state.json` is written **before** an action, never after.

`baya resume` / `baya runs` are v1 (M2.8). Full schema, failure taxonomy, recovery prompt: **[recovery.md](recovery.md)**.
