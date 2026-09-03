# CLI Reference

> **Maintenance Invariant:** Flags + exit codes only. Every flag here must exist in `src/cli/`. `later` / milestone-tagged items are not yet parsed — passing one is an `unknown flag` error, never a silent no-op. Update in the SAME commit as any flag change. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** What commands and flags does `baya` expose? What do the exit codes mean?

## Invocation

Binary: `baya` (npm bin). A bare path arg ⇒ `run`.

```bash
baya ./tasks.md            # ≡ baya run ./tasks.md
baya tasks.md --yes        # ≡ baya run tasks.md --yes
```

**Resolution:** first positional matching a known subcommand ⇒ that subcommand; else ⇒ task-list path for `run`. A file named `doctor` ⇒ write `./doctor`.

**Task-list file:** any UTF-8 text file — Markdown, `.txt`, YAML, whatever names the work. Empty or binary (C0 control bytes) ⇒ exit `2` before planning. The planner extracts tasks from the text; the deterministic fallback splitter (headings → list items → enumerated lines → blank-line blocks → whole doc) covers a planner failure.

## Commands

| Command               | Purpose                                                                                                                                                                                                                                                                                    | Status |
| :-------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| `baya <file>`         | Default form. Alias for `run`.                                                                                                                                                                                                                                                             | v1     |
| `baya run <file>`     | Plan, resolve models, confirm, execute.                                                                                                                                                                                                                                                    | v1     |
| `baya plan <file>`    | Plan + render DAG; never executes. ≡ `run --dry-run`.                                                                                                                                                                                                                                      | v1     |
| `baya doctor`         | Resolve every provider: path, version, capabilities. Reap stray process groups (gated on a stale lock).                                                                                                                                                                                    | v1     |
| `baya config`         | Re-run the wizard. Subactions `--show` \| `path` \| `set <key> <value>` \| `refresh-models`. [config.md](config.md).                                                                                                                                                                       | v1     |
| `baya models [id]`    | Print the effective catalog (`BUILTIN_CATALOG` + config `modelCatalog`) grouped by provider; each row tagged `built-in` / `user`. Optional provider filter; `--json` emits the catalog.                                                                                                    | v1     |
| `baya resume <runId>` | Re-execute the run's unfinished tasks **in its own run directory**; succeeded tasks are kept as context and never re-run. `--provider <id>` re-runs elsewhere. No `runId` ⇒ pick from a list, never guess; no TTY ⇒ exit `2`. Settings from `config_snapshot`. [recovery.md](recovery.md). | v1     |
| `baya runs`           | List resumable runs — `running`/`paused`/`failed`/`interrupted`, newest first: id, source, start, status, totals. `--json` emits the rows. Unreadable `state.json` ⇒ a `damaged` row, never a crash.                                                                                       | v1     |

Run `baya doctor` first on any new machine — provider binaries are frequently off `$PATH`.

## Flags (`run`)

| Flag                      | Default       | Meaning                                                                                                                               |
| :------------------------ | :------------ | :------------------------------------------------------------------------------------------------------------------------------------ |
| `--planner-provider <id>` | _from config_ | Provider that parses the task list into a manifest.                                                                                   |
| `--planner-model <m>`     | _unset_       | Unset ⇒ provider's own default. Resolved against the catalog like a task's, so an alias works.                                        |
| `--default-provider <id>` | _from config_ | Fallback for tasks with no stated provider. **Bypasses the first-run wizard.**                                                        |
| `--default-model <m>`     | _unset_       | Unset ⇒ provider's own default. Resolved against the catalog like a task's, so an alias works.                                        |
| `--dry-run`               | off           | Render the DAG (with resolved models) and exit `0`.                                                                                   |
| `--yes`                   | off           | Auto-confirm the plan gate; at the model gate takes a best match ≥ 0.85 else exits `2`. **Never answers a task question.**            |
| `--plan-out <f>`          | —             | Write the manifest (models resolved) and exit.                                                                                        |
| `--plan-in <f>`           | —             | Execute a manifest directly; skips planning. Still runs the model gate.                                                               |
| `--max-parallel <n>`      | `min(4,cpus)` | Global concurrency budget. Per-provider caps apply on top (execution.md §Scheduler).                                                  |
| `--isolation <mode>`      | `shared`      | `shared` only; `worktree` is `later`.                                                                                                 |
| `--on-error <mode>`       | `continue`    | `continue` (skip descendants) \| `stop`; `stop` behavior is **M2.3**.                                                                 |
| `--retries <n>`           | `1`           | Transient failures only. **M2.5**.                                                                                                    |
| `--context-strategy <s>`  | `link-only`   | `link-only` \| `truncate`. `summarize` is `later`.                                                                                    |
| `--context-budget <n>`    | `12000`       | Total chars; per-edge cap is half.                                                                                                    |
| `--no-memory`             | off           | Do not pass what earlier tasks learned. Every task starts blind. The A/B control for measuring memory.                                |
| `--memory-budget <n>`     | `1200`        | Chars of the `# Known about this workspace` block (~300 tokens).                                                                      |
| `--group-size <n>`        | `3`           | Max tasks per provider process (execution.md §Grouping). `1` gives every task its own process.                                        |
| `--on-input <mode>`       | `ask`         | `ask` \| `fail` \| `skip` \| `default`. **M4.5** — `needs_input` parks + reports today.                                               |
| `--max-tasks <n>`         | `50`          | Planner output ceiling.                                                                                                               |
| `--dangerously-allow-all` | off           | Full permission bypass. Never inferred from the task list.                                                                            |
| `--json`                  | off           | Machine-readable run report, `models` catalog, or `runs` list to stdout.                                                              |
| `--verbose`               | off           | Alias for `--log-level debug`.                                                                                                        |
| `--no-color`              | off           | Disable ANSI. `NO_COLOR` / `FORCE_COLOR` honored natively by chalk.                                                                   |
| `-v`, `-V`, `--version`   | —             | Print the release version (`package.json` of the installed package) to stdout and exit `0`. No banner.                                |
| `--provider <id>`         | —             | **`resume` only** — re-run unfinished tasks elsewhere (answer to exhausted credits). Resets their `model` to that provider's default. |
| `--no-progress`           | off           | Disable the spinner. Auto-off for non-TTY / `--json` / `NO_COLOR`.                                                                    |
| `--log-level <l>`         | `info`        | `trace\|debug\|info\|warn\|error`. Display filter only; the log file always gets everything.                                          |
| `--quiet`                 | off           | Alias for `--log-level warn`. Suppresses live provider output + completion lines; notes and the final report still print.             |
| `--edit`, `--no-cache`    | —             | `later`.                                                                                                                              |

Unannotated flags are implemented + covered by `test/unit/cli/args.test.ts`.

**Model defaults deliberately unset.** Ids churn faster than this tool ships; the original spec's `claude-3-5-haiku` / `gpt-4o` defaults were dead on arrival. Each provider picks its own default. A task that _names_ a model is resolved against the catalog (`config.md` §Model resolution), not against a hard-coded list.

## `-h` / `--help`

**Requirement:** help lists every registered provider (from the adapter registry, never hard-coded — a new adapter updates help with no other edit) + at least one runnable example. Where cheap, annotate each provider with resolution status so `--help` doubles as a sanity check.

```
baya — orchestrate local AI coding CLIs from a plain-text task list

USAGE
  baya <file> [options]           run a task list (default)
  baya run|plan <file>            explicit form
  baya doctor                     check provider installs
  baya config [--show|path|set|refresh-models]
  baya models [provider]          list the effective model catalog
  baya runs                       list resumable runs

PROVIDERS
  codex      ✓ codex-cli 0.148.0        ~/.local/bin/codex
  claude     ✓ 2.1.251 (Claude Code)    ~/.local/bin/claude
  opencode   ✓ 1.18.25                  ~/.opencode/bin/opencode
  copilot    ✗ not found — npm i -g @github/copilot

EXAMPLES
  baya ./tasks.md
  baya ./TODO.txt --default-provider codex
  baya ./tasks.md --dry-run          # show the plan, run nothing
  baya plan tasks.md --plan-out plan.json
  baya run tasks.md --plan-in plan.json --yes
```

Versions/paths above are illustrative — real values from `resolve()` (`<bin> --version` per adapter, concurrent, ~20ms each), string unparsed, column sized to the widest. The block lists exactly the registered adapters; the help snapshot changes when the registry changes, with no other edit.

## First run

No user config + TTY ⇒ two questions (default provider, default model — model picker from the catalog it is about to store), answers to `~/.config/baya/config.json`, then **continue with the command you ran**. Never asks again; `baya config` changes it.

Non-TTY never prompts: one provider ⇒ used with a warning; several ⇒ exit `2` asking for `--default-provider`. Full rules + zero-provider case: [config.md](config.md).

## Banner

Every human-facing invocation opens with the `baya` wordmark (`src/ui/banner.ts`) on **stderr**. Suppressed for `--json`, `--version`, `--quiet`. Never on stdout — a piped `--json` payload and `$(baya config path)` stay clean.

## Plan gate

The preview answers two questions before the user says yes: **what waits for what** — the DAG drawn as a tree (`src/ui/dag.ts`), each parent above its children — and **what shares a process** (groups, from `projectGroups`). Stage and process counts head the tree; `topoLayers` supplies the stage count only.

```
  Run order · 6 tasks · 3 stages · 3 processes

  └─ build-app          claude claude-sonnet-5   Build the app  (group #1)
     ├─ run-tests       claude claude-sonnet-5   Run the suite  (group #1)
     │  └─ deploy-stg   codex                    Deploy staging  read-write  (group #2)
     └─ lint-code       claude claude-sonnet-5   Lint the code  (group #1)
        └─ deploy-stg   (shown above)

  · a group is one process worked through in order · projected from this plan, so a failure re-forms the groups after it
  ! group #2 fills --group-size 3 — the process is committed before its first task, so one that dies partway skips the members it never reached
```

| Element            | Rule                                                                                                                                                                        |
| :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tree shape         | Roots (no `depends_on`) at the left margin; each dependent nested under the task it waits on. Children in manifest order, so the render is stable.                          |
| `(shown above)`    | A task with more than one parent is drawn in full under the first and back-referenced under the rest. The repeat shows a dependency two branches share.                     |
| Provider column    | The **resolved** provider, after model-alias routing. A pinned model is always shown — it is the likeliest thing to be wrong, and this is the last place to catch it.       |
| `read-write`       | Badged; read-only is not. Attention belongs on the tasks that may act.                                                                                                      |
| `(group #n)`       | The process the task is projected into, numbered in admission order. A group crossing stages is a collapsed chain. Omitted entirely when no group holds more than one task. |
| Header counts      | `n tasks · n stages`, plus `· m processes` when grouping packs anything. `m` is what the run will spawn.                                                                    |
| Full-group warning | One line when any group reaches `--group-size`; named while ≤ 3 are full, counted after that.                                                                               |

**A projection, not a promise.** `projectGroups` replays the scheduler's own loop — same `readySet`, same `formGroup`, same seed rule — with every task pending, so it cannot drift from execution and is exact on the happy path. It is not a guarantee past the first group: a failed or parked task skips its descendants and re-forms every group after it. Never reimplement the rule here; import it.

## Run output

Provider output streamed **live at `info`** — watch each model work, don't wait for a result. Every line task-prefixed so parallel branches stay legible. Nothing an agent wants you to read is left in a file you must go find.

```
  baya · tasks.md · 5 tasks · codex

  resolved gen-schema: "luna" → codex gpt-5.6-luna (alias)

  ✓ design-api    codex  12.4s  Defined 6 REST endpoints and their error shapes.

  gen-schema │ ⚒ Read(src/db/schema.ts)
  gen-schema │ ⚒ Write(migrations/001.sql)
  gen-schema │ Adding the FK from orders.user_id with ON DELETE CASCADE.
  ✓ gen-schema    codex   8.1s  Created 4 tables with FK constraints.
    ! gen-schema  migration locks `users` for ~30s on tables over 1M rows.

  ▸ build-ui      codex   4.2s
  ⏵ 1 running · 2 done · 2 pending
```

| Element                                  | Rule                                                                                                                           |
| :--------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| Model resolution line                    | Printed at the gate when a task-named model resolves to a different id or via a user alias.                                    |
| Completion line                          | `summary`, first line, in full (terminal soft-wraps; never ellipsis-cut). Full text in `output.md` + the report.               |
| `warn` / `action_required` notes         | Printed **the moment the task finishes**, wrapped + indented under it.                                                         |
| `info` notes                             | Held for the end-of-run report.                                                                                                |
| Full `output`                            | Printed in full **only** for a single-task run, or under `--verbose`.                                                          |
| Live provider output                     | Streamed by default at `info` — assistant prose, tool calls, child stderr. Task-prefixed, ANSI-stripped. `--quiet` suppresses. |
| Session ids, unknown events, checkpoints | `debug` only.                                                                                                                  |

### Verbosity

| Setting                        | You see                                                                   |
| :----------------------------- | :------------------------------------------------------------------------ |
| `--quiet` (`--log-level warn`) | Warnings, failures, notes, final report.                                  |
| **default** (`info`)           | + completion lines + live provider prose / tool calls / stderr.           |
| `--verbose` (`debug`)          | + full `output` per task, session ids, unknown events, state checkpoints. |

`baya.jsonl` + `events.jsonl` always hold the full stream — verbosity filters display, never the record.

### While a run is working

One spinner line, owned by `src/ui/progress.ts`, held for as long as a provider process is out: `⠋ node-version +4 · claude claude-sonnet-5 · 1m03s` — group leader, `+n` for the rest of the group, provider and model, and **elapsed whole seconds**.

The elapsed count is the point, not decoration. `claude --output-format json` returns a single object at the very end (`events: "json"`), so between the spawn and the result there is structurally nothing to print — no `provider.tool`, no `provider.text` — and a slow task is indistinguishable from a hung one. `codex` streams JSONL and fills the gap on its own; `claude` cannot.

Started from `onGroupStarted`, cleared when the run settles and in the `finally`, so a thrown error cannot leave an interval repainting a line for a run that is over. Ticks once a second — hence `formatElapsed`, not `formatDuration`, whose tenths would flicker without telling anyone anything. Auto-off for non-TTY / `--json` / `NO_COLOR` / `--no-progress`.

### End-of-run report

```
   ✓ Run complete  5 succeeded · 47s · 2 processes · 114k tokens

  Flagged
    ! gen-schema   migration locks `users` for ~30s on tables over 1M rows
    ⚑ deploy-cfg   set STRIPE_WEBHOOK_SECRET before this ships — I cannot

  Outputs   .baya/runs/20260828T2152Z-a1f4c9-3182/tasks/<id>/output.md
```

The headline is a filled badge, graded on **how much of the run landed** — not on whether anything threw:

| Badge                   | Reads    | When                                                                                                     |
| :---------------------- | :------- | :------------------------------------------------------------------------------------------------------- |
| green `✓ Run complete`  | complete | every task `succeeded`                                                                                   |
| yellow `! Run finished` | partial  | some succeeded, some did not — **including a run with nothing `failed` but tasks `skipped` or `parked`** |
| red `✗ Run failed`      | failed   | nothing succeeded                                                                                        |

`badge` is `theme`'s loudest token and this is its only caller; a second one costs this one its emphasis. Foreground is always set with the background — a background over the terminal's default foreground is how output becomes unreadable on someone else's scheme. Every badge pairs with a glyph, so `--no-color` loses nothing.

`processes` counts provider processes actually spawned (execution.md §Grouping), not tasks — the number that says whether grouping is earning its place. Omitted for a single-task run. Also on the `--json` report as `processes`.

The token meter names the **cached share** when a provider reported one: `8.5M tokens (8.3M cached)`. The bare total reads as runaway spend on a run that mostly re-sent context it had already paid to write; the split moves the question to why the same context went out so many times. Omitted when `cached_input_tokens` is zero.

**Flagged** aggregates every `notes[]` entry across all tasks, `action_required` first, printed last. No notes ⇒ section omitted. `--json` carries per-task `notes` + an aggregated `flagged` array — nothing terminal-only is lost to a pipe.

**Next** is the way back into an unfinished run, printed last of all and omitted entirely when every task succeeded:

```
  Next      baya resume 20260903T080018Z-1e8874-44534
            Picks up where this stopped: re-runs 1 failed and 17 skipped.
            The network was unreachable — check connectivity, a VPN or proxy, and that the
            registry or API the task needs is up.
```

**The command leads.** It is the only undimmed line in the block and it sits on the `Next` row itself — a reader who already knows what broke must not have to hunt past a diagnosis for the way back in. Then `scope`, counting what re-runs and what is kept, then `cause`, one line on what to fix first.

On the `--json` report as `next: {command, scope, cause}` (`null` on a clean run). `cause` is keyed on the **dominant** `failure.kind` (recovery.md §Failure taxonomy) — highest priority present, in the order `quota, auth, permission, network, timeout, rate_limit, schema, crash, interrupted` — not the first task listed: one `quota` halts a whole run and every other failure under it is a symptom. No failure at all (an interrupt, or only `parked` tasks) still gets the block, since the run is still unfinished. A `cause` never names a flag Baya does not have.

Why it exists: `baya resume` has always been able to pick a run up without re-paying for work that succeeded, but a failed report ended on a log path, so the obvious move was to re-run the whole task list from the top. A run that stops on something the user has to fix — no network, a spent allowance, a denied permission — has to say how to come back.

## Color

`chalk` v6 via semantic tokens in `src/ui/theme.ts` — the only file permitted to import chalk. **Meaning never carried by color alone** — every status pairs a color with a glyph.

| Token            | Style       | Glyph | Used for                                |
| :--------------- | :---------- | :---- | :-------------------------------------- |
| `theme.ok`       | green       | `✓`   | `succeeded`                             |
| `theme.fail`     | red         | `✗`   | `failed`                                |
| `theme.skip`     | dim         | `⊘`   | `skipped`                               |
| `theme.park`     | yellow      | `⏸`   | `parked`, questions                     |
| `theme.run`      | cyan        | `▸`   | `running`                               |
| `theme.pending`  | dim         | `·`   | `pending`                               |
| `theme.taskId`   | bold        | —     | task ids                                |
| `theme.provider` | magenta     | —     | provider names                          |
| `theme.warn`     | yellow      | `!`   | `warn` notes, fallbacks, drift warnings |
| `theme.action`   | bold yellow | `⚑`   | `action_required` notes                 |
| `theme.note`     | dim         | `·`   | `info` notes                            |

### Rules

1. **Machine-readable output always ANSI-free** — `--json`, `report.json`, `result.json`, `events.jsonl`, `stdout.log`. Force color level `0` on those paths, not TTY detection.
2. **Diagnostics → stderr, data → stdout.** `--json` keeps stdout one clean JSON document (`baya x.md --json | jq` always works).
3. **Provider output sanitized before display** — untrusted, can contain escape sequences. Disable provider color at the flag level + strip residual ANSI.

## Exit codes

| Code  | Meaning                                                                                                           |
| :---- | :---------------------------------------------------------------------------------------------------------------- |
| `0`   | All tasks succeeded (or `--dry-run` completed).                                                                   |
| `1`   | At least one task `failed`, `skipped`, or `parked`; or `uncaughtException` (teardown runs, logged `run.crashed`). |
| `2`   | Planner / manifest validation / model-gate error; nothing executed.                                               |
| `130` | SIGINT; children torn down (SIGTERM → grace → SIGKILL).                                                           |
| `143` | SIGTERM; same teardown.                                                                                           |
| `129` | SIGHUP; same teardown.                                                                                            |

## Examples

```bash
baya ./tasks.md                              # everyday form
baya doctor                                  # verify providers first
baya plan tasks.md                           # inspect the inferred DAG
baya run tasks.md --planner-provider codex   # plan with codex, confirm, execute
baya run tasks.md --plan-out plan.json       # capture the manifest
baya run tasks.md --plan-in plan.json --yes  # execute a reviewed manifest unattended
baya config --show                           # each value + the layer it came from
baya config refresh-models                   # re-fetch the opencode model list
```
