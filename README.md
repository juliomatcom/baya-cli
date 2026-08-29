```
▗▄▄▖  ▗▄▖▗▖  ▗▖▗▄▖      ▗▄▄▖▗▖   ▗▄▄▄▖
▐▌ ▐▌▐▌ ▐▌▝▚▞▘▐▌ ▐▌    ▐▌   ▐▌     █         (º>
▐▛▀▚▖▐▛▀▜▌ ▐▌ ▐▛▀▜▌    ▐▌   ▐▌     █      //(  )
▐▙▄▞▘▐▌ ▐▌ ▐▌ ▐▌ ▐▌    ▝▚▄▄▖▐▙▄▄▖▗▄█▄▖     //¯\\

```

**Orchestrate local AI coding CLIs from a plain-text task list.**

[![CI](https://github.com/juliomatcom/baya-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/juliomatcom/baya-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/baya-cli)](https://www.npmjs.com/package/baya-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Write what you want done in an ordinary text file — Markdown, a bare to-do list, YAML, whatever you already keep tasks in. Baya asks a model to turn it into a dependency graph, then routes each task to the AI coding CLI you already have installed and logged in — `codex`, `claude`, `copilot`, `opencode` — running independent work in parallel and piping each task's output into the ones that depend on it.

No config format to learn. No DSL. No API keys for every provider — it drives the CLIs you already pay for.

> [!WARNING]
> **Status: early.** The walking skeleton (M1) and provider breadth (M3) have landed — `codex`, `claude`, `opencode`, and `copilot` adapters, model-catalog resolution, and a sequential executor. Published to npm as [`baya-cli`](https://www.npmjs.com/package/baya-cli); concurrency and resume are still in progress. Follow along in [`specs/001/02-plan.md`](specs/001/02-plan.md).

---

## Install

```bash
npm install -g baya-cli   # binary: baya
```

Requires **Node 24+** and at least one supported CLI on your machine. Run `baya doctor` to see what it found.

## Usage

```bash
baya ./tasks.md                    # plan it, show it, run it
baya ./tasks.md --dry-run          # show the plan, run nothing
baya ./tasks.md --max-parallel 4
baya runs                          # list interrupted runs
baya resume <runId>                # continue one of them
baya resume <runId> --provider claude   # ...on a different provider
baya doctor                        # check provider installs
baya config                        # change your default provider
```

On first run baya asks once which provider and model to default to, stores it in `~/.config/baya/config.json`, and never asks again.

The task list is just text — any UTF-8 file. Markdown:

```markdown
# Ship the orders endpoint

- Design the REST API for orders. Use Sonnet.
- Generate the DB schema from that design.
- Build the React table that consumes it — run this with codex.
- Once the schema and UI are done, write integration tests.
```

…or a bare `TODO.txt`, one task per line:

```text
1 Design the REST API for orders. Use Sonnet.
2 Generate the DB schema from that design.
3 Build the React table that consumes it — run this with codex.
4 Once the schema and UI are done, write integration tests.
```

Baya's planner reads whichever you give it for intent. Empty or binary files are rejected before planning; if the planner can't produce a graph, a deterministic splitter falls back to a linear chain in the order you wrote the tasks.

### Example — a task per model, resolved automatically

```markdown
1 which model are you? - luna
2 which model are you? - terra
3 which model are you? - sonnet
```

```console
$ baya ./tasks.md --yes

  baya · ./tasks.md · 3 tasks · claude

  layer 1
    · which-model-luna    codex  gpt-5.6-luna     Which model are you? (luna)
    · which-model-terra   codex  gpt-5.6-terra    Which model are you? (terra)
    · which-model-sonnet  claude claude-sonnet-5  Which model are you? (sonnet)

  resolved which-model-luna:   "luna"   → codex gpt-5.6-luna     (alias)
  resolved which-model-terra:  "terra"  → codex gpt-5.6-terra    (alias)
  resolved which-model-sonnet: "sonnet" → claude claude-sonnet-5 (alias)

  ✓ which-model-luna    codex   17.0s · 56k tok  I am OpenAI Codex, based on the GPT-5 model family.
  ✓ which-model-terra   codex    4.2s · 18k tok  I am GPT-5.6 Terra, provided by OpenAI.
  ✓ which-model-sonnet  claude  13.4s · 28k tok  I am Claude Sonnet 5 (model ID claude-sonnet-5).

  Run complete · 3 succeeded · 34.6s · 102k tokens · $0.05
```

`luna`, `terra`, and `sonnet` are short names — Baya resolves each against its model catalog to the real id and the provider that serves it (`luna`/`terra` → `codex`, `sonnet` → `claude`), then runs all three independently. A name it can't resolve stops at the plan gate instead of failing mid-run; it is never silently swapped for the default. See [`wiki-llm/config.md`](wiki-llm/config.md#model-resolution).

## Features

- ✅ **Works out of the box** — zero config. One prompt on first run for your default provider, then never again.
- ✅ **Plain-text task lists** — Markdown, `TODO.txt`, YAML, whatever you already write. No config format, no DSL.
- ✅ **LLM-planned dependency graph** — a model turns your list into a DAG; a deterministic splitter falls back to a linear chain if it can't.
- ✅ **Multi-provider** — routes each task to `codex`, `claude`, `copilot`, or `opencode`, the CLIs you already have installed and logged in.
- ✅ **No API keys** — drives your existing CLI subscriptions; nothing new to pay for.
- ✅ **Model-per-task** — name `luna`, `sonnet`, etc. in the task text; Baya resolves it to the real id and the provider that serves it.
- ✅ **Parallel execution** — independent tasks run concurrently (`--max-parallel`); `read-write` tasks are serialized by a write-lock.
- ✅ **Preview gate** — see the full plan before anything runs; `--dry-run` shows it and runs nothing.
- ✅ **Resume** — checkpointed before every transition. Run out of credits mid-graph and `baya resume <runId>` picks up where it stopped, optionally on a different provider.
- ✅ **Doesn't pay twice** — what earlier tasks found (commands that worked, files touched) carries to later tasks, and chains on one model stay in a single warm provider session instead of spawning cold. `--no-memory`, `--no-session-reuse` to disable.

## How it works

```mermaid
flowchart TB
    MD["📄 tasks.md<br/><i>freeform text</i>"] --> P["Planner<br/><i>an LLM CLI</i>"]
    P -->|JSON manifest| V["Validate<br/><i>schema · cycles · deps</i>"]
    V -->|invalid| R["Repair ×1<br/>→ linear fallback"]
    R --> V
    V --> G["DAG<br/><i>topological layers</i>"]
    G --> GATE{"Preview<br/>& confirm"}
    GATE -->|approved| S["Scheduler<br/><i>budgets · write-lock</i>"]

    S --> T1["task: design-api"]
    S --> T2["task: gen-schema"]
    S --> T3["task: build-ui"]

    T1 --> AD["Provider adapters<br/><i>argv · prompt delivery · event parsing</i>"]
    T2 --> AD
    T3 --> AD

    AD --> C1["codex"]
    AD --> C2["claude"]
    AD --> C3["copilot"]
    AD --> C4["opencode"]

    C1 --> RES["task_result JSON<br/><i>status · summary · notes</i>"]
    C2 --> RES
    C3 --> RES
    C4 --> RES

    RES -->|ok| BUS["Context bus<br/><i>feeds dependents</i>"]
    RES -->|needs_input| ASK["Bubble question<br/>→ resume session"]
    RES -->|failed| REC["Classify failure<br/>→ resumable state"]

    BUS --> S
    ASK --> S
    REC --> OUT["Report<br/><i>summaries · flagged notes</i>"]
    BUS --> OUT
```

Five ideas do most of the work:

- **JSON on the wire, both directions.** Every exchange with a provider is a validated envelope, never prose. `codex` and `claude` enforce the result schema natively. A question from an agent is a `status: "needs_input"` field — not a question mark spotted in a stream.
- **The planner picks a provider, never a command.** Manifests carry a provider name from a closed enum; adapters alone build `argv`. `shell: true` is banned repo-wide.
- **Nothing paid-for is ever redone.** Progress is checkpointed before each transition. Run out of credits mid-graph and `baya resume <runId> --provider claude` picks up exactly where it stopped. Within a run, no task rediscovers what another already found: commands that worked, commands that failed, and files already touched are derived from the providers' own logs — costing nothing to produce — and handed to every later task.
- **Providers are watched, not trusted.** Their flag surfaces are live-probed and contract-tested, their output is ANSI-stripped and schema-validated.

## Providers

Verified 2026-08-28 by live invocation, not from documentation.

| Provider                                                | Non-interactive | Schema enforcement        | Status           |
| :------------------------------------------------------ | :-------------- | :------------------------ | :--------------- |
| [`codex`](https://github.com/openai/codex)              | `codex exec`    | ✅ file in / file out     | ✅ verified      |
| [`claude`](https://claude.com/claude-code)              | `claude -p`     | ✅ inline `--json-schema` | ✅ verified      |
| [`copilot`](https://github.com/github/copilot-cli)      | `copilot -p`    | ❌                        | ⚠️ partial       |
| [`opencode`](https://github.com/sst/opencode)           | `opencode run`  | ❌                        | ⚠️ partial       |
| [`gemini`](https://github.com/google-gemini/gemini-cli) | `gemini -p`     | ❌                        | deferred to v1.1 |

Full flag surfaces, event shapes, and capability matrix: [`wiki-llm/providers.md`](wiki-llm/providers.md).

## Repo layout

```
wiki-llm/     documentation — the source of truth
specs/001/    design record: what the original spec got wrong, and the plan
src/          (not yet)
test/         (not yet)
```

## Documentation

[`wiki-llm/index.md`](wiki-llm/index.md) routes to everything — architecture, the JSON protocol, provider surfaces, execution semantics, recovery, logging, CLI reference, testing, and conventions.

Working on baya? Start with [`wiki-llm/conventions.md`](wiki-llm/conventions.md), then [`specs/001/02-plan.md`](specs/001/02-plan.md).

## Contributing

Contributions are welcome — the work is broken into 52 sequenced tasks in [`specs/001/02-plan.md`](specs/001/02-plan.md), each with its own done-criteria, so there is plenty that can be picked up independently.

Before opening a PR:

```bash
npm run typecheck && npm run lint && npm test
```

A few rules that are load-bearing rather than stylistic — the full list is in [`wiki-llm/conventions.md`](wiki-llm/conventions.md):

- No `shell: true`, ever. Spawns take `argv: string[]`.
- Never document a provider flag you have not actually run.
- Never regex a model's prose for meaning — semantics come from validated JSON.
- Update the affected `wiki-llm/` page in the same commit as the change.
- Read provider event shapes out of a recorded run in `.baya/runs/`, not out of a provider's docs.
- Tests never touch the network; the contract tier is opt-in via `BAYA_CONTRACT=1`.

Adding a provider is deliberately small: one adapter, one capability block, one section in `providers.md`, one contract test.

**Use Baya on Baya.** Every run leaves `.baya/runs/<runId>/` behind — real provider event streams, on a real repository, for free. That corpus is the best fixture set the project has: it is where the `codex` `file_change` bug was found, and where cross-task memory's first two heuristics were caught being wrong. Mine it before inventing an input, then pin what you find with a committed test. [`wiki-llm/testing.md`](wiki-llm/testing.md#dogfooding-your-own-runs-are-the-fixture-set) has the method. `.baya/` is gitignored and holds your prompts and source excerpts — evidence for you, never an issue attachment.

## Adding or overriding a model

Add model entries to `~/.config/baya/config.json` when a provider's catalog is missing a model or has stale metadata. `modelCatalog` is keyed by provider; each entry supplies the exact provider `id`, optional short `aliases`, and a one-line `description`:

```json
{
  "modelCatalog": {
    "copilot": [
      {
        "id": "vendor-model-slug",
        "aliases": ["short-name"],
        "description": "one-line description"
      }
    ]
  }
}
```

For example, if the built-in Copilot slug `claude-sonnet-4.6` is rejected by your installed CLI, but that CLI accepts `claude-sonnet-4.5`, map the old name to the accepted id and add that id to the Copilot catalog:

```json
{
  "modelAliases": {
    "claude-sonnet-4.6": "claude-sonnet-4.5"
  },
  "modelCatalog": {
    "copilot": [
      {
        "id": "claude-sonnet-4.5",
        "aliases": ["sonnet45"],
        "description": "Anthropic Claude Sonnet 4.5"
      }
    ]
  }
}
```

`modelAliases` is the shortcut for a nickname: `{ "cheap": "gpt-5.6-luna" }` lets tasks name `cheap` without adding a catalog entry. Set one from the CLI with `baya config set modelAliases.cheap gpt-5.6-luna`. User catalog entries merge by provider and model id, so an entry with an existing id replaces that built-in entry while leaving the others intact. `baya config refresh-models` keeps them: it rewrites only the cached `opencode` list, and prunes entries that are byte-identical to a built-in one (nothing you changed).

Contributing a corrected entry to `BUILTIN_CATALOG` in `src/providers/catalog.ts` is welcome, but never required; user config overrides exist for exactly this kind of provider drift.

## FAQ

**Why not just use one CLI's built-in agent?** Because you probably pay for more than one, and they are good at different things. Baya lets a task list say "plan with one, build with another" and handles the plumbing.

**Can this save me money?** Yes, three ways. A task list picks the model per task, so the light steps can run on a cheap model (`luna`, `terra`) while the expensive ones are reserved for the work that earns them. Beyond that, tasks stop starting blind: what earlier tasks in a run found — which commands work, which fail, which files were already changed — is derived from the providers' own logs and passed to later tasks, so nobody pays twice to discover the same thing. And a chain of tasks on the same model continues in one provider session instead of spawning cold each time, which keeps the prompt cache warm. You are still spending under subscriptions you already pay for — Baya just stops the top-tier model from doing work a cheaper one would have done fine, and stops every task from re-reading the repo from scratch.

Both are on by default and switchable off: `--no-memory`, `--no-session-reuse`.

**Does this need API keys?** No. It drives locally installed CLIs under whatever subscription you already have.

**Is it safe to run in parallel?** Tasks the planner marked `read-only` run concurrently; anything `read-write` is serialized by the scheduler. `access` is about what a task needs permission to _do_, not what it edits — a task that only runs the test suite is `read-write`, because a runner that cannot write its cache cannot run. One Baya runs per directory — a second is refused rather than left to fight over the same files. To run two task lists against one repo, give each its own `git worktree`.

## License

[MIT](LICENSE) © 2026 Julio Cesar Martin. Contributions are accepted under the same license.
