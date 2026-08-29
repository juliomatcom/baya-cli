# 01 — Baya Orchestrator, Refined Specification v2

> **Maintenance Invariant:** Supersedes `multi_model_cli_orchestrator_spec-gemini.md`. Every requirement here is implementable against a provider surface verified in `00-validation.md` §C, or is explicitly marked UNVERIFIED. Do not add tasks here — tasks live in `02-plan.md`.

Binary: **`baya`** — `baya ./tasks.md` is the everyday form. Runtime: **Node 24 + TypeScript (strict, ESM)**. Tests: **Jest**.

> **This document is the point-in-time target.** The living source of truth for models coding this app is **[`wiki-llm/`](../../wiki-llm/index.md)**. `02-plan.md` defines what actually lands in v1 and what is deferred.

## 1. Terminology

| Term         | Meaning                                                                                               |
| :----------- | :---------------------------------------------------------------------------------------------------- |
| **Provider** | A supported local agent CLI. v1: `opencode`, `codex`, `claude`, `copilot`.                            |
| **Adapter**  | The module that maps Baya's uniform task contract onto one provider's real argv/stdin/stream surface. |
| **Manifest** | The validated JSON DAG produced by the planner.                                                       |
| **Envelope** | The JSON request sent into a provider, or the JSON result read back out.                              |
| **Run**      | One execution of a manifest, rooted at `.baya/runs/<runId>/`.                                         |

## 2. Wire Format — JSON Only (governing rule)

**All communication between the orchestrator and any provider is JSON in both directions.** Prose is never the interface. Three layers, each independently validated:

1. **Transport** — the provider's own structured stream (`codex exec --json` JSONL, `opencode run --format json`, `claude --output-format stream-json`). Each adapter normalizes it to Baya's `ProviderEvent` union. A provider with no structured stream is degraded, not excluded.
2. **Request envelope** — `task_request` JSON, written to `.baya/runs/<runId>/tasks/<id>/request.json` and delivered by file (§4.3).
3. **Result envelope** — `task_result` JSON, the provider's final message, persisted to `…/tasks/<id>/result.json`.

### 2.1 `task_request`

```json
{
  "baya": "1",
  "kind": "task_request",
  "run_id": "…",
  "task": { "id": "gen-schema", "title": "…", "instruction": "…" },
  "workspace": { "cwd": "/abs/path", "writable": true, "isolation": "shared" },
  "context": [
    {
      "task_id": "design-api",
      "title": "…",
      "status": "ok",
      "summary": "…",
      "result_path": "/abs/…/result.json",
      "output_path": "/abs/…/output.md",
      "inline": "… or null"
    }
  ],
  "response_contract": { "schema_path": "/abs/.baya/schema/task_result.schema.json" },
  "constraints": { "max_runtime_s": 900 }
}
```

### 2.2 `task_result`

```json
{
  "baya": "1",
  "kind": "task_result",
  "task_id": "gen-schema",
  "status": "ok | needs_input | failed",
  "summary": "≤2000 chars",
  "output": "markdown, or null",
  "question": { "text": "…", "options": ["…"], "default": null },
  "error": { "message": "…", "retryable": false },
  "artifacts": [{ "path": "…", "kind": "file|diff|log", "description": "…" }],
  "files_changed": ["src/db.ts"]
}
```

`question` is required iff `status = needs_input`; `error` required iff `status = failed`.

**`notes[]`** (`info` / `warn` / `action_required`) is valid on **any** status — the channel for "finished, but you should know…". `warn` and `action_required` print the moment the task completes; all notes aggregate into a **Flagged** section closing the run. Without it, an agent's caveats die unread in `result.json`.

### 2.3 Enforcement and degradation

Per adapter, strongest available mechanism wins:

| Provider   | Enforcement                                                               |
| :--------- | :------------------------------------------------------------------------ |
| `codex`    | **Native.** `--output-schema task_result.schema.json` + `-o result.json`. |
| `claude`   | `--output-format json`; extract the result field, then parse.             |
| `opencode` | `--format json`; extract final assistant message, then parse.             |
| `copilot`  | ⚠️ UNVERIFIED — determine in P1.                                          |

Degradation ladder when the final message is not clean JSON: **(a)** parse verbatim → **(b)** extract the last fenced ` ```json ` block → **(c)** one repair round-trip re-prompting for JSON only → **(d)** synthesize `status:"failed"`, `error.message:"unparseable result"`, preserving raw stdout as an artifact. Never regex prose for meaning.

> **Rationale.** This makes §5 escalation _structural_ rather than heuristic. A question is `status:"needs_input"` — a field — not a question mark spotted in a stream. It also kills finding B2's ambiguity class outright.

## 3. Ingestion & Planning

### 3.1 Input

Freeform Markdown. No DSL, no frontmatter, no required structure (original §2.1 preserved).

### 3.2 Planner contract

The planner provider receives the raw Markdown plus the manifest JSON Schema and returns **only** a manifest.

**The manifest is a privilege boundary.** It may name a `provider` (closed enum, intersected with the configured allowlist) and a `model` string. It may **never** carry argv, shell strings, env vars, or file paths to execute. All argv is constructed by the adapter. `shell: true` is forbidden everywhere in the codebase, enforced by lint rule.

```json
{
  "version": 1,
  "source": { "path": "tasks.md", "sha256": "…" },
  "tasks": [
    {
      "id": "kebab-slug",
      "title": "…",
      "instruction": "…",
      "provider": "codex",
      "model": null,
      "depends_on": ["other-id"],
      "writes": true,
      "cwd": null
    }
  ]
}
```

### 3.3 Validation (pure, no I/O — fully unit-testable)

Zod schema → unique ids → every `depends_on` resolves → **acyclic** (Kahn; report the actual cycle path) → `provider` ∈ allowlist → non-empty `instruction` → task count ≤ `--max-tasks` (default 50).

### 3.4 Repair and fallback

On validation failure, return the errors to the planner. Max **2** repair rounds. Then fall back to a deterministic heuristic: one task per top-level heading/bullet, chained strictly sequentially, all on `--default-provider`, emitting a loud warning. **A bad plan degrades; it never aborts the run.**

### 3.5 Model alias resolution (B12)

A static alias table maps natural-language names → `(provider, model)`. `sonnet|opus|haiku → claude`; `gpt-*|codex → codex`; `gemini|flash|pro → gemini` (v1.1). Rules: an alias naming a provider Baya does not have configured is a **validation error with a suggestion**, never a silent reassignment. An unrecognized model string passes through to the provider untouched (the provider owns its own model namespace).

### 3.6 Plan lifecycle (B14)

`--plan-out <f>` write and stop · `--plan-in <f>` skip planning entirely · `--edit` open `$EDITOR` on the manifest before the confirm gate · plan cache keyed on `sha256(markdown + planner flags + schema version)` at `.baya/plans/<hash>.json`, bypassed by `--no-cache`.

## 4. Providers & Dispatch

### 4.1 Adapter interface

```ts
interface ProviderAdapter {
  id: ProviderId;
  resolve(): Promise<Resolved | null>; // binary path + version
  capabilities: {
    promptDelivery: ("file" | "stdin" | "argv")[]; // preference order
    structuredOutput: "schema" | "json" | "text";
    events: "jsonl" | "json" | "none";
    resume: "session" | "last" | "none";
    cwdFlag: boolean;
    modelFlag: boolean;
    maxConcurrency: number; // subscription-aware
  };
  buildRun(t: TaskPlan, env: RunEnv): Spawn; // argv[], cwd, stdin, env
  buildResume(sessionId: string, answer: string, env: RunEnv): Spawn;
  parseEvents(chunk: string): ProviderEvent[];
  extractResult(events: ProviderEvent[], files: RunFiles): TaskResult;
}
```

`Spawn` is always `{ argv: string[] }` — never a command string. Adapter `buildRun` output is **snapshot-tested**, which is precisely what would have caught `codex -p` (finding A1).

### 4.2 Binary resolution (A3)

Order: explicit config override → `$PATH` → known install locations (`~/.local/bin`, `~/.opencode/bin`, active nvm bin, `~/.claude/local`) → not-found. `baya doctor` reports id, resolved path, version, capabilities, and auth reachability for every provider.

### 4.3 Prompt delivery — files preferred (B13)

Each adapter declares an ordered preference; the executor uses the first supported:

1. **`file`** — a native prompt/attach flag (`opencode run -f <file>`).
2. **`stdin`** — pipe the file (`codex exec - < request.json`; `gemini` appends stdin).
3. **`argv`** — last resort only.

`request.json` is always written to disk regardless of delivery path, so every run is reproducible and inspectable. This avoids `ARG_MAX`, shell-quoting hazards, and newline mangling.

### 4.4 Permissions

Baya never guesses. Each task carries a policy mapped per adapter (`codex -s workspace-write`, `gemini --approval-mode auto_edit`, …). Default: **read-only**; `writes: true` tasks get workspace-write. Full bypass requires an explicit `--dangerously-allow-all` on the Baya invocation and is never inferred from the Markdown.

## 5. Execution

### 5.1 States

`pending → ready → running → { succeeded | failed | parked }`; `parked --answer→ running`. Descendants of `failed` become **`skipped`**, not `failed`. `blocked` denotes unmet deps only.

### 5.2 Concurrency

Global `--max-parallel` (default `min(4, cpus)`); per-provider `maxConcurrency` from capabilities (default **1** for `claude` and `copilot` until measured — B7); a task never starts unless both budgets allow.

### 5.3 Workspace isolation (B1)

Default `--isolation shared`: read-only tasks run fully parallel; any `writes: true` task takes an **in-memory scheduler semaphore**, so writers serialize. No file lock is needed — only one Baya runs per directory. `--isolation worktree` (`later`): each writing task gets `git worktree add .baya/wt/<id>` plus an end-of-run merge/report step.

### 5.4 Context bus (B4)

Upstream results land at `…/tasks/<id>/result.json` and `output.md`. Downstream `task_request.context[]` carries `summary` + **absolute paths** by default. Overflow strategy `--context-strategy link-only | truncate | summarize` (default **`link-only`**), with per-edge and total budgets (`--context-budget`, default 12000 chars total / 6000 per edge).

> **Rationale.** These providers are _agentic_ — they can open files. Handing them a path costs ~40 tokens and is unbounded; inlining 40 KB costs 10k tokens and still truncates. Inline only when small; link when not.

### 5.5 Failure semantics (B5)

`--on-error continue|stop` (default `continue`: skip descendants, let independent branches finish). Retries only for classified-transient failures (rate limit, network, provider crash) via `--retries` (default 1) with exponential backoff + jitter. Process exit: `0` all succeeded · `1` any failed · `2` planner/validation error · `130` SIGINT.

### 5.6 Escalation — Pause & Resume (replaces original §2.4)

1. A provider returns `status:"needs_input"` with a `question`.
2. That node → `parked`. **Independent branches keep running.**
3. Baya serializes bubbling behind a prompt queue (one question owns stdin at a time), renders it with task id/provider/title, and reads the answer.
4. Baya resumes **that provider's own session** (`codex exec resume <id>`, `opencode run -s <id>`, `claude --resume <id>`) with a `task_request` whose context carries the answer. Session ids are captured from the transport stream.
5. `resume: 'none'` providers degrade to a **cold resume**: re-run the task with the question and answer appended to context.
6. **Non-TTY (B9):** `parked` nodes fail immediately with `error.message:"input required, no TTY"`, unless `--on-input fail|skip|default` says otherwise. `--yes` auto-confirms the §6 plan gate but **never** answers a task question.

Out of scope: PTY multiplexing, keystroke injection, alternate-buffer scraping.

### 5.7 Interrupts (B8)

Children spawn `detached: true` in their own process group. SIGINT → `kill(-pgid, SIGTERM)` → 5 s grace → `SIGKILL`. Second Ctrl-C kills immediately. Same path on SIGTERM/SIGHUP/`uncaughtException`. Live pids are checkpointed so a later `baya doctor` can reap strays.

### 5.8 Run state & recovery (B6) — **v1**

`.baya/runs/<runId>/state.json` written **atomically** (tmp + rename) **before** every transition, carrying task states, session ids, timings, cost, and a normalized `failure` record. `baya resume <runId>` re-runs `failed`/`skipped`/`parked`/interrupted nodes while keeping every `succeeded` output as context; with no `runId` it offers a picker and **never guesses**, since several runs may sit paused at once; `--provider` re-runs them elsewhere. `quota`/`auth` failures are `retry: "later"` and never consume retry attempts. Full schema, taxonomy, and recovery prompt: **[`wiki-llm/recovery.md`](../../wiki-llm/recovery.md)**.

## 6. CLI Surface

> `wiki-llm/cli.md` is the living source of truth for flags; this section is the point-in-time target.

```
baya <file.md> [flags]         # bare path implies `run`
baya run <file.md>             baya plan <file.md>     baya doctor
baya config [--show|path|set <k> <v>]           # first-run wizard + defaults
baya resume <runId> [--provider <id>]           baya runs
```

`-h/--help` must list every registered provider with its resolution status and show at least one runnable example.

| Flag                                      | Default               | Notes                                  |
| :---------------------------------------- | :-------------------- | :------------------------------------- |
| `--planner-provider` / `--planner-model`  | `claude` / unset      | Model unset ⇒ provider default (A4).   |
| `--default-provider` / `--default-model`  | `claude` / unset      |                                        |
| `--dry-run`                               | off                   | Render DAG, exit 0.                    |
| `--yes`                                   | off                   | Auto-confirm the plan gate only.       |
| `--plan-out` / `--plan-in` / `--edit`     | —                     | §3.6.                                  |
| `--max-parallel`                          | `min(4,cpus)`         |                                        |
| `--isolation`                             | `shared`              | `shared \| worktree`.                  |
| `--on-error`                              | `continue`            | `continue \| stop`.                    |
| `--retries`                               | `1`                   | Transient failures only.               |
| `--context-strategy` / `--context-budget` | `link-only` / `12000` |                                        |
| `--on-input`                              | `ask`                 | `ask \| fail \| skip \| default`.      |
| `--dangerously-allow-all`                 | off                   | Never inferred.                        |
| `--json`                                  | off                   | Machine-readable run report on stdout. |

## 7. Non-Functional

- **Zero footprint** — no daemon, no DB, no mandatory config. Optional `.baya/config.json` for provider overrides and concurrency caps. All run state under `.baya/` (gitignored).
- **Live provider output** — every provider CLI's assistant prose, tool calls, and stderr is forwarded to the main process and surfaced at **`info`**, task-prefixed and ANSI-stripped. A running task is never a black box.
- **Observability (B10)** — per-run `baya.jsonl` recording **every internal move** at `trace`, with a filtered stderr view; per-task `stdout.log`, `stderr.log`, `events.jsonl`, `request.json`, `result.json`. Live status table; `--json` report. Never stdout. Vocabulary: **[`wiki-llm/logging.md`](../../wiki-llm/logging.md)**.
- **One Baya per directory** — enforced by `.baya/baya.lock` (`O_EXCL` + pid + heartbeat) taken at startup. A second invocation in the same tree is refused with the holder's pid, runId, and age; a crashed holder's lock is reclaimed once its heartbeat ages and its pid is gone. Two task lists against one repo is a _user-level_ `git worktree`, not an in-process feature.
- **Presentation** — `chalk` v6 via semantic tokens in `src/ui/theme.ts` (the sole chalk importer). Status is always color **plus** glyph, never color alone. Machine-readable output (`--json` and all artifacts) is forced ANSI-free; provider ANSI is stripped as untrusted input.
- **Redaction** — scrub `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GITHUB_TOKEN`-shaped strings from logs and artifacts.
- **Provider drift (B15)** — opt-in contract tests exercise real binaries; CI stays fully offline.

## 8. Out of Scope (v1)

PTY multiplexing · remote/cloud execution · direct API-key providers · cost/token accounting · web UI · `gemini` (surface verified, deferred to v1.1 — the adapter interface already accommodates it).
