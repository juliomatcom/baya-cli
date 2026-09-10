```
▗▄▄▖  ▗▄▖▗▖  ▗▖▗▄▖      ▗▄▄▖▗▖   ▗▄▄▄▖
▐▌ ▐▌▐▌ ▐▌▝▚▞▘▐▌ ▐▌    ▐▌   ▐▌     █         (º>
▐▛▀▚▖▐▛▀▜▌ ▐▌ ▐▛▀▜▌    ▐▌   ▐▌     █      //(  )
▐▙▄▞▘▐▌ ▐▌ ▐▌ ▐▌ ▐▌    ▝▚▄▄▖▐▙▄▄▖▗▄█▄▖     //¯\\

```

**Run a list of coding tasks across the AI subscriptions you already use.**

[![CI](https://github.com/dephelion/baya-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/dephelion/baya-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/baya-cli)](https://www.npmjs.com/package/baya-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-baya--cli.depre.net-16a34a)](https://baya-cli.depre.net)

**Website:** [baya-cli.depre.net](https://baya-cli.depre.net) — features, consensus, docs, and FAQ.

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

## Documentation

The full picture lives on the website — no need to scroll a giant README:

- **[Features](https://baya-cli.depre.net/features)** — everything Baya does.
- **[Consensus](https://baya-cli.depre.net/ai-consensus)** — multi-model AI consensus: several CLIs review one spec, diff, or question and report where they agree.
- **[Docs](https://baya-cli.depre.net/docs)** — install, task lists, model routing, run, consensus, the CLI reference, providers, configuration, recovery, and how it works.
- **[FAQ](https://baya-cli.depre.net/faq)** — why Baya sits alongside your CLIs, what it does for your bill, and whether parallel runs are safe.

## Contributing

Contributions are welcome. [`wiki-llm/index.md`](wiki-llm/index.md) is the technical source of truth — architecture, the JSON protocol, provider surfaces, execution semantics, recovery, logging, the CLI reference, consensus, testing, and conventions. Start with [`wiki-llm/conventions.md`](wiki-llm/conventions.md), then the design records in [`specs/`](specs/) — `001` for the run, `002-ai-consensus` for the debate engine.

Before opening a PR:

```bash
npm run typecheck && npm run lint && npm test
```

## License

[MIT](LICENSE) © 2026 Julio Cesar Martin. Contributions are accepted under the same license.
