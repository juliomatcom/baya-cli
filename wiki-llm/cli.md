# CLI Reference

> **Maintenance Invariant:** Flags + exit codes only. Every flag here must exist in `src/cli/`. `later` / milestone-tagged items are not yet parsed — passing one is an `unknown flag` error, never a silent no-op. Update in the SAME commit as any flag change. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** What commands and flags does `baya` expose? What do the exit codes mean?

## Invocation

Binary: `baya` (npm bin). A bare path arg ⇒ `run`.

```bash
baya ./tasks.md            # ≡ baya run ./tasks.md
baya tasks.md --yes        # ≡ baya run tasks.md --yes
```

**Resolution:** first positional matching a known subcommand ⇒ that subcommand; else ⇒ Markdown path for `run`. A file named `doctor` ⇒ write `./doctor`.

## Commands

| Command               | Purpose                                                                                                     | Status    |
| :-------------------- | :--------------------------------------------------------------------------------------------------------- | :-------- |
| `baya <file.md>`      | Default form. Alias for `run`.                                                                             | v1        |
| `baya run <file.md>`  | Plan, resolve models, confirm, execute.                                                                   | v1        |
| `baya plan <file.md>` | Plan + render DAG; never executes. ≡ `run --dry-run`.                                                      | v1        |
| `baya doctor`         | Resolve every provider: path, version, capabilities. Reap stray process groups (gated on a stale lock).   | v1        |
| `baya config`         | Re-run the wizard. Subactions `--show` \| `path` \| `set <key> <value>` \| `refresh-models`. [config.md](config.md). | v1        |
| `baya resume <runId>` | Re-execute unfinished nodes; `--provider <id>` re-runs elsewhere. No `runId` ⇒ pick from a list, never guess. [recovery.md](recovery.md). | v1 — M2.8 |
| `baya runs`           | List resumable runs + ids.                                                                                | v1 — M2.8 |

Run `baya doctor` first on any new machine — provider binaries are frequently off `$PATH`.

## Flags (`run`)

| Flag                      | Default       | Meaning                                                                                          |
| :------------------------ | :------------ | :--------------------------------------------------------------------------------------------- |
| `--planner-provider <id>` | _from config_ | Provider that parses the Markdown into a manifest.                                             |
| `--planner-model <m>`     | _unset_       | Unset ⇒ provider's own default.                                                               |
| `--default-provider <id>` | _from config_ | Fallback for tasks with no stated provider. **Bypasses the first-run wizard.**                 |
| `--default-model <m>`     | _unset_       | Unset ⇒ provider's own default.                                                               |
| `--dry-run`               | off           | Render the DAG (with resolved models) and exit `0`.                                            |
| `--yes`                   | off           | Auto-confirm the plan gate; at the model gate takes a best match ≥ 0.85 else exits `2`. **Never answers a task question.** |
| `--plan-out <f>`          | —             | Write the manifest (models resolved) and exit.                                                |
| `--plan-in <f>`           | —             | Execute a manifest directly; skips planning. Still runs the model gate.                        |
| `--max-parallel <n>`      | `min(4,cpus)` | Global concurrency budget. **M2.1** — sequential today.                                        |
| `--isolation <mode>`      | `shared`      | `shared` only; `worktree` is `later`.                                                         |
| `--on-error <mode>`       | `continue`    | `continue` (skip descendants) \| `stop`. **M2.3** — `continue` is current behavior.           |
| `--retries <n>`           | `1`           | Transient failures only. **M2.5**.                                                            |
| `--context-strategy <s>`  | `link-only`   | `link-only` \| `truncate`. `summarize` is `later`.                                            |
| `--context-budget <n>`    | `12000`       | Total chars; per-edge cap is half.                                                            |
| `--on-input <mode>`       | `ask`         | `ask` \| `fail` \| `skip` \| `default`. **M4.5** — `needs_input` parks + reports today.        |
| `--max-tasks <n>`         | `50`          | Planner output ceiling.                                                                       |
| `--dangerously-allow-all` | off           | Full permission bypass. Never inferred from Markdown.                                          |
| `--json`                  | off           | Machine-readable run report to stdout.                                                        |
| `--verbose`               | off           | Alias for `--log-level debug`.                                                                |
| `--no-color`              | off           | Disable ANSI. `NO_COLOR` / `FORCE_COLOR` honored natively by chalk.                            |
| `--provider <id>`         | —             | **`resume` only** — re-run unfinished tasks elsewhere (answer to exhausted credits). **M2.8**. |
| `--no-progress`           | off           | Disable the spinner. Auto-off for non-TTY / `--json` / `NO_COLOR`.                             |
| `--log-level <l>`         | `info`        | `trace\|debug\|info\|warn\|error`. Display filter only; the log file always gets everything.   |
| `--quiet`                 | off           | Alias for `--log-level warn`. Suppresses live provider output + completion lines; notes and the final report still print. |
| `--edit`, `--no-cache`    | —             | `later`.                                                                                      |

Unannotated flags are implemented + covered by `test/unit/cli/args.test.ts`.

**Model defaults deliberately unset.** Ids churn faster than this tool ships; the original spec's `claude-3-5-haiku` / `gpt-4o` defaults were dead on arrival. Each provider picks its own default. A task that *names* a model is resolved against the catalog (`config.md` §Model resolution), not against a hard-coded list.

## `-h` / `--help`

**Requirement:** help lists every registered provider (from the adapter registry, never hard-coded — a new adapter updates help with no other edit) + at least one runnable example. Where cheap, annotate each provider with resolution status so `--help` doubles as a sanity check.

```
baya — orchestrate local AI coding CLIs from a Markdown task list

USAGE
  baya <file.md> [options]        run a task list (default)
  baya run|plan <file.md>         explicit form
  baya doctor                     check provider installs
  baya config [--show|path|set|refresh-models]

PROVIDERS
  codex      ✓ codex-cli 0.148.0        ~/.local/bin/codex
  claude     ✓ 2.1.251 (Claude Code)    ~/.local/bin/claude
  opencode   ✓ 1.18.25                  ~/.opencode/bin/opencode
  copilot    ✗ not found — npm i -g @github/copilot

EXAMPLES
  baya ./tasks.md
  baya ./tasks.md --default-provider codex
  baya ./tasks.md --dry-run          # show the plan, run nothing
  baya plan tasks.md --plan-out plan.json
  baya run tasks.md --plan-in plan.json --yes
```

Versions/paths above are illustrative — real values from `resolve()` (`<bin> --version` per adapter, concurrent, ~20ms each), string unparsed, column sized to the widest. The block lists exactly the registered adapters; the help snapshot changes when the registry changes, with no other edit.

## First run

No user config + TTY ⇒ two questions (default provider, default model — model picker from the catalog it is about to store), answers to `~/.config/baya/config.json`, then **continue with the command you ran**. Never asks again; `baya config` changes it.

Non-TTY never prompts: one provider ⇒ used with a warning; several ⇒ exit `2` asking for `--default-provider`. Full rules + zero-provider case: [config.md](config.md).

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

| Element                                  | Rule                                                                                                          |
| :--------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| Model resolution line                    | Printed at the gate when a task-named model resolves to a different id or via a user alias.                  |
| Completion line                          | `summary`, first line, ≤120 chars. Full text in `output.md` + the report.                                    |
| `warn` / `action_required` notes         | Printed **the moment the task finishes**, wrapped + indented under it.                                       |
| `info` notes                             | Held for the end-of-run report.                                                                             |
| Full `output`                            | Printed in full **only** for a single-task run, or under `--verbose`.                                        |
| Live provider output                     | Streamed by default at `info` — assistant prose, tool calls, child stderr. Task-prefixed, ANSI-stripped. `--quiet` suppresses. |
| Session ids, unknown events, checkpoints | `debug` only.                                                                                               |

### Verbosity

| Setting                           | You see                                                                                 |
| :-------------------------------- | :------------------------------------------------------------------------------------ |
| `--quiet` (`--log-level warn`)    | Warnings, failures, notes, final report.                                              |
| **default** (`info`)             | + completion lines + live provider prose / tool calls / stderr.                        |
| `--verbose` (`debug`)            | + full `output` per task, session ids, unknown events, state checkpoints.             |

`baya.jsonl` + `events.jsonl` always hold the full stream — verbosity filters display, never the record.

### End-of-run report

```
  Run complete · 5 succeeded · 0 failed · 47s · $0.42

  Flagged
    ! gen-schema   migration locks `users` for ~30s on tables over 1M rows
    ⚑ deploy-cfg   set STRIPE_WEBHOOK_SECRET before this ships — I cannot

  Outputs   .baya/runs/20260828T2152Z-a1f4c9-3182/tasks/<id>/output.md
```

**Flagged** aggregates every `notes[]` entry across all tasks, `action_required` first, printed last. No notes ⇒ section omitted. `--json` carries per-task `notes` + an aggregated `flagged` array — nothing terminal-only is lost to a pipe.

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

| Code  | Meaning                                                                      |
| :---- | :------------------------------------------------------------------------- |
| `0`   | All tasks succeeded (or `--dry-run` completed).                            |
| `1`   | At least one task `failed`, `skipped`, or `parked`.                        |
| `2`   | Planner / manifest validation / model-gate error; nothing executed.       |
| `130` | SIGINT; children torn down.                                               |

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
