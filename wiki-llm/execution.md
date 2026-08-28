# Execution

> **Maintenance Invariant:** Runtime semantics only. Items tagged `later` are out of v1 — do not implement them without moving the tag. Update in the SAME commit as any scheduler, lock, or signal change.
> **Answers:** How are tasks scheduled and parallelized? What happens on failure, on a question, on Ctrl+C? How is the working tree protected from concurrent writers?

## Scheduler

Loop: compute ready-set (all `depends_on` `succeeded`) → admit tasks while **global budget** *and* **per-provider budget** *and* the **writer semaphore** allow → spawn → on completion, re-evaluate. Terminates when no task is `running` or `parked` and the ready-set is empty.

| Budget | Source | Default |
| :-- | :-- | :-- |
| Global | `--max-parallel` | `min(4, cpus)` |
| Per-provider | adapter `capabilities.maxConcurrency` | `codex` 2 · `opencode` 2 · `claude` 1 · `copilot` 1 |

Per-provider caps default conservative because these run on **consumer subscriptions**, which throttle. The original spec's "parallelize everything" conflicts with its own "subscription-friendly" goal; the caps are where that conflict is resolved. Raise them via `.baya/config.json` once measured.

## Workspace isolation

**v1 — `--isolation shared` (default).** Read-only tasks (`writes: false`) run fully parallel. Any `writes: true` task takes the **single-writer semaphore**, so writers serialize against each other while readers continue.

The lock is an **in-memory semaphore in the scheduler** — nothing on disk. Only one Baya runs per directory ([recovery.md](recovery.md)), so there is no second process to coordinate with, and a file lock here would be machinery without a job.

**`later` — `--isolation worktree`.** One `git worktree add .baya/wt/<id>` per writing task for true parallel writes, plus an end-of-run merge/report step. Deferred: conflict resolution is a large surface and buys nothing until write-parallelism is a measured bottleneck. Note that a *user-level* worktree already covers the "two task lists, one repo" case with none of that machinery ([recovery.md](recovery.md)).

> Without this, two agents editing the same repo clobber each other and runs stop being reproducible. The original spec mandated parallelism and never addressed it.

## Permissions

Baya never guesses. Task policy → adapter mapping: `writes: false` ⇒ read-only (`codex -s read-only`); `writes: true` ⇒ workspace-write (`codex -s workspace-write`). Full bypass requires an explicit `--dangerously-allow-all` on the `baya` invocation and is **never inferred from the Markdown**.

## Context bus

Upstream results persist to `tasks/<id>/result.json` and `output.md`. A downstream `task_request.context[]` entry always carries `summary` + absolute paths; `inline` carries the text only when it fits.

| `--context-strategy` | Behavior |
| :-- | :-- |
| `link-only` (**default**) | `summary` + paths. Agent reads the file if it needs detail. |
| `truncate` | Inline head+tail to the per-edge budget, with an elision marker. |
| `summarize` `later` | LLM-compress upstream output before injection. |

Budgets: `--context-budget` 12000 chars total, 6000 per edge.

> **Why link-only is the default.** These providers are *agentic* — they open files. A path costs ~40 tokens and is unbounded; inlining 40 KB costs ~10k tokens and still truncates. Inline when small, link when not. A fan-in of five 40 KB upstreams is the case that breaks naive prepending.

## Failure semantics

| Concern | Behavior |
| :-- | :-- |
| Task fails | Its **descendants** become `skipped` — never `failed`. Independent branches continue. |
| `--on-error stop` | Stop admitting new tasks; let in-flight tasks finish; then report. |
| Retries | `--retries` (default 1), for `retry: "now"` failures only. **`quota` and `auth` are `retry: "later"` and never consume attempts** — backoff cannot refill credits. Exponential backoff + jitter. See the taxonomy in [recovery.md](recovery.md). |
| Provider exhausted | On a `quota` failure, stop scheduling further tasks **for that provider**; other providers' branches continue; the run stays resumable, optionally on a different provider. |
| Timeout | `constraints.max_runtime_s` (default 900). Exceeded ⇒ group teardown, `status: failed`, `retryable: true`. |

Exit codes: `0` all succeeded · `1` any failed · `2` planner/validation error · `130` SIGINT.

## Escalation — Pause & Resume

Replaces the original spec's live TTY bubbling, which is unimplementable: headless CLIs are built to **never** ask mid-run, resolve permissions up-front via flags, and emit an event stream rather than a REPL. There is no stdin channel to answer into.

1. Provider returns `status: "needs_input"` with `question.text`.
2. Node → `parked`. **Independent branches keep running.**
3. Questions enter a **serialized prompt queue** — exactly one owns stdin at a time. Render task id, provider, title, question, options.
4. On answer, resume that provider's **own session** (`codex exec resume <id>`, `claude --resume <id>`, `copilot --resume=<id>`, `opencode run -s <id>`) with a `task_request` whose context carries the answer.
   **Session ids:** `claude` and `copilot` accept a **pre-assigned** `--session-id <uuid>`, so Baya knows the id before the process starts and resume never depends on parsing. `codex` (`thread_id`) and `opencode` (`sessionID`) must be captured from `ProviderEvent {t:'session'}`.
   **Disable the provider's own question tool** where one exists — `copilot --no-ask-user`. An agent that blocks on an interactive prompt defeats the design; a question must return as `status:"needs_input"` in the result JSON.
5. `resume: 'none'` providers ⇒ **cold resume**: re-run with question+answer appended to context. `later`.

Non-TTY (`--on-input`): `ask` (default; errors immediately if stdin is not a TTY) · `fail` · `skip` · `default` (use `question.default`). **`--yes` auto-confirms the plan gate only — it never answers a task question.**

Out of scope permanently: PTY multiplexing, keystroke injection, alternate-buffer scraping.

## Interrupts

Every spawn sets `stdin` explicitly (prompt pipe or `/dev/null`) — inherited stdin makes `claude -p` block 3 s per task and emit a warning. Children spawn `detached: true` in their own process group — Node's `child_process` does not kill grandchildren, and agentic CLIs spawn their own subprocesses.

SIGINT → `process.kill(-pgid, 'SIGTERM')` for every live group → 5 s grace → `SIGKILL` → checkpoint → exit `130`. **Second Ctrl+C kills immediately.** Same path for SIGTERM/SIGHUP/`uncaughtException`. Live pids are checkpointed so a later `baya doctor` can reap strays.

## Run state

`runs/<runId>/state.json` is rewritten **atomically** (write tmp, `rename`) after every state transition, holding task states, pids, session ids, timings, cost, and a normalized `failure` record.

**`baya resume` and `baya runs` are v1.** Full schema, failure taxonomy, and the recovery prompt: **[recovery.md](recovery.md)**.
