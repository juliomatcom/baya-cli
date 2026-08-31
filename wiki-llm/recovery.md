# Progress, Failure & Recovery

> **Maintenance Invariant:** `state.json` schema, failure taxonomy, resume semantics. Any new `failure.kind` is added here AND to `src/executor/classify.ts` in the SAME commit. Schema changes bump `version`. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** On-disk progress tracking. What is recorded on failure. How a run resumes after a crash, an interrupt, or exhausted credits.

**Premise:** a run is expensive and interruptible — tasks cost credits, take minutes, die on quota/network/Ctrl+C. **No completed work is ever redone.** Every transition is checkpointed before it is acted on.

## `state.json`

`.baya/runs/<runId>/state.json`. Rewritten **atomically** (tmp → `rename`) after **every** transition — never appended, never partially written.

```json
{
  "version": 1,
  "run_id": "20260828T2152Z-a1f4c9",
  "status": "running | completed | paused | failed | interrupted",
  "started_at": "…",
  "updated_at": "…",
  "source": { "path": "tasks.md", "sha256": "9f2c…" },
  "manifest_path": ".baya/runs/…/manifest.json",
  "config_snapshot": {
    "planner": { "provider": "codex", "model": null },
    "defaults": { "provider": "codex", "model": null },
    "max_parallel": 4,
    "isolation": "shared",
    "memory": true,
    "memory_budget": 1200,
    "session_reuse": true
  },
  "totals": { "succeeded": 2, "failed": 1, "skipped": 2, "pending": 0, "cost_usd": 0.42 },
  "tasks": {
    "build-ui": {
      "state": "failed",
      "provider": "codex",
      "model": null,
      "session_id": "01a04a04-…",
      "attempts": 1,
      "started_at": "…",
      "ended_at": "…",
      "duration_ms": 8112,
      "exit_code": 1,
      "pid": 44119,
      "failure": {
        "kind": "quota",
        "message": "You have exceeded your monthly quota",
        "provider_code": "quota_exceeded",
        "status_code": 402,
        "retry": "later",
        "occurred_at": "…"
      },
      "artifacts": {
        "request": "tasks/build-ui/request.json",
        "result": "…",
        "events": "…",
        "stdout": "…",
        "stderr": "…"
      },
      "notes": [{ "severity": "warn", "message": "…" }],
      "files_changed": [],
      "cost_usd": 0.0,
      "input_tokens": 0,
      "cached_input_tokens": 0,
      "cache_write_input_tokens": 0,
      "output_tokens": 0,
      "result_rung": null,
      "blocked_by": null,
      "group_id": null
    }
  }
}
```

- `status` — `paused` when the run loop ends with `parked` tasks and nothing `failed`; `baya resume` reads it to know work is left. Any failure ⇒ `failed`, even alongside parked tasks. Set in `src/cli/run.ts`.
- `status: "paused"` did **not** bump `version`. "Schema changes bump `version`" means structural breaks — a renamed/removed/retyped field a reader misreads. Growing a closed enum is additive, like a new `failure.kind` (added without a bump). An older Baya hitting an unknown `status` fails `RunStateSchema` ⇒ the documented "malformed ⇒ report, stop" path, never a misread; a bump with no migration would strand every `version: 1` run.
- `config_snapshot` — a resume reproduces the original run's settings, not silently-changed config.
- `pid` — the child's process-group leader, checkpointed **before** the spawn so `baya doctor` can find a stray group after a crash.
- `attempts` — lifetime count of provider processes launched for this task; a `retry:"now"` retry and a resume each add one, neither resets it. `--retries` is a whole-run budget — a resume does **not** refill it.
- `blocked_by` — the failed ancestor that caused a `skipped` state.
- `result_rung` — which degradation-ladder rung produced the result (`protocol.md` §4).
- `cached_input_tokens` / `cache_write_input_tokens` — parts of `input_tokens`, kept apart because they are priced differently: a cache read costs about a tenth of fresh input, a write more than it. Fresh input is the remainder. **A single input figure is not a cost proxy** — collapsing the three made a run that cost 14% more read as 52% cheaper.
- `group_id` — the task group this one ran in (execution.md §Grouping): the id of the group's first task, or `null` for a process of its own. Cost and the event stream belong to the group, so usage sits on the first member and every member's `artifacts` name the same stream. A resume regroups from scratch; it never reconstructs a previous run's groups.

## One Baya per directory

On startup, `run`/`resume` take `.baya/baya.lock`, held for the process lifetime. A second Baya in the same directory is **refused**:

```
✗ another baya is already running in this directory
    pid 44119 · run 20260828T2152Z-a1f4c9 · started 3m ago
```

Refusing (not coordinating) removes an entire class of machinery: no cross-process write lock, no double-spend guard on resume, no reconciling two processes' views. A second `baya resume` of the same run cannot double-spend — it cannot start.

| Resource             | Guarantee                                                  |
| :------------------- | :--------------------------------------------------------- |
| Directory            | One `.baya/baya.lock`, held for the process lifetime.      |
| `runId`              | `<utc-timestamp>-<rand>-<pid>` — sortable + unique.        |
| Writers within a run | In-memory scheduler semaphore. No file lock — one process. |
| Config / plan cache  | Atomic `rename`; no torn file observable.                  |
| Logs                 | Per-run files.                                             |
| `.baya/` creation    | `mkdir` recursive; `EEXIST` is success.                    |

### Stale locks

Stale = heartbeat aged past threshold **AND** pid gone. A fresh heartbeat proves liveness — a live Baya is never displaced. Stale locks reclaimed with a logged warning.

**Accepted limitation:** OS pid-reuse onto an unrelated process ⇒ lock looks live indefinitely, delete by hand; `baya doctor` reports the path. Erring toward a stuck lock beats letting two Bayas loose. An unparseable lock file is never auto-removed — `doctor` names it for a human.

### ⚠️ `baya doctor` must not reap a live run

`doctor` reaps orphaned process groups from crashed runs. Reap only when `.baya/baya.lock` is stale by the rule above — **never on pid-liveness alone**. When in doubt, report and leave it.

### Two task lists against one repo

Not supported in-process. Use a user-level `git worktree` — a second checkout with its own `.baya/`, zero shared state:

```bash
git worktree add ../baya-feature-x feature-x
cd ../baya-feature-x && baya ./tasks.md
```

## Failure taxonomy

Normalized from real provider signals (verified 2026-08-28, `providers.md`). Classifier: `src/executor/classify.ts`.

| `kind`        | `retry`         | Detected from                                                                                                                                                                                                                                                      |
| :------------ | :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quota`       | `later`         | copilot `errorCode:"quota_exceeded"` / `402`; "quota"/"exhausted"/"credit" in text; a named allowance — `session`/`usage`/`weekly`/`daily` limit — or any "limit … resets …" phrasing (checked before `rate_limit`, gated on **not** matching a rate-limit signal) |
| `rate_limit`  | `later`         | HTTP 429, "rate limit", "overloaded", "too many requests", "try again in Ns"; opencode `isRetryable:true`. An OpenAI per-minute throttle ("Rate limit reached … tokens per min … rate-limits" URL) stays here, never `quota`                                       |
| `auth`        | `never`         | 401/403; opencode `error.kind:"auth"`; "api key"/"unauthorized"                                                                                                                                                                                                    |
| `network`     | `now`           | ECONNRESET / ETIMEDOUT / ENOTFOUND / "fetch failed"                                                                                                                                                                                                                |
| `timeout`     | `now`           | Baya's `max_runtime_s` exceeded                                                                                                                                                                                                                                    |
| `permission`  | `never`         | claude `permission_denials[]`; "denied permission"; `--allow`/`--dangerously` hints                                                                                                                                                                                |
| `schema`      | `now`           | result failed the degradation ladder ("unparseable"/"does not match task_result")                                                                                                                                                                                  |
| `crash`       | `now` / `never` | non-zero exit, no classified signal — `now` if adapter `retryable`, else `never`; a bad model name ("model not found"/"unrecognized model") ⇒ `never`                                                                                                              |
| `interrupted` | `now`           | SIGINT/SIGTERM teardown                                                                                                                                                                                                                                            |

**`retry:"later"`/`"never"` consume no in-run attempts.** A `quota` failure **halts the whole run** (execution.md §Failure semantics): admission stops, in-flight work drains, every unstarted task is `skipped`/`blocked_by` the quota task and carries its `failure`. `auth`/`permission` fail only their own task; independent branches continue. Either way the failure is recorded and the run stays resumable — tomorrow or, for `quota`, via `baya resume --provider`, costing nothing already paid.

## Resume

```bash
baya runs                               # list resumable runs + ids
baya resume <runId>                     # explicit
baya resume                             # pick from a list; no TTY ⇒ exit 2
baya resume <runId> --provider claude   # re-run unfinished work elsewhere
```

**`resume` never guesses.** Several runs can sit paused at once; picking "most recent" would resume the wrong one and spend real credits. No `runId` ⇒ picker; no TTY ⇒ exit `2`, points at `baya runs`.

- **Re-run:** `failed`, `skipped`, `parked`, and any `running`/`pending` left by a crash.
- **Kept:** every `succeeded` task + outputs, available as downstream context. Never re-run, never re-planned.
- `--provider` overrides the provider for re-run tasks only; their `model` resets to that provider's default — a model resolved for the old provider need not exist on the new one.
- Settings come from `config_snapshot`, not today's config. A flag passed to the `resume` invocation itself still wins.
- Regroups from scratch; previous groups are never reconstructed.

### A resume continues the original run, in the original directory

Same `runId`, same `.baya/runs/<runId>/`, same `state.json`: unfinished tasks go back to `pending` and run again; `attempts` counts up; the log appends; per-task usage **accumulates** across attempts, because a failed attempt cost money too.

Rejected alternative — a new run directory linked to the old one. A succeeded task's `result.json` + `output.md` **are** the upstream context a re-run task is handed, addressed relative to the run directory; a second directory means copying them forward or teaching every reader about a chain of runs, and it splits one logical run's cost across two `baya runs` rows. One run, one directory, one cost total.

Code: `src/cli/resume.ts` (shell) · `src/executor/resume.ts` (`resumeTargets`/`resumeReset`, pure) · `src/ui/run-picker.ts` (`buildRunChoices` pure + a thin `select`).

### Recovery prompt `M2.9`

Not built yet — `baya resume <runId>` re-runs every unfinished task without asking. Planned: open with the run's state, then actions ordered by `failure.kind`:

```
Run 20260828T2152Z-a1f4c9 · tasks.md · interrupted 4m ago

  ✓ design-api   codex  succeeded  12.4s
  ✗ build-ui     codex  failed     quota exceeded (402)
  ⊘ write-tests  codex  skipped    depends on build-ui

  build-ui failed: You have exceeded your monthly quota
  log: .baya/runs/…/tasks/build-ui/stderr.log

? How would you like to continue?
❯ Retry on a different provider…   (claude, opencode)
  Retry on codex
  Skip build-ui and its dependents
  Abort
```

`quota`/`auth` ⇒ "different provider" leads. `rate_limit`/`network`/`timeout`/`schema` ⇒ plain retry leads. Never present a first option that cannot work.

### Guards

| Situation                                     | Behavior                                                                                                                                            |
| :-------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks.md` changed (`source.sha256` mismatch) | Warn, then run the manifest stored with the run — never silently, and never re-planned: re-planning mid-run would invalidate work already paid for. |
| Another Baya running here                     | Directory lock refuses at startup — a second resume cannot double-spend.                                                                            |
| Not a TTY                                     | No prompt. With a `runId`, resume runs unattended; without one, exit `2` and point at `baya runs`.                                                  |
| `state.json` unreadable / malformed           | Report the file, stop. Never silently start a fresh run.                                                                                            |

## Progress display

`ora` v9 (ESM), via `src/ui/progress.ts`.

| Rule                                                                        | Reason                                                                                        |
| :-------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| Spinner → **stderr** (ora default)                                          | Keeps stdout a clean JSON document for `--json \| jq`.                                        |
| Disabled for non-TTY / `--json` / `NO_COLOR` / `--no-progress`              | Spinner frames in a log or pipe are noise.                                                    |
| **Stopped before any prompt**                                               | A live spinner + a prompt corrupt each other.                                                 |
| **Cursor restored on every exit path** (SIGINT/SIGTERM/`uncaughtException`) | ora hides the cursor; a hard exit without cleanup leaves the terminal with no visible cursor. |
| All persistent output through `progress.ts`                                 | Writing straight to stderr while ora spins garbles the line.                                  |

⚠️ **ora is single-line, does not multiplex.** Fits M1 (sequential). At M2 parallelism: render one aggregate line (`▸ 3 running · 5 done · 12 pending`) or move to `log-update`. Never N concurrent ora instances.
