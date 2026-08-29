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
  "status": "running | completed | failed | interrupted",
  "started_at": "…",
  "updated_at": "…",
  "source": { "path": "tasks.md", "sha256": "9f2c…" },
  "manifest_path": ".baya/runs/…/manifest.json",
  "config_snapshot": {
    "planner": { "provider": "codex", "model": null },
    "defaults": { "provider": "codex", "model": null },
    "max_parallel": 4,
    "isolation": "shared"
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
      "result_rung": null,
      "blocked_by": null
    }
  }
}
```

- `config_snapshot` — a resume reproduces the original run's settings, not silently-changed config.
- `pid` — the child's process-group leader, checkpointed **before** the spawn so `baya doctor` can find a stray group after a crash.
- `blocked_by` — the failed ancestor that caused a `skipped` state.
- `result_rung` — which degradation-ladder rung produced the result (`protocol.md` §4).

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

| `kind`        | `retry`         | Detected from                                                                                                                                         |
| :------------ | :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quota`       | `later`         | copilot `errorCode:"quota_exceeded"` / `402`; "quota"/"exhausted"/"credit" in text                                                                    |
| `rate_limit`  | `later`         | HTTP 429, "overloaded"; opencode `isRetryable:true`                                                                                                   |
| `auth`        | `never`         | 401/403; opencode `error.kind:"auth"`; "api key"/"unauthorized"                                                                                       |
| `network`     | `now`           | ECONNRESET / ETIMEDOUT / ENOTFOUND / "fetch failed"                                                                                                   |
| `timeout`     | `now`           | Baya's `max_runtime_s` exceeded                                                                                                                       |
| `permission`  | `never`         | claude `permission_denials[]`; "denied permission"; `--allow`/`--dangerously` hints                                                                   |
| `schema`      | `now`           | result failed the degradation ladder ("unparseable"/"does not match task_result")                                                                     |
| `crash`       | `now` / `never` | non-zero exit, no classified signal — `now` if adapter `retryable`, else `never`; a bad model name ("model not found"/"unrecognized model") ⇒ `never` |
| `interrupted` | `now`           | SIGINT/SIGTERM teardown                                                                                                                               |

**`retry:"later"` — `quota`/`auth` consume no in-run attempts.** Baya records the failure, stops scheduling for **that provider**, lets other providers' branches finish, leaves the run resumable — tomorrow or on a different provider, costing nothing already paid.

## Resume

```bash
baya runs                               # list resumable runs + ids
baya resume <runId>                     # explicit
baya resume                             # pick from a list
baya resume <runId> --provider claude   # re-run unfinished work elsewhere
baya resume <runId> --yes               # non-interactive: retry all retryable, skip the rest
```

**`resume` never guesses.** Several runs can sit paused at once; picking "most recent" would resume the wrong one and spend real credits. No `runId` ⇒ picker; no TTY ⇒ exit `2`, points at `baya runs`.

- **Re-run:** `failed`, `skipped`, `parked`, and any `running`/`pending` left by a crash.
- **Kept:** every `succeeded` task + outputs, available as downstream context.
- `--provider` overrides the provider for re-run tasks only.

### Recovery prompt

Opens with the run's state, then actions ordered by `failure.kind`:

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

| Situation                                     | Behavior                                                                                                        |
| :-------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `tasks.md` changed (`source.sha256` mismatch) | Warn plan is stale; offer re-plan / continue with stored manifest / abort. Never silently execute a stale plan. |
| Another Baya running here                     | Directory lock refuses at startup — a second resume cannot double-spend.                                        |
| Not a TTY                                     | No prompt. `--yes` retries everything retryable + skips the rest; else exit `2`.                                |
| `state.json` unreadable / malformed           | Report the file, stop. Never silently start a fresh run.                                                        |

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
