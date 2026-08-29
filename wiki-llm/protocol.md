# Protocol — JSON Wire Format

> **Maintenance Invariant:** Schemas and parsing rules only. Every schema change bumps `baya` version and updates `testing.md` fixtures in the SAME commit. Items tagged `later` are not in v1.
> **Answers:** What exact JSON goes into and comes out of a provider? What is the manifest shape? How is malformed output handled?

**Governing rule: all orchestrator↔provider communication is JSON, both directions. Prose is never the interface.** Three independently validated layers: transport (provider's own stream) · request envelope · result envelope.

## 1. Manifest (planner output)

```json
{
  "version": 1,
  "source": { "path": "tasks.md", "sha256": "…" },
  "tasks": [
    { "id": "gen-schema", "title": "Generate DB schema",
      "instruction": "…full actionable prompt…",
      "provider": "codex", "model": null,
      "depends_on": ["design-api"], "writes": true, "cwd": null }
  ]
}
```

| Field | Rule |
| :-- | :-- |
| `id` | kebab-case, unique, `^[a-z0-9][a-z0-9-]{0,63}$`. |
| `instruction` | Non-empty. Self-contained; upstream context arrives separately via `context[]`. |
| `provider` | Closed enum ∩ configured allowlist. Unknown ⇒ validation error. |
| `model` | Free string or `null`. `null` ⇒ provider's own default. **Never hard-code model ids.** |
| `depends_on` | Every entry must resolve. Graph must be acyclic. |
| `writes` | `true` ⇒ workspace-write permission + writer lock. Default `false`. |

**Privilege boundary — the manifest may never contain argv, shell strings, env vars, or executable paths.** The planner selects *which* provider; the adapter alone decides *how* to invoke it.

### Validation order (fail fast, report all)
Zod shape → id format → id uniqueness → `depends_on` resolves → acyclic (Kahn, report the cycle path) → provider in allowlist → task count ≤ `--max-tasks`.

## 2. `task_request` (orchestrator → provider)

Written to `runs/<runId>/tasks/<id>/request.json`, delivered by file/stdin (see `providers.md`).

```json
{
  "baya": "1", "kind": "task_request", "run_id": "20260828T2152Z-a1f4c9",
  "task": { "id": "gen-schema", "title": "…", "instruction": "…" },
  "workspace": { "cwd": "/abs/path", "writable": true, "isolation": "shared" },
  "context": [
    { "task_id": "design-api", "title": "Design the API", "status": "ok",
      "summary": "Defined 6 REST endpoints…",
      "result_path": "/abs/.baya/runs/…/design-api/result.json",
      "output_path": "/abs/.baya/runs/…/design-api/output.md",
      "inline": null }
  ],
  "response_contract": { "schema_path": "/abs/.baya/schema/task_result.schema.json" },
  "constraints": { "max_runtime_s": 900 }
}
```

`inline` holds the upstream text when it fits the per-edge budget; otherwise `null` and the agent reads `output_path`. See `execution.md` §Context.

## 3. `task_result` (provider → orchestrator)

```json
{
  "baya": "1", "kind": "task_result", "task_id": "gen-schema",
  "status": "ok",
  "summary": "Created 4 tables with FK constraints.",
  "output": "## Schema\n\n…markdown…",
  "notes": [
    { "severity": "warn",
      "message": "The migration locks `users` for ~30s on tables over 1M rows. Consider a concurrent index build." }
  ],
  "question": null,
  "error": null,
  "artifacts": [ { "path": "migrations/001.sql", "kind": "file", "description": "…" } ],
  "files_changed": ["migrations/001.sql"]
}
```

| `status` | Required fields | Effect |
| :-- | :-- | :-- |
| `ok` | `summary` | Persist, unblock dependents. |
| `needs_input` | `question.text` | Park node, bubble question, resume session. |
| `failed` | `error.message`, `error.retryable` | Mark descendants `skipped`. |

Cap `summary` at 2000 chars. `question.options` and `question.default` are optional; a `default` is used when `--on-input default`.

### `notes[]` — "done, but you should know…"

The channel for everything an agent wants a human to see that is **not** a failure and **not** a blocking question. Caveats, risks, assumptions it had to make, follow-up work it noticed. Without this field that commentary is buried in `output` and never reaches the terminal.

| `severity` | Meaning | Surfaced |
| :-- | :-- | :-- |
| `info` | Worth knowing. Assumptions, minor observations. | End-of-run report |
| `warn` | Something is likely wrong or risky, but the task completed. | **Immediately**, plus the report |
| `action_required` | The human must do something Baya cannot. | **Immediately**, plus the report, and the run report calls it out |

Valid on **any** status — a `failed` task often has the most useful notes. Empty array when there is nothing to raise; never null.

> Because `codex` and `claude` enforce the schema natively, `notes` is not merely *allowed* — the schema shape actively invites the model to fill it. The contract induces the behavior.

## 4. Parsing the result — degradation ladder

Apply in order; stop at first success:

1. **Native schema.** `codex --output-schema … -o result.json` → read the file. Strongest; no parsing. `claude` `.structured_output` is rung 1 too.
2. **Verbatim.** Final assistant message parses as JSON matching the schema.
3. **Fenced extract.** *Last* ` ```json ` block in the final message (last, not first — a model often shows a draft then a correction).
4. **One repair round-trip.** Resume the session: *"Return only the JSON object matching the schema. No prose."* `later` — v1 goes straight to step 5.
   Only `opencode` and `copilot` can reach rungs 2–4; `codex` and `claude` enforce the schema up front.
5. **Synthesize failure.** `status:"failed"`, `error.message:"unparseable result"`, raw stdout preserved as an artifact.

Rungs 2–3 are `extractResultFromText(taskId, text)` and rung 5 is `synthesizeFailure` (`src/providers/result.ts`, M2.6). Both normalize `task_id` to the requested id so a provider echoing the wrong id cannot misroute a result. `opencode`/`copilot` call `extractResultFromText` over their concatenated assistant text; `claude` calls it over `.result`.

**Never regex prose for meaning.** A question is the `needs_input` status field — not a question mark spotted in a stream. This is what makes escalation structural rather than heuristic.

## 5. `ProviderEvent` (normalized transport)

Each adapter maps its CLI's native stream onto this union; the normalized stream is persisted to `events.jsonl`.

```ts
type ProviderEvent =
  | { t: 'session'; id: string }                                  // enables resume
  | { t: 'text';    text: string }
  | { t: 'tool';    name: string; input?: unknown }               // display only
  | { t: 'final';   raw: string }                                 // candidate result payload
  | { t: 'error';   kind: 'rate_limit'|'auth'|'other'; message: string }
  | { t: 'unknown'; raw: string };                                // never drop
```

Unrecognized transport lines become `unknown` rather than being discarded — upstream CLIs add event types without notice, and silent drops make drift invisible.

**Every event is forwarded to the main process and surfaced at `info`** (`text`, `tool`, and child stderr), so a running task is never a black box. Rendering and levels: [logging.md](logging.md).

`error.kind` classifies retryability. `rate_limit` and transient network are retryable; `auth` is not.
