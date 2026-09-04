```
▗▄▄▖  ▗▄▖▗▖  ▗▖▗▄▖      ▗▄▄▖▗▖   ▗▄▄▄▖
▐▌ ▐▌▐▌ ▐▌▝▚▞▘▐▌ ▐▌    ▐▌   ▐▌     █         (º>
▐▛▀▚▖▐▛▀▜▌ ▐▌ ▐▛▀▜▌    ▐▌   ▐▌     █      //(  )
▐▙▄▞▘▐▌ ▐▌ ▐▌ ▐▌ ▐▌    ▝▚▄▄▖▐▙▄▄▖▗▄█▄▖     //¯\\

```

**Run a list of coding tasks across the AI subscriptions you already use.**

[![CI](https://github.com/juliomatcom/baya-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/juliomatcom/baya-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/baya-cli)](https://www.npmjs.com/package/baya-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-baya--cli.depre.net-16a34a)](https://baya-cli.depre.net)

**Website:** [baya-cli.depre.net](https://baya-cli.depre.net) — features, docs, and FAQ.

## One command. Multiple models. No juggling.

Baya is a zero-config command-line orchestrator for executing coding tasks with the AI agents you already have installed and authenticated. Write the actions in plain text and run one command. Baya turns them into a dependency graph, routes each task to the provider and model that fit it, and carries the run through to a report.

It works with `codex`, `claude`, `copilot`, and `opencode`. Use one default model, or choose a different model or provider for a specific task. Independent tasks run in parallel; dependent tasks wait for their prerequisites. Compatible tasks share a process, and useful findings pass forward, so you spend less time switching agents and less money repeating setup and discovery.

If a provider fails, runs out of quota, or you interrupt the command, Baya checkpoints the run and resumes the unfinished work. There is no config format, DSL, or separate API key to learn.

Tools such as [T3 Code](https://github.com/pingdotgg/t3code) focus on interactively controlling agent sessions. Baya focuses on executing a task list from start to finish. For this workflow, its advantage is automation: one command handles planning, model selection, ordering, parallel execution, context handoff, process reuse, and recovery while coordinating the subscriptions and coding agents already on your machine.

---

## Install

```bash
npm install -g baya-cli   # binary: baya
```

- Requires **Node 24+** and at least one supported CLI on your machine. Run `baya doctor` to see what it found.
- On first run `baya` asks once which provider and model to default to, stores it in `~/.config/baya/config.json`, and never asks again.
- Run `baya upgrade` any time to update every installed provider CLI to its latest version; `baya upgrade <provider>` narrows to one.

## Usage

```txt
1. Which model are you? State your actual model name and version. — luna
2. Which model are you? State your actual model name and version. — sonnet
3. Which model are you? State your actual model name and version. — mimo
```

<img width="833" height="398" alt="Screenshot 2026-08-31 at 16 29 48" src="https://github.com/user-attachments/assets/cf5920d7-5b9f-49ad-91c9-89b0fc3a7637" />

[▶️ Full demo](https://github.com/user-attachments/assets/f78724f7-3b88-4e26-a642-7e66471fe141)

### The task list

Any UTF-8 text file. Baya's planner reads it for intent — the format is yours to pick.

**Markdown** — a heading for the goal, a bullet per task:

```markdown
# Ship the orders endpoint

- Design the REST API for orders. Use Sonnet.
- Generate the DB schema from that design.
- Build the React table that consumes it — run this with codex.
- Once the schema and UI are done, write integration tests.
```

**A bare `TODO.txt`** — one task per line, numbered or not:

```text
1 Design the REST API for orders. Use Sonnet.
2 Generate the DB schema from that design.
3 Build the React table that consumes it — run this with codex.
4 Once the schema and UI are done, write integration tests.
```

**YAML** — the same intent, laid out if you think better that way:

```yaml
- id: design-api
  task: Design the REST API for orders. Use Sonnet.
- id: gen-schema
  task: Generate the DB schema from that design.
  depends_on: [design-api]
- id: build-ui
  task: Build the React table that consumes the schema. Run with codex.
  depends_on: [gen-schema]
- id: tests
  task: Write integration tests for the endpoint.
  depends_on: [gen-schema, build-ui]
```

Baya never parses these structurally — the planner reads every format for intent, so `depends_on:` and plain prose like "once the schema and UI are done" get you the same graph. Empty or binary files are rejected before planning; if the planner can't produce a graph, a deterministic splitter falls back to a linear chain in the order you wrote the tasks.

## Features

- ✅ **Works out of the box** — zero config. One prompt on first run for your default provider, then never again.
- ✅ **Multi-provider** — routes each task to `codex`, `claude`, `copilot`, or `opencode`, the CLIs you already have installed and logged in.
- ✅ **Plain-text task lists** — Markdown, `TODO.txt`, YAML, whatever you already write. No config format, no DSL.
- ✅ **LLM-planned dependency graph** — a model turns your list into a DAG; a deterministic splitter falls back to a linear chain if it can't.
- ✅ **No API keys** — drives your existing CLI subscriptions; nothing new to pay for.
- ✅ **Model-per-task** — name `luna`, `sonnet`, etc. in the task text; Baya resolves it to the real id and the provider that serves it.
- ✅ **Parallel execution** — independent `read-only` tasks run concurrently (`--max-parallel`, plus a per-provider cap); every `read-write` task takes a single in-memory writer key and runs alone, because agents sharing one working tree collide on the build, not just on files.
- ✅ **One process, many tasks** — tasks that share a provider, model and permission level are packed into a single agent process and worked through in order, so the repo is read once instead of once per task. `--group-size` (default 3), `--group-size 1` to opt out.
- ✅ **Doesn't pay twice** — what earlier tasks found (commands that worked, files changed) carries across to tasks that could not share a process. `--no-memory` to disable.
- ✅ **Preview gate** — see the full plan before anything runs; `--dry-run` shows it and runs nothing.
- ✅ **Resume** — checkpointed before every transition. Run out of credits mid-graph and `baya resume <runId>` picks up where it stopped, optionally on a different provider; `baya runs` lists what is resumable. An unfinished run ends by printing that exact command, what it will re-run, and what to fix first. A `quota` failure halts the run cleanly rather than feeding the wall every remaining task.
- ✅ **Skips what you already ticked off** — a task marked `[x]`, `[done]`, `(complete)` or ✅ is read for context and never planned as work, so re-running a part-finished list does not re-pay for what landed.
- ✅ **Ctrl+C actually stops** — SIGTERM to every provider's process group, a grace window, then SIGKILL; a second Ctrl+C skips the wait. Grandchildren are reaped, not orphaned, and the same path covers SIGTERM, SIGHUP and an uncaught crash.

> [!WARNING]
> **Status: early.** The walking skeleton (M1), provider breadth (M3), and most of concurrency & resilience (M2) have landed — `codex`, `claude`, `opencode`, and `copilot` adapters, model-catalog resolution, a parallel scheduler, `baya runs` / `baya resume`, and process-group signal teardown. Published to npm as [`baya-cli`](https://www.npmjs.com/package/baya-cli). Still open: `--on-error stop`, a parallel-aware status line, and the recovery prompt. Follow along in [`specs/001/02-plan.md`](specs/001/02-plan.md).

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

    S --> GRP{"Group<br/><i>same provider · model<br/>access · cwd</i>"}

    GRP --> P1["one process<br/><i>several tasks, in order,<br/>in one conversation</i>"]
    GRP --> P2["one process<br/><i>another model, so<br/>a group of its own</i>"]

    P1 --> AD["Provider adapters<br/><i>argv · prompt delivery · event parsing</i>"]
    P2 --> AD

    AD --> C1["codex"]
    AD --> C2["claude"]
    AD --> C3["opencode"]
    AD --> CN["…<br/><i>grok, gemini</i>"]

    C1 --> RES["task_result JSON<br/><i>one per task in the process</i>"]
    C2 --> RES
    C3 --> RES
    CN --> RES

    RES -->|ok| BUS["Context bus<br/><i>feeds dependents</i>"]
    RES -->|needs_input| ASK["Bubble question<br/>→ resume session"]
    RES -->|failed| REC["Classify failure<br/>→ resumable state"]

    RES -.->|derived facts| S
    BUS --> S
    ASK --> S
    REC --> OUT["Report<br/><i>summaries · flagged notes · how to resume</i>"]
    BUS --> OUT
```

Five ideas do most of the work:

- **JSON on the wire, both directions.** Every exchange with a provider is a validated envelope, never prose. `codex` and `claude` enforce the result schema natively. A question from an agent is a `status: "needs_input"` field — not a question mark spotted in a stream.
- **The planner picks a provider, never a command.** Manifests carry a provider name from a closed enum; adapters alone build `argv`. `shell: true` is banned repo-wide.
- **A process is the unit, not a task.** Tasks that share a provider, model, permission level and directory go into one agent process and are worked through in order — a whole layer of independent tasks, or a chain where each step builds on the last. That process orients itself once instead of once per task. This is decided separately from the DAG's shape, so the two do not line up: a six-stage chain is still one process, while one stage holding six tasks on six models is six.
- **Nothing paid-for is ever redone.** Progress is checkpointed before each transition. Run out of credits mid-graph and `baya resume <runId> --provider claude` picks up exactly where it stopped. Within a run, no task rediscovers what another already found: commands that worked, commands that failed, and files already touched are derived from the providers' own logs — costing nothing to produce — and handed to every later task.
- **Providers are watched, not trusted.** Their flag surfaces are live-probed and contract-tested, their output is ANSI-stripped and schema-validated.

## Providers

Verified by live invocation, not from documentation. "Verified" means a task
was run end to end and returned a valid `task_result` — a probed flag surface
is not enough, which is how `opencode` shipped for three days sending a prompt
its CLI never read.

| Provider                                                | Non-interactive | Schema enforcement        | Status                 |
| :------------------------------------------------------ | :-------------- | :------------------------ | :--------------------- |
| [`codex`](https://github.com/openai/codex)              | `codex exec`    | ✅ file in / file out     | ✅ verified 2026-08-28 |
| [`claude`](https://claude.com/claude-code)              | `claude -p`     | ✅ inline `--json-schema` | ✅ verified 2026-08-28 |
| [`opencode`](https://github.com/sst/opencode)           | `opencode run`  | ❌                        | ✅ verified 2026-08-31 |
| [`copilot`](https://github.com/github/copilot-cli)      | `copilot -p`    | ❌                        | ⚠️ partial             |
| [`gemini`](https://github.com/google-gemini/gemini-cli) | `gemini -p`     | ❌                        | deferred to v1.1       |
| `grok`                                                  | —               | —                         | planned, unprobed      |

`opencode` takes its prompt as the positional `[message..]` after a `--`
separator; its `-f/--file` attaches a file _to_ a message and does not carry
one. It has no permission mapping yet — `--dangerously-allow-all` and a task's
`read-only` access are both no-ops there.

A task's permission level is what it is allowed to **do**, not what it edits: a
`read-write` task can write, run commands, and reach the network; a `read-only`
task does none of the three. `codex` is the only provider that enforces this
with an OS sandbox — writes stay inside the workspace even under
`read-write` — where `claude` and `copilot` enforce it by withholding tools. A
task that must not touch the tree belongs on `codex`.

Full flag surfaces, event shapes, and capability matrix: [`wiki-llm/providers.md`](wiki-llm/providers.md).

## Repo layout

```
wiki-llm/     documentation — the source of truth
specs/001/    design record: what the original spec got wrong, and the plan
src/          the CLI, planner, providers, executor, memory
test/         unit · integration (fake provider) · contract (live CLIs)
```

## Documentation

The website has a reader-friendly tour: [baya-cli.depre.net/docs](https://baya-cli.depre.net/docs) and [/faq](https://baya-cli.depre.net/faq).

[`wiki-llm/index.md`](wiki-llm/index.md) routes to everything — architecture, the JSON protocol, provider surfaces, execution semantics, recovery, logging, CLI reference, testing, and conventions.

Working on baya? Start with [`wiki-llm/conventions.md`](wiki-llm/conventions.md), then [`specs/001/02-plan.md`](specs/001/02-plan.md).

## Contributing

Contributions are welcome — the work is broken into 62 sequenced tasks in [`specs/001/02-plan.md`](specs/001/02-plan.md), each with its own done-criteria, so there is plenty that can be picked up independently.

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

**Can this save me money?** Yes, three ways.

A task list picks the model per task, so the light steps run on a cheap model (`luna`, `terra`) while the expensive ones are reserved for work that earns them.

Then Baya spawns as few agent processes as it can. Tasks that share a provider, model, permission level and directory go into **one** process and are worked through in order — a whole layer of independent tasks, or a chain where each step builds on the last. That process reads `package.json` once, orients itself once, and keeps its context across the tasks, instead of every task paying for that from scratch. It is one long conversation rather than N cold starts.

What grouping can't cover — a task on a different model, or one that needs different permissions — is covered by memory: what earlier tasks found (which commands work, which fail, which files changed) is derived from the providers' own logs and handed to later tasks, so nobody pays twice to discover the same thing.

You are still spending under subscriptions you already pay for. Baya just stops the top-tier model from doing work a cheaper one would have done fine, and stops every task from re-reading the repo from scratch.

Both are on by default: `--group-size 1` gives every task its own process, `--no-memory` starts every task blind.

**Does this need API keys?** No. It drives locally installed CLIs under whatever subscription you already have.

**Is it safe to run in parallel?** Tasks the planner marked `read-only` run concurrently; anything `read-write` is serialized by the scheduler. `access` is about what a task needs permission to _do_, not what it edits — a task that only runs the test suite is `read-write`, because a runner that cannot write its cache cannot run. One Baya runs per directory — a second is refused rather than left to fight over the same files. To run two task lists against one repo, give each its own `git worktree`.

## License

[MIT](LICENSE) © 2026 Julio Cesar Martin. Contributions are accepted under the same license.
