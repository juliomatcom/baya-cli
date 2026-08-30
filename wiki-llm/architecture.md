# Architecture

> **Maintenance Invariant:** Structure + data flow only. No flag reference (`cli.md`), no schemas (`protocol.md`). Update in the SAME commit as any module boundary change. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** The layers. End-to-end data flow. Task state machine. Where each concern lives on disk.

## Layers

| #   | Layer        | Module            | Responsibility                                                                                                         | Purity                   |
| :-- | :----------- | :---------------- | :--------------------------------------------------------------------------------------------------------------------- | :----------------------- |
| 1   | Ingestion    | `src/planner/`    | Task text (any UTF-8: md/txt/yaml/…) → planner provider → Manifest JSON. Repair loop, cache, deterministic fallback.   | I/O                      |
| 2   | Validation   | `src/manifest/`   | Zod parse, id uniqueness, dep resolution, cycle detection, provider allowlist.                                         | **Pure**                 |
| 3   | Graph        | `src/graph/`      | Topological layering, ready-set computation, descendant marking.                                                       | **Pure**                 |
| 4   | Providers    | `src/providers/`  | One adapter per CLI. argv construction, prompt delivery, event parsing, result extraction, resume.                     | Pure build + I/O resolve |
| 5   | Execution    | `src/executor/`   | Scheduler, **task grouping** (`group.ts`, pure), concurrency budgets, writer semaphore, subprocess lifecycle, signals. | Pure group + I/O run     |
| 6   | Context      | `src/context/`    | Result persistence, context assembly, budgeting strategies.                                                            | Mostly pure              |
| 6b  | Memory       | `src/memory/`     | Provider records → observations → keyed facts → the prompt block. Derived only, never self-reported.                   | **Pure** + one file read |
| 7   | Escalation   | `src/escalation/` | Park queue, stdin ownership, question rendering, session resume dispatch.                                              | I/O                      |
| 8   | Presentation | `src/ui/`         | DAG preview, live status, run report, `--json` output. `theme.ts` is the sole chalk importer.                          | I/O                      |
| 9   | Entry        | `src/cli/`        | Arg parsing, config load, command routing, exit codes.                                                                 | I/O                      |
| 10  | Logging      | `src/log/`        | JSONL trace sink + filtered stderr renderer, redaction. See [logging.md](logging.md).                                  | I/O                      |

**Rule:** layers 2, 3, and the `buildRun`/`extractResult` halves of layer 4 are pure and carry the bulk of test coverage. Push logic down into them.

## End-to-end flow

```
tasks.md  (or .txt / .yaml / any UTF-8 text file)
   │
   ├─(1) planner provider ──► Manifest JSON ──►(2) validate ──► repair ×1 ──► linear fallback
   │                                                │
   │                                          (3) topo sort
   │                                                │
   │                            model gate: resolve task-named models vs catalog
   │                                                │
   │                                    ┌───── dry-run gate ─────┐
   │                                    │  render DAG, confirm   │
   │                                    └───────────┬────────────┘
   │                                                │
   │                              (5) scheduler: ready-set ∩ budgets ∩ locks
   │                                                │
   │            ┌───────────────────────────────────┼───────────────────────────────┐
   │            ▼                                   ▼                               ▼
   │      request.json                        request.json                    request.json
   │      (6) context assembled from upstream result.json + output.md
   │            │                                   │                               │
   │      (4) adapter.buildRun ──► spawn(detached, argv[], no shell)                │
   │            │                                   │                               │
   │      transport events (JSONL) ──► ProviderEvent[] ──► session id captured      │
   │            │                                   │                               │
   │      (4) extractResult ──► task_result JSON                                    │
   │            │                                   │                               │
   │      status=ok ─────► persist, unblock dependents                              │
   │      status=needs_input ─► (7) park ─► bubble ─► answer ─► adapter.buildResume │
   │      status=failed ─────► mark descendants skipped                             │
   │            └───────────────────────────────────┴───────────────────────────────┘
   │                                                │
   └──────────────────────────────────► (8) run report + exit code
```

## Task state machine

```
pending ──deps met──► ready ──budget+lock──► running
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
                succeeded                  failed                    parked
                                              │                    (needs_input)
                                              │                         │
                                    descendants ──► skipped        answer ──► running
```

- `blocked` is a _view_ over `pending` (unmet deps), not a stored state.
- Descendants of `failed` become **`skipped`**, never `failed` — the distinction drives the exit code and the report.
- `parked` never blocks independent branches.
- Every transition is checkpointed atomically (tmp + `rename`) to `state.json`.

## On-disk layout

```
.baya/                        # gitignored
├─ baya.lock                  # one Baya per directory; held for the process lifetime
├─ config.json                # optional: provider paths, concurrency caps
├─ schema/
│  ├─ task_result.schema.json # emitted at runtime for codex --output-schema
│  ├─ task_result_batch.schema.json # the same, for a grouped process (execution.md §Grouping)
│  └─ plan_draft.schema.json  # what the planner is held to
├─ plans/<sha256>.json        # plan cache, keyed on task text + planner flags + schema version
├─ wt/<taskId>/               # git worktrees, --isolation worktree only
└─ runs/<runId>/
   ├─ manifest.json
   ├─ state.json              # atomic checkpoint: task states, pids, session ids
   ├─ baya.jsonl              # the orchestrator's own trace, every level
   ├─ plan-draft.json         # the planner's raw output for this run
   ├─ memory.json             # derived cross-task facts (execution.md §Memory)
   ├─ report.json
   └─ tasks/<taskId>/
      ├─ request.json         # what we sent
      ├─ result.json          # what came back, validated
      ├─ output.md            # result.output, for cheap context linking
      ├─ batch.json           # a group's task_result_batch, before the split (group leader only)
      ├─ events.jsonl         # normalized ProviderEvent stream — per PROCESS, in the group leader's dir
      ├─ stdout.log
      └─ stderr.log
```

`runId` is `<utc-timestamp>-<rand>-<pid>` — lexically sortable and unique. **A working tree hosts at most one Baya at a time**, enforced by `.baya/baya.lock`; a second is refused rather than coordinated with ([recovery.md](recovery.md)).

## Trust boundaries

| Boundary                 | Rule                                                                                                                                                                                                                                                                                                            |
| :----------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task text → planner      | Untrusted content (any UTF-8 text file). Never interpolated into argv.                                                                                                                                                                                                                                          |
| Provider record → memory | Derived facts fan out to **every** later task, so memory is the widest untrusted channel in the system. Carries command strings and paths only — **never command output** (`aggregated_output`, `tool_result.content`), which is where repository text would enter. Rendered as evidence, never as instruction. |
| Planner → manifest       | **Privilege boundary.** Manifest may name `provider` (closed enum) and `model` (string). Never argv, shell, env, or executable paths.                                                                                                                                                                           |
| Manifest → adapter       | Adapter alone constructs argv. `shell: true` is banned repo-wide and lint-enforced.                                                                                                                                                                                                                             |
| Provider → orchestrator  | Untrusted output. Parsed as JSON against a schema, never regexed for meaning.                                                                                                                                                                                                                                   |
| Logs → disk              | Secret-shaped strings redacted before write.                                                                                                                                                                                                                                                                    |
| Provider ANSI → terminal | Provider stdout is untrusted and may carry escape sequences. Disable provider color at the flag level where possible, and **strip ANSI** before rendering or persisting.                                                                                                                                        |
