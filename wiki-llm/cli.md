# CLI Reference

> **Maintenance Invariant:** Flags and exit codes only. Every flag here must exist in `src/cli/`. Items tagged `later` are not yet implemented — do not document them as available. Update in the SAME commit as any flag change.
> **Answers:** What commands and flags does `baya` expose? What do the exit codes mean?

## Invocation

The published binary is **`baya`** (npm bin → `baya`). A bare path argument implies `run`:

```bash
baya ./tasks.md            # ≡ baya run ./tasks.md
baya tasks.md --yes        # ≡ baya run tasks.md --yes
```

**Resolution rule:** if the first positional argument matches a known subcommand name it is dispatched as that subcommand; otherwise it is taken as the Markdown path for `run`. Keep it that simple — a file literally named `doctor` is disambiguated by writing `./doctor`.

## Commands

| Command               | Purpose                                                                                                                                                                       | Status    |
| :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------- |
| `baya <file.md>`      | Default form. Alias for `run`.                                                                                                                                                | v1        |
| `baya run <file.md>`  | Plan, confirm, execute.                                                                                                                                                       | v1        |
| `baya plan <file.md>` | Plan and render the DAG; never executes. Equivalent to `run --dry-run`.                                                                                                       | v1        |
| `baya doctor`         | Resolve every provider: path, version, capabilities, auth reachability. Reap stray process groups.                                                                            | v1        |
| `baya config`         | Re-run the first-run wizard. `--show`, `path`, `set <key> <value>`. See [config.md](config.md).                                                                               | v1        |
| `baya resume <runId>` | Re-execute unfinished nodes of a prior run; `--provider <id>` re-runs them elsewhere. With no `runId`, picks from a list — **never guesses**. See [recovery.md](recovery.md). | v1 — M2.8 |
| `baya runs`           | List resumable runs and their ids.                                                                                                                                            | v1 — M2.8 |

Run `baya doctor` first on any new machine — provider binaries are frequently not on `$PATH`.

## Flags (`run`)

| Flag                      | Default       | Meaning                                                                                                                     |
| :------------------------ | :------------ | :-------------------------------------------------------------------------------------------------------------------------- |
| `--planner-provider <id>` | _from config_ | Provider that parses the Markdown into a manifest.                                                                          |
| `--planner-model <m>`     | _unset_       | Unset ⇒ provider's own default.                                                                                             |
| `--default-provider <id>` | _from config_ | Fallback for tasks with no stated provider. **Passing it bypasses the first-run wizard.**                                   |
| `--default-model <m>`     | _unset_       | Unset ⇒ provider's own default.                                                                                             |
| `--dry-run`               | off           | Render the DAG and exit `0`.                                                                                                |
| `--yes`                   | off           | Auto-confirm the plan gate. **Never answers a task question.**                                                              |
| `--plan-out <f>`          | —             | Write the manifest and exit.                                                                                                |
| `--plan-in <f>`           | —             | Execute a manifest directly; skips planning.                                                                                |
| `--max-parallel <n>`      | `min(4,cpus)` | Global concurrency budget. **M2.1** — execution is sequential today.                                                        |
| `--isolation <mode>`      | `shared`      | `shared`. `worktree` is `later`. Not a flag yet; `shared` is the only mode.                                                 |
| `--on-error <mode>`       | `continue`    | `continue` (skip descendants) \| `stop`. **M2.3** — `continue` is the current behavior.                                     |
| `--retries <n>`           | `1`           | Transient failures only. **M2.5**.                                                                                          |
| `--context-strategy <s>`  | `link-only`   | `link-only` \| `truncate`. `summarize` is `later`.                                                                          |
| `--context-budget <n>`    | `12000`       | Total chars; per-edge cap is half.                                                                                          |
| `--on-input <mode>`       | `ask`         | `ask` \| `fail` \| `skip` \| `default`. **M4.5** — a `needs_input` result parks the task and reports today.                 |
| `--max-tasks <n>`         | `50`          | Planner output ceiling.                                                                                                     |
| `--dangerously-allow-all` | off           | Full permission bypass. Never inferred from Markdown.                                                                       |
| `--json`                  | off           | Machine-readable run report to stdout.                                                                                      |
| `--verbose`               | off           | Alias for `--log-level debug`.                                                                                              |
| `--no-color`              | off           | Disable ANSI. `NO_COLOR` and `FORCE_COLOR` are honored natively by chalk.                                                   |
| `--provider <id>`         | —             | **`resume` only** — re-run unfinished tasks on a different provider (the answer to exhausted credits). **M2.8**.            |
| `--no-progress`           | off           | Disable the spinner. Auto-disabled when not a TTY, under `--json`, or with `NO_COLOR`.                                      |
| `--log-level <l>`         | `info`        | `trace\|debug\|info\|warn\|error`. Display filter only; the log file always gets everything.                                |
| `--quiet`                 | off           | Alias for `--log-level warn`. Suppresses live provider output and completion lines; notes and the final report still print. |
| `--edit`, `--no-cache`    | —             | `later`.                                                                                                                    |

**Flags annotated with a milestone are designed but not yet parsed** — passing one today is an `unknown flag` error rather than a silent no-op, because a flag that is accepted and ignored is worse than one that is refused. Everything unannotated is implemented and covered by `test/unit/cli/args.test.ts`.

**Model defaults are deliberately unset.** Model ids churn faster than this tool ships; the original spec's `claude-3-5-haiku` / `gpt-4o` defaults were already dead on arrival. Let each provider pick its own default.

## `-h` / `--help`

**Requirement: help must list every supported provider and at least one runnable example.** The provider list is generated from the adapter registry, never hard-coded — registering a new adapter updates help with no other edit. Where cheap, annotate each provider with its resolution status so `--help` doubles as a first-line sanity check.

(colorized in a real terminal; shown plain here)

```
baya — orchestrate local AI coding CLIs from a Markdown task list

USAGE
  baya <file.md> [options]        run a task list (default)
  baya run|plan <file.md>         explicit form
  baya doctor                     check provider installs
  baya config [--show|path|set]   change defaults

PROVIDERS
  codex      ✓ codex-cli 0.148.0  ~/.local/bin/codex

EXAMPLES
  baya ./tasks.md
  baya ./tasks.md --default-provider codex
  baya ./tasks.md --dry-run          # show the plan, run nothing
  baya plan tasks.md --plan-out plan.json
  baya run tasks.md --plan-in plan.json --yes

  Run `baya doctor` to check installs, `baya config` to change defaults.
  Full reference: wiki-llm/cli.md
```

Version strings and paths above are illustrative; real values come from `resolve()`, which runs `<bin> --version` per adapter — concurrently, ~20ms each. The string is whatever the CLI prints, unparsed; the column is sized to the widest one. **The block lists exactly the registered adapters** — v1 registers `codex` alone; M3 adds the other three and the help snapshot changes with no other edit. **The provider block lists exactly the registered adapters** — v1 registers `codex`; M3 adds the other three, and the help snapshot changes with no other edit.

## First run

With no user config, a TTY invocation asks **two questions** — default provider, then default model — stores the answers in `~/.config/baya/config.json`, and **continues with the command you ran**. It never asks again; `baya config` changes it later.

Non-TTY never prompts: one provider found ⇒ used with a warning; several ⇒ exit `2` asking for `--default-provider`. Full rules and the zero-provider case: [config.md](config.md).

## Run output

What you actually see while a run works. **Nothing an agent wants you to read is left in a file you have to go find.**

**Provider output is streamed live at `info`** — you watch each model work, you do not wait for a result. Every line is task-prefixed so parallel branches stay legible.

```
  baya · tasks.md · 5 tasks · codex

  ✓ design-api    codex  12.4s  Defined 6 REST endpoints and their error shapes.

  gen-schema │ ⚒ Read(src/db/schema.ts)
  gen-schema │ ⚒ Write(migrations/001.sql)
  gen-schema │ Adding the FK from orders.user_id with ON DELETE CASCADE, since
  gen-schema │ the API contract treats orphaned orders as invalid.
  ✓ gen-schema    codex   8.1s  Created 4 tables with FK constraints.
    ! gen-schema  migration locks `users` for ~30s on tables over 1M rows.
                  Consider a concurrent index build.

  build-ui   │ ⚒ Read(src/components/Table.tsx)
  ▸ build-ui      codex   4.2s

  ⏵ 1 running · 2 done · 2 pending
```

| Element                                  | Rule                                                                                                                                                |
| :--------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completion line                          | `summary`, truncated to its **first line, ≤120 chars**. Full text in `output.md` and the report.                                                    |
| `warn` / `action_required` notes         | Printed **the moment the task finishes**, wrapped and indented under it. A warning 3 minutes into a 20-minute run must not wait for the end.        |
| `info` notes                             | Held for the end-of-run report.                                                                                                                     |
| Full `output`                            | Printed in full **only when the run has exactly one task**, or under `--verbose`. Otherwise it would bury everything.                               |
| **Live provider output**                 | **Streamed by default at `info`** — assistant prose, tool calls, and the child's own stderr. Task-prefixed, ANSI-stripped. `--quiet` suppresses it. |
| Session ids, unknown events, checkpoints | `debug` only. Noise.                                                                                                                                |

### Verbosity

| Setting                           | You see                                                                                 |
| :-------------------------------- | :-------------------------------------------------------------------------------------- |
| `--quiet` (`--log-level warn`)    | Only warnings, failures, notes, and the final report.                                   |
| **default** (`--log-level info`)  | The above, plus completion lines and **live provider prose, tool calls, and stderr**.   |
| `--verbose` (`--log-level debug`) | The above, plus full `output` per task, session ids, unknown events, state checkpoints. |

The full stream is always in `baya.jsonl` and `events.jsonl` regardless — verbosity filters the _display_, never the record.

### End-of-run report

```
  Run complete · 5 succeeded · 0 failed · 47s · $0.42

  Flagged
    ! gen-schema   migration locks `users` for ~30s on tables over 1M rows
    ⚑ deploy-cfg   set STRIPE_WEBHOOK_SECRET before this ships — I cannot

  Outputs   .baya/runs/20260828T2152Z-a1f4c9-3182/tasks/<id>/output.md
```

The **Flagged** section aggregates every `notes[]` entry across all tasks, `action_required` first. It is the last thing printed, because it is the thing most likely to matter. A run with no notes omits the section entirely.

`--json` carries `notes` per task and an aggregated `flagged` array, so nothing terminal-only is lost to a pipe.

## Color

Rendered with **`chalk` v6**, through semantic tokens in `src/ui/theme.ts` — the only file permitted to import chalk.

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

**Meaning is never carried by color alone** — every status pairs its color with a glyph, so output stays readable when piped, under `NO_COLOR`, and for colorblind readers.

### Rules

1. **Machine-readable output is always ANSI-free** — `--json`, `report.json`, `result.json`, `events.jsonl`, `stdout.log`. Force color level `0` on those paths rather than relying on TTY detection: `baya x.md --json` run _in_ a terminal would otherwise emit ANSI into the JSON.
2. **Diagnostics go to stderr, data to stdout.** `--json` keeps stdout a single clean JSON document, so `baya x.md --json | jq` always works.
3. **Provider output is sanitized before display.** Model output is untrusted and can contain escape sequences; disable provider color at the flag level (`codex --color never`) and strip residual ANSI.

## Exit codes

| Code  | Meaning                                                                      |
| :---- | :--------------------------------------------------------------------------- |
| `0`   | All tasks succeeded (or `--dry-run` completed).                              |
| `1`   | At least one task `failed`, `skipped`, or `parked` — the run did not finish. |
| `2`   | Planner or manifest validation error; nothing executed.                      |
| `130` | SIGINT; children torn down.                                                  |

## Examples

```bash
baya ./tasks.md                              # the everyday form
baya doctor                                  # verify providers before anything else
baya plan tasks.md                           # inspect the inferred DAG
baya run tasks.md --planner-provider codex   # plan with codex, confirm, execute
baya run tasks.md --plan-out plan.json       # capture the manifest
baya run tasks.md --plan-in plan.json --yes  # execute a reviewed manifest unattended
baya config --show                           # see each value and the layer it came from
```
