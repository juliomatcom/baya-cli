# Logging

> **Maintenance Invariant:** The event vocabulary is a contract. Adding an emit site adds its event name to the table below in the SAME commit. Names are `noun.verb`, past tense, never renamed once shipped.
> **Answers:** What does Baya record about its own behavior, where does it go, and what is the full event vocabulary?

**Every internal move is logged.** Reading the Markdown, calling the planner, spawning a CLI, each normalized provider event, every state transition, every signal. If Baya did it, there is a line for it.

## Two sinks, different volumes

| Sink | Level | Format | Purpose |
| :-- | :-- | :-- | :-- |
| `.baya/runs/<runId>/baya.jsonl` | **`trace` — everything** | JSONL | Forensics. Nothing is filtered out here. |
| stderr | `info` (`--log-level`; `--verbose` ⇒ `debug`, `--quiet` ⇒ `warn`) | rendered via `src/ui/theme.ts` | A readable narrative while it works, **including live provider output**. |

The file always gets the full stream. The terminal gets a filtered view. That is how "log every internal move" coexists with a usable display.

**Never stdout** — stdout carries only the `--json` report, so `baya … --json | jq` stays valid.

This is distinct from the per-task `events.jsonl`, which holds *provider transport* events. `baya.jsonl` is the orchestrator's own reasoning.

## Line shape

```json
{ "ts": "2026-08-28T21:52:04.118Z", "level": "info", "event": "task.spawned",
  "run_id": "20260828T2152Z-a1f4c9-3182", "task_id": "gen-schema",
  "provider": "codex", "pid": 44119, "pgid": 44119,
  "delivery": "stdin", "argv": ["codex","exec","-","--json","--output-schema","…"],
  "prompt_bytes": 12043, "request": "tasks/gen-schema/request.json" }
```

Every line carries **`run_id`**, so concurrent Baya processes stay distinguishable when logs are read together.

**Redaction is mandatory** (`conventions.md` §9): secret-shaped strings are scrubbed, and a prompt is never inlined into `argv` — it is elided to `prompt_bytes` with a pointer to `request.json`. Logs are pasted into issues; prompts contain source code.

## Event vocabulary

### Startup
`cli.invoked` (argv, cwd, version) · `config.loaded` (per-key source layer) · `config.wizard.started` · `config.wizard.completed` · `provider.resolved` (id, bin, version) · `provider.missing`

### Planning
`source.read` (path, bytes, sha256) · `plan.cache.hit` · `plan.requested` (planner provider/model) · `plan.received` (bytes, duration_ms) · `plan.validation.failed` (errors) · `plan.repair.attempted` (n) · `plan.fallback.linear` · `plan.validated` (tasks, edges) · `graph.ordered` (layers) · `plan.confirmed` · `plan.rejected`

### Scheduling
`run.created` (run_id, source) · `run.started` · `task.ready` (deps met) · `task.queued` (blocked on budget or lock) · `lock.waited` · `lock.acquired` · `lock.released` · `task.context.assembled` (upstream ids, strategy, bytes, inline vs link)

### Execution
`task.request.written` (path, bytes) · `task.spawned` (provider, argv, pid, pgid, delivery) · **`provider.text`** · **`provider.tool`** · **`provider.stderr`** · `provider.session` (`debug`) · `provider.event.unknown` (`debug`) · `task.result.parsed` (**which rung of the degradation ladder was used**) · `task.note` (severity, message — one per `notes[]` entry) · `task.succeeded` (duration, cost, files_changed, note_count) · `task.failed` (kind, retry class, exit code) · `task.parked` (question) · `task.skipped` (blocking ancestor) · `task.retried` (attempt, backoff_ms) · `task.timeout`

## Provider output bubbles up as `info`

**Everything a provider CLI emits reaches the main process and is surfaced at `info`.** The child's work is not a black box between spawn and result.

| Normalized event | Log event | Level | Terminal rendering |
| :-- | :-- | :-- | :-- |
| `text` (assistant prose) | `provider.text` | **`info`** | Wrapped, task-prefixed |
| `tool` (tool invocation) | `provider.tool` | **`info`** | One line: `⚒ Read(src/db.ts)`; inputs truncated to the line |
| child **stderr** lines | `provider.stderr` | **`info`** | Task-prefixed, ANSI-stripped — this is where CLIs put their own diagnostics |
| `error` | `task.failed` / `task.retried` | `warn`/`error` | Full |
| `session`, `unknown` | `provider.session`, `provider.event.unknown` | `debug` | Hidden by default — pure noise |

### Rules

1. **Attribution is mandatory.** Every forwarded line carries `task_id` and `provider`, and is **prefixed on screen**. Unprefixed output from parallel tasks is unreadable.
2. **ANSI-stripped before forwarding.** Provider output is untrusted (`providers.md`); escape sequences never reach the terminal raw.
3. **Never truncate in the file.** `events.jsonl` and `baya.jsonl` keep the full stream; only the *display* abbreviates tool inputs.
4. **Forward through `src/ui/progress.ts`**, never straight to stderr, or the spinner line is garbled.
5. **`debug` is where noise lives** — session ids, unknown event types, state checkpoints. `info` stays readable.

### Escalation
`escalation.queued` · `escalation.prompted` · `escalation.answered` · `escalation.resumed` (session id)

### Teardown
`signal.received` · `process.killed` (pgid, signal) · `process.escalated` (SIGTERM → SIGKILL) · `state.checkpointed` (`trace`) · `run.completed` (totals) · `run.failed` · `run.interrupted`

### Recovery
`resume.requested` · `resume.state.loaded` · `resume.source.stale` (sha256 mismatch) · `resume.planned` (re-run vs kept) · `lock.acquired` · `lock.refused` (holder pid/run/age) · `lock.reclaimed` (stale)

> `provider.event` and `state.checkpointed` are the high-volume pair. They stay in the file at `debug`/`trace` and reach the terminal only under `--verbose`.

## Rules

1. **Log before acting, not after.** `task.spawned` is written before the spawn, `process.killed` before the signal. A crash must leave evidence of the last thing attempted.
2. **One event per real transition** — never a progress heartbeat. The spinner shows liveness; the log records facts.
3. **Never log to stdout.**
4. **Structured fields, not interpolated prose.** `{"event":"task.failed","kind":"quota"}`, never `"task failed: quota"`. The renderer composes the sentence.
5. **Redact before write**, at the sink, so no call site can leak.
6. Per-run files only — no shared global log to contend over.
