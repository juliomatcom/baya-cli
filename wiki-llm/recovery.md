# Progress, Failure & Recovery

> **Maintenance Invariant:** `state.json` schema, failure taxonomy, and resume semantics. Any new `failure.kind` is added here and to the classifier in the SAME commit. Schema changes bump `version`.
> **Answers:** How is progress tracked on disk? What exactly is recorded when a task fails? How does a run resume after a crash, an interrupt, or exhausted credits?

**Premise: a run is expensive and interruptible.** Tasks cost real credits, take minutes, and die on quota limits, network faults, and Ctrl+C. **No completed work is ever redone.** Every state transition is checkpointed before it is acted on.

## `state.json`

At `.baya/runs/<runId>/state.json`. Rewritten **atomically** (write tmp → `rename`) after **every** transition — never appended to, never partially written.

```json
{
  "version": 1,
  "run_id": "20260828T2152Z-a1f4c9",
  "status": "running | completed | failed | interrupted",
  "started_at": "2026-08-28T21:52:03Z",
  "updated_at": "2026-08-28T21:56:41Z",
  "source": { "path": "tasks.md", "sha256": "9f2c…" },
  "manifest_path": ".baya/runs/20260828T2152Z-a1f4c9/manifest.json",
  "config_snapshot": { "planner": { "provider": "codex", "model": null },
                       "defaults": { "provider": "codex", "model": null },
                       "max_parallel": 4, "isolation": "shared" },
  "totals": { "succeeded": 2, "failed": 1, "skipped": 2, "pending": 0, "cost_usd": 0.42 },
  "tasks": {
    "build-ui": {
      "state": "failed",
      "provider": "codex", "model": null,
      "session_id": "01a04a04-b8a5-7ae0-80ea-697cf3b65066",
      "attempts": 1,
      "started_at": "…", "ended_at": "…", "duration_ms": 8112,
      "exit_code": 1,
      "failure": {
        "kind": "quota",
        "message": "You have exceeded your monthly quota",
        "provider_code": "quota_exceeded",
        "status_code": 402,
        "retry": "later",
        "occurred_at": "2026-08-28T21:56:41Z"
      },
      "artifacts": { "request": "tasks/build-ui/request.json",
                     "result":  "tasks/build-ui/result.json",
                     "events":  "tasks/build-ui/events.jsonl",
                     "stdout":  "tasks/build-ui/stdout.log",
                     "stderr":  "tasks/build-ui/stderr.log" },
      "notes": [ { "severity": "warn", "message": "…" } ],
      "files_changed": [], "cost_usd": 0.0
    }
  }
}
```

`config_snapshot` makes a resume reproduce the original run's settings rather than silently picking up changed config.

## One Baya per directory

**A working tree hosts at most one Baya at a time.** On startup, `run` and `resume` take `.baya/baya.lock` and hold it for the process lifetime. A second Baya in the same directory is refused outright:

```
✗ another baya is already running in this directory
    pid 44119 · run 20260828T2152Z-a1f4c9 · started 3m ago
```

> **Why refuse rather than coordinate.** Two Bayas in one tree means two sets of agents editing the same files. That is a state to prevent, not to support. Refusing costs a use case nobody wants and removes an entire class of machinery: no cross-process write lock, no double-spend guard on resume, no reconciling two processes' views of the same run.

This also collapses several guarantees into one. A second `baya resume` of the same run cannot double-spend credits, because it cannot start at all.

| Resource | Guarantee |
| :-- | :-- |
| **Directory** | One `.baya/baya.lock`, held for the process lifetime. |
| **`runId`** | `<utc-timestamp>-<rand>-<pid>` — sortable and unique. |
| **Writers within a run** | Serialized by an **in-memory semaphore in the scheduler**. No file lock: there is only one process, so there is nothing to coordinate across. |
| **Config / plan cache** | Atomic `rename`; no torn file is ever observable. |
| **Logs** | Per-run files. |
| **`.baya/` creation** | `mkdir` recursive; `EEXIST` is success. |

### Stale locks

This is the part that earns its keep: a crashed Baya leaves its lock behind, and the next run must reclaim it rather than wedging the repo forever.

A lock is stale when its heartbeat has aged past threshold **and** its pid is gone. A fresh heartbeat alone proves liveness, so a live Baya is never displaced. Stale locks are reclaimed with a logged warning.

**Accepted limitation:** if the OS recycles a crashed holder's pid onto an unrelated process, the lock looks live indefinitely and must be deleted by hand. `baya doctor` reports the path. Erring toward a stuck lock is the right trade — the opposite error lets two Bayas loose in one tree.

An unparseable lock file is never removed automatically; we cannot tell whether its holder lives. `doctor` names the file for a human to delete.

### ⚠️ `baya doctor` must not reap a live run

`doctor` reaps orphaned process groups left by crashed runs. **A naive implementation would kill a running Baya's children.** Reap only when `.baya/baya.lock` is stale by the rule above — never on pid-liveness alone. When in doubt, report and leave it.

### Running two task lists against one repo

Not supported in-process, and deliberately so. The answer is isolation at the *user* level: a second `git worktree` is a second checkout with its own `.baya/`, so two Bayas share no state at all.

```bash
git worktree add ../baya-feature-x feature-x
cd ../baya-feature-x && baya ./tasks.md
```

Worth keeping in mind if per-task write parallelism is ever revisited (`--isolation worktree`, still `later` in `execution.md`): a user-level worktree already delivers most of the benefit with none of the merge machinery.

## Failure taxonomy

Normalized from signals each provider actually emits (verified 2026-08-28 — see `providers.md`).

| `kind` | `retry` | Detected from |
| :-- | :-- | :-- |
| `quota` | `later` | copilot `errorCode:"quota_exceeded"` / `statusCode:402`; provider text |
| `rate_limit` | `now` | HTTP 429; provider rate-limit events |
| `auth` | `never` | opencode `statusCode:401` + `isRetryable:false`; login errors |
| `network` | `now` | connection reset, DNS, timeout to provider |
| `timeout` | `now` | Baya's own `max_runtime_s` exceeded |
| `permission` | `never` | claude `permission_denials[]`; sandbox refusal |
| `schema` | `now` | result failed the degradation ladder (`protocol.md` §4) |
| `crash` | `now` | non-zero exit with no classified signal |
| `interrupted` | `now` | SIGINT/SIGTERM teardown |

### `retry: "later"` is the important one

**Retrying an exhausted quota is pointless — backoff cannot fix it.** So `quota` and `auth` never consume in-run retry attempts. Instead Baya records the failure, stops scheduling further tasks for **that provider**, lets other providers' branches finish, and leaves the run resumable.

This is exactly the "no more credits" case: the run stops cleanly, everything finished is kept, and resuming tomorrow — or **on a different provider** — costs nothing already paid for.

## Resume

```bash
baya runs                               # list resumable runs and their ids
baya resume <runId>                     # the explicit form
baya resume                             # pick from a list of resumable runs
baya resume <runId> --provider claude   # re-run the unfinished work elsewhere
baya resume <runId> --yes               # non-interactive: retry all retryable, skip the rest
```

**`resume` never guesses which run you meant.** Several runs can sit paused at once — a quota stop from yesterday, an interrupt from an hour ago — and silently picking "the most recent" would resume the wrong one and spend real credits doing it. With no `runId`, resume shows a picker; with no TTY, it exits `2` and tells you to run `baya runs`.

**Re-run:** `failed`, `skipped`, `parked`, and any `running`/`pending` left behind by a crash.
**Kept:** every `succeeded` task, including its outputs, which stay available as downstream context.

`--provider` overrides the provider for re-run tasks only — the direct answer to a provider running out of credits mid-run.

### The recovery prompt

`baya resume` opens with the run's state, then offers actions ordered by what the failure kind makes sensible:

```
Run 20260828T2152Z-a1f4c9 · tasks.md · interrupted 4m ago

  ✓ design-api     codex   succeeded   12.4s
  ✓ gen-schema     codex   succeeded    8.1s
  ✗ build-ui       codex   failed      quota exceeded (402)
  ⊘ write-tests    codex   skipped     depends on build-ui
  ⊘ integrate      codex   skipped     depends on build-ui

  2 succeeded · 1 failed · 2 skipped · $0.42

  build-ui failed: You have exceeded your monthly quota
  log: .baya/runs/20260828T2152Z-a1f4c9/tasks/build-ui/stderr.log

? How would you like to continue?
❯ Retry on a different provider…      (claude, opencode)
  Retry on codex
  Skip build-ui and its dependents
  Abort
```

**Option order follows `failure.kind`.** For `quota` and `auth`, "different provider" leads — retrying the same one is known-futile. For `rate_limit`, `network`, `timeout`, and `schema`, plain retry leads. Never present a first option that cannot work.

### Guards

| Situation | Behavior |
| :-- | :-- |
| `tasks.md` changed since the run (`source.sha256` mismatch) | Warn that the stored plan is stale; offer *re-plan* / *continue with stored manifest* / *abort*. Never silently execute a stale plan. |
| Another Baya is running here | The directory lock refuses it at startup, so a second resume cannot double-spend credits. |
| Not a TTY | No prompt. `--yes` retries everything retryable and skips the rest; without it, exit `2`. |
| `state.json` unreadable or malformed | Report the file and stop. Never silently start a fresh run — that would re-spend money already spent. |

## Progress display

**`ora`** (v9, ESM) drives the working animation.

| Rule | Why |
| :-- | :-- |
| Spinner writes to **stderr** (ora's default) | Keeps stdout a clean JSON document for `--json \| jq`. |
| Disabled when not a TTY, under `--json`, or with `NO_COLOR` | Spinner frames in a log file or a pipe are noise. |
| **Stopped before any prompt** | A live spinner and an inquirer prompt on the same terminal corrupt each other. |
| **Cursor restored on every exit path** — SIGINT, SIGTERM, `uncaughtException` | ora hides the cursor; a hard exit without cleanup leaves the user's terminal with **no visible cursor**. Restore it in the signal handler, not only on the happy path. |

> ⚠️ **ora is single-line and does not multiplex.** It fits M1, which is sequential. When M2 introduces parallelism, either render one aggregate line (`▸ 3 running · 5 done · 12 pending`) or move the status block to `log-update`. Do not attempt N concurrent ora instances — they fight over the same terminal line.
