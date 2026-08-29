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

**v1 — `--isolation shared` (default).** `writes:false` tasks run fully parallel. Any `writes:true` task takes the **single-writer semaphore** — writers serialize against each other, readers continue.

Semaphore is **in-memory in the scheduler**, nothing on disk — one Baya per directory ([recovery.md](recovery.md)) means no second process to coordinate with.

**`later` — `--isolation worktree`.** `git worktree add .baya/wt/<id>` per writing task for true parallel writes + end-of-run merge/report. Deferred until write-parallelism is a measured bottleneck. A user-level worktree already covers "two task lists, one repo".

## Permissions

Never guessed. Task policy → adapter mapping: `writes:false` ⇒ read-only; `writes:true` ⇒ workspace-write. Full bypass requires explicit `--dangerously-allow-all` on the `baya` invocation — **never inferred from Markdown**. Per-adapter flags: `providers.md`.

## Context bus

Upstream results persist to `tasks/<id>/result.json` + `output.md`. A downstream `task_request.context[]` entry always carries `summary` + absolute paths; `inline` carries text only when it fits.

| `--context-strategy`      | Behavior                                                         |
| :------------------------ | :--------------------------------------------------------------- |
| `link-only` (**default**) | `summary` + paths. Agent reads the file for detail.              |
| `truncate`                | Inline head+tail to the per-edge budget, with an elision marker. |
| `summarize` `later`       | LLM-compress upstream output before injection.                   |

Budgets: `--context-budget` 12000 chars total, 6000 per edge. `link-only` default: these providers are agentic and open files; a path costs ~40 tokens (unbounded), inlining 40 KB costs ~10k and still truncates. Fan-in of five 40 KB upstreams is the breaking case for naive prepending.

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
