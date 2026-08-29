# Execution

> **Maintenance Invariant:** Runtime semantics only. `later` items are out of v1 — do not implement without moving the tag. Update in the SAME commit as any scheduler, lock, or signal change. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** Task scheduling + parallelism. Failure, question, Ctrl+C behavior. Writer protection.

## Scheduler

Loop: compute ready-set (all `depends_on` `succeeded`) → admit while **global budget** AND **per-provider budget** AND the **writer semaphore** allow → spawn → on completion re-evaluate. Terminates when nothing is `running`/`parked` and the ready-set is empty. Sequential today (parallel = M2.1).

| Budget       | Source                                | Default                                             |
| :----------- | :------------------------------------ | :-------------------------------------------------- |
| Global       | `--max-parallel`                      | `min(4, cpus)`                                      |
| Per-provider | adapter `capabilities.maxConcurrency` | `codex` 2 · `opencode` 2 · `claude` 1 · `copilot` 1 |

Per-provider caps conservative — consumer subscriptions throttle. Raise via `.baya/config.json` once measured.

## Workspace isolation

**v1 — `--isolation shared` (default).** `access:"read-only"` tasks run fully parallel. Any `access:"read-write"` task takes the **single-writer semaphore** — writers serialize against each other, readers continue.

Semaphore is **in-memory in the scheduler**, nothing on disk — one Baya per directory ([recovery.md](recovery.md)) means no second process to coordinate with.

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

## Memory

The context bus follows **edges**. Two tasks in different branches share none, so both pay to rediscover the same repo facts. Memory is the **edgeless** channel: derived facts fan out to every later task regardless of the graph.

**Derived only — never self-reported.** No `learnings[]` field on `task_result`. Every fact is read back out of a record the provider already wrote, so producing memory costs **zero tokens** and nothing in it can be hallucinated. Delivery costs ~1200 chars (~300 tokens) per prompt.

Pipeline: adapter `extractObservations` → `Observation[]` → `deriveMemory` (pure) → `MemoryEntry[]` → `renderMemory` (pure) → one `# Known about this workspace` section in the prompt, placed with `# Workspace` (memory is workspace knowledge; `# Upstream results` means edges). Snapshot per run at `runs/<runId>/memory.json`.

| Observation source           | Provider              | Read from                                                                                                |
| :--------------------------- | :-------------------- | :------------------------------------------------------------------------------------------------------- |
| `observations: "events"`     | `codex`               | Baya's own `events.jsonl` — `command_execution{command,exit_code,status}`, `file_change{changes[].path}` |
| `observations: "transcript"` | `claude`              | `~/.claude/projects/*/<session-id>.jsonl` — `tool_use` Bash/Read/Edit + `tool_result.is_error`           |
| `observations: "none"`       | `copilot`, `opencode` | nothing yet — consume memory, contribute none                                                            |

⚠️ `claude --output-format json` prints **one object**, so `parseEvents` can never emit `tool` events. The transcript is the only source, and is richer than codex's: `Read` names a `file_path` outright where codex leaves it inside a `sed -n '1,220p' …` string. Located by globbing the pre-assigned session id, **never** by reproducing the cwd-slug escaping. Chosen over `--output-format stream-json --verbose` because it is additive and leaves the `extractResult` ladder untouched. A missing transcript thins memory; it never fails a task.

Fact kinds, in value-per-token order — the budget is spent in this order, after every kind is guaranteed 2 items:

| Kind               | Why it earns prompt space                                                                                                  |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `command.deadend`  | Failed and never later succeeded. Most expensive thing to rediscover: rediscovering it means paying for the failure again. |
| `command.verified` | Exit 0. Stops the "how do I check this" probe.                                                                             |
| `file.changed`     | **Correctness**, not just cost — a later task must know what was already edited.                                           |
| `file.hot`         | Read by ≥2 tasks. Kills the orientation phase.                                                                             |

Keyed (`command:<cmd>` / `file:<path>`), so a later fact **replaces** an earlier one instead of appending a contradiction. Exploration commands (`sed`, `rg`, `git`, `env`, …) contribute paths only — `rg` exits 1 on "no matches", which is not a dead end. Caps: 6 items per kind, 120 chars per command. Both measured: without them, one task flailing through variations of one invocation produced 14 dead ends and crowded out every other kind.

⚠️ **A command that never executed is not a dead end.** Measured 2026-08-29: claude's `--permission-mode auto` denied `npm test`, memory filed it under "Commands that FAILED (do not repeat them)", and the next task read that and refused to try — "the previous attempt to run this command already failed". By the fourth task the block held five dead ends, none of which had ever run: a survivable permission warning became a cascading run failure. A task reporting `permission_denials` therefore contributes no **failed** command facts; its successes and its file facts stand, since a denial cannot produce a success. Any new observation source must answer the same question before it emits a dead end.

**Never carries command output** (`aggregated_output`, `tool_result.content`). It is most of the bytes and the only route by which untrusted repository text could enter memory. The block is framed as evidence, not instruction.

Flags: `--no-memory` (off, for A/B measurement) · `--memory-budget <chars>` (default 1200).

## Session reuse

Every task otherwise spawns a fresh process and re-pays the fixed startup cost. **Chain-collapse:** a task whose **single** dependency left a warm session on the **same provider and model** runs as another turn in it (`claude --resume`, `codex exec resume`) via the adapter's `buildContinue`.

Only chains, never siblings: a chain is already serial, so collapsing costs **zero** concurrency. Grouping siblings would cost it.

| Guard                       | Value                     | Why                                                                                                                                                                                      |
| :-------------------------- | :------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| single dependency           | —                         | A fan-in has no one conversation to rejoin.                                                                                                                                              |
| same provider **and** model | —                         | A session belongs to one model. This is where per-task model routing and session reuse genuinely conflict; routing wins by construction, and the chain partitions at every model change. |
| warm                        | `SESSION_WARM_MS` 300 000 | The session file outlives the prompt cache (5 min). Past it, a resume re-reads the whole grown transcript at full price — **more** than the cold start it replaced.                      |
| turn cap                    | `MAX_CHAIN_TURNS` 5       | Every turn pays ~10% of an only-growing transcript.                                                                                                                                      |
| unclaimed                   | —                         | Two tasks continuing one session would fork it.                                                                                                                                          |
| `buildContinue` present     | —                         | An adapter without one never joins a chain. Honest default for an unexercised resume path.                                                                                               |

Scheduling: among tasks **already in the ready-set**, a warm continuation jumps the queue. This never widens the ready-set, so dependency order is untouched — `readySet` has already established every candidate may run in any order. Cost: execution order within a layer is no longer manifest order.

Context and memory are suppressed for what is already in the session — an upstream the agent produced itself is pointed at, not re-inlined.

The cold-retry fallback earned its place on the first real chain run: a continuation that exits non-zero with nothing parseable — structurally distinct from a task that ran and reported failure through the schema at exit 0 — is retried **cold once**. codex rejected every resume because `exec resume` takes a different flag set (providers.md §codex), and the fallback turned two broken invocations into two wasted, unbilled spawns instead of two lost tasks. Keep it even now the flags are right: it is the only thing standing between a provider's CLI drifting and a run losing work.

Flag: `--no-session-reuse`.

## Failure semantics

| Concern            | Behavior                                                                                                                                                                                                                       |
| :----------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task fails         | **Descendants** ⇒ `skipped`, never `failed`. Independent branches continue.                                                                                                                                                    |
| `--on-error stop`  | Stop admitting new tasks; let in-flight finish; then report.                                                                                                                                                                   |
| Retries            | `--retries` (default 1), `retry:"now"` failures only. **`quota`/`rate_limit` ⇒ `retry:"later"`, `auth`/`permission` ⇒ `"never"` — none consume attempts.** Exponential backoff + jitter. Taxonomy: [recovery.md](recovery.md). |
| Provider exhausted | `quota` failure ⇒ stop scheduling **for that provider**; other providers' branches continue; run stays resumable, optionally elsewhere.                                                                                        |
| Timeout            | `constraints.max_runtime_s` (default 900) ⇒ group teardown, `status:failed`, `retryable:true`.                                                                                                                                 |

Exit: `0` all succeeded · `1` any failed/skipped/parked · `2` planner/validation/model-gate error · `130` SIGINT.

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

SIGINT → `process.kill(-pgid,'SIGTERM')` for every live group → 5s grace → `SIGKILL` → checkpoint → exit `130`. **Second Ctrl+C kills immediately.** Same path for SIGTERM/SIGHUP/`uncaughtException`. Live pids checkpointed so a later `baya doctor` can reap strays.

## Run state

`runs/<runId>/state.json` rewritten **atomically** (tmp + `rename`) after every transition — task states, pids, session ids, timings, cost, normalized `failure` record. `state.json` is written **before** an action, never after.

`baya resume` / `baya runs` are v1 (M2.8). Full schema, failure taxonomy, recovery prompt: **[recovery.md](recovery.md)**.
