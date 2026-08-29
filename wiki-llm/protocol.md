# Protocol — JSON Wire Format

> **Maintenance Invariant:** Schemas + parsing rules only. Every schema change bumps `baya` version and updates `testing.md` fixtures in the SAME commit. `later` items are not in v1. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** Exact JSON into/out of a provider. Manifest shape. Malformed-output handling.

**Governing rule:** all orchestrator↔provider communication is JSON, both directions — prose is never the interface. Three independently validated layers: transport (provider stream) · request envelope · result envelope.

## 1. Manifest (planner output)

```json
{
  "version": 1,
  "source": { "path": "tasks.md", "sha256": "…" },
  "tasks": [
    {
      "id": "gen-schema",
      "title": "Generate DB schema",
      "instruction": "…full actionable prompt…",
      "provider": "codex",
      "model": null,
      "depends_on": ["design-api"],
      "writes": true,
      "cwd": null
    }
  ]
}
```

| Field         | Rule                                                                                                                                                                                                                                                                                                 |
| :------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | kebab-case, unique, `^[a-z0-9][a-z0-9-]{0,63}$`.                                                                                                                                                                                                                                                     |
| `instruction` | Non-empty. Self-contained; upstream context arrives via `context[]`.                                                                                                                                                                                                                                 |
| `provider`    | Closed enum ∩ configured allowlist. Unknown ⇒ validation error. `null` ⇒ run default (or model-alias routing).                                                                                                                                                                                       |
| `model`       | Free string or `null`. `null` ⇒ provider's own default. **Never hard-code model ids.** A named model is resolved against the catalog before the run (`config.md` §Model resolution).                                                                                                                 |
| `depends_on`  | Every entry must resolve. Graph must be acyclic.                                                                                                                                                                                                                                                     |
| `writes`      | **Needs a writable workspace** — modifies files, _or_ runs anything that writes as a side effect (test suite, build, linter, install: all drop caches/temp). `false` only for pure reading. Drives the per-provider sandbox/permission mode and one prompt line; **gates no lock**. Default `false`. |

**Privilege boundary:** the manifest may never contain argv, shell strings, env vars, or executable paths. The planner selects _which_ provider; the adapter alone decides _how_.

**Validation order** (fail fast, report all per stage): zod shape → id format → id uniqueness → `depends_on` resolves → acyclic (Kahn, report the cycle path) → provider in allowlist → model routing (no explicit `provider`/`model` provider clash; no deferred `gemini`-family model) → task count ≤ `--max-tasks`.

## 2. `task_request` (orchestrator → provider)

Written to `runs/<runId>/tasks/<id>/request.json`, delivered by file/stdin (see `providers.md`).

```json
{
  "baya": "1",
  "kind": "task_request",
  "run_id": "20260828T2152Z-a1f4c9",
  "task": { "id": "gen-schema", "title": "…", "instruction": "…" },
  "workspace": { "cwd": "/abs/path", "writable": true, "isolation": "shared" },
  "context": [
    {
      "task_id": "design-api",
      "title": "Design the API",
      "status": "ok",
      "summary": "Defined 6 REST endpoints…",
      "result_path": "/abs/.baya/runs/…/design-api/result.json",
      "output_path": "/abs/.baya/runs/…/design-api/output.md",
      "inline": null
    }
  ],
  "response_contract": { "schema_path": "/abs/.baya/schema/task_result.schema.json" },
  "constraints": { "max_runtime_s": 900 }
}
```

`inline` = upstream text when it fits the per-edge budget; else `null` and the agent reads `output_path`. See `execution.md` §Context.

## 3. `task_result` (provider → orchestrator)

```json
{
  "baya": "1",
  "kind": "task_result",
  "task_id": "gen-schema",
  "status": "ok",
  "summary": "Created 4 tables with FK constraints.",
  "output": "## Schema\n\n…markdown…",
  "notes": [
    {
      "severity": "warn",
      "message": "The migration locks `users` for ~30s on tables over 1M rows."
    }
  ],
  "question": null,
  "error": null,
  "artifacts": [{ "path": "migrations/001.sql", "kind": "file", "description": "…" }],
  "files_changed": ["migrations/001.sql"]
}
```

| `status`      | Required fields                    | Effect                                      |
| :------------ | :--------------------------------- | :------------------------------------------ |
| `ok`          | `summary`                          | Persist, unblock dependents.                |
| `needs_input` | `question.text`                    | Park node, bubble question, resume session. |
| `failed`      | `error.message`, `error.retryable` | Mark descendants `skipped`.                 |

Cap `summary` at 2000 chars. `question.options` / `question.default` optional; `default` used under `--on-input default`.

### `notes[]` — "done, but you should know…"

Channel for anything a human should see that is **not** a failure and **not** a blocking question: caveats, risks, forced assumptions, follow-up work. Without it, that commentary is buried in `output` and never reaches the terminal.

| `severity`        | Meaning                                     | Surfaced                                      |
| :---------------- | :------------------------------------------ | :-------------------------------------------- |
| `info`            | Assumptions, minor observations.            | End-of-run report                             |
| `warn`            | Likely wrong/risky, but the task completed. | **Immediately** + report                      |
| `action_required` | The human must do something Baya cannot.    | **Immediately** + report + run-report callout |

Valid on **any** status (a `failed` task often has the most useful notes). Empty array when nothing to raise; never null. `codex`/`claude` enforce the schema natively, so the shape actively induces the model to fill `notes`.

## 4. Parsing the result — degradation ladder

Apply in order; stop at first success. Implementation: `src/providers/result.ts` (M2.6).

1. **Native schema.** codex `--output-schema … -o result.json` → read the file (no parsing). claude `.structured_output` is rung 1 too.
2. **Verbatim.** Final assistant message parses as conforming JSON. `extractResultFromText`.
3. **Fenced.** _Last_ ` ```json ` block in the final message (last, not first — a model shows a draft then a correction). `extractResultFromText`.
4. **One repair round-trip.** Resume: _"Return only the JSON object matching the schema. No prose."_ `later` — v1 skips to step 5.
5. **Synthesize failure.** `status:"failed"`, `error.message:"unparseable result"`, raw stdout kept as an artifact. `synthesizeFailure`.

Only `opencode`/`copilot` reach rungs 2–4 (over concatenated assistant text); `codex`/`claude` enforce up front (`claude` also runs rungs 2–3 over `.result`). Rungs 2–3 and 5 normalize `task_id` to the requested id — a provider echoing the wrong id cannot misroute a result.

**Never regex prose for meaning.** A question is the `needs_input` status field — not a question mark in a stream. Escalation is structural, not heuristic.

## 5. `ProviderEvent` (normalized transport)

Each adapter maps its CLI's stream onto this union; the normalized stream persists to `events.jsonl`.

```ts
type ProviderEvent =
  | { t: "session"; id: string } // enables resume
  | { t: "text"; text: string }
  | { t: "tool"; name: string; input?: unknown } // display only
  | { t: "final"; raw: string } // candidate result payload
  | { t: "error"; kind: "rate_limit" | "auth" | "other"; message: string }
  | { t: "unknown"; raw: string }; // never drop
```

- Unrecognized transport lines ⇒ `unknown`, never discarded — upstream CLIs add event types silently; drops make drift invisible.
- Every event forwarded to the main process, surfaced at `info` (`text`, `tool`, child stderr) — a running task is never a black box. Rendering + levels: [logging.md](logging.md).
- `error.kind` classifies retryability: `rate_limit` + transient network retryable; `auth` not. Full classification: `providers.md` §Failure classifier.
