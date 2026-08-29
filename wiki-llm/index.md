# wiki-llm — Baya Documentation Index

> **Maintenance Invariant:** Routing table only. One row per page. Prohibit orphan pages. Prohibit content here — content lives in the page. Update this row set in the SAME commit as any new/renamed page.
> **Answers:** Which wiki page answers my question?

Baya is a local multi-provider CLI orchestrator: a freeform task list (Markdown, plain text, YAML, any UTF-8 text) → LLM-planned JSON DAG → parallel dispatch to local agent CLIs (`opencode`, `codex`, `claude`, `copilot`) over a strict JSON protocol.

| Page                               | Answers                                                                                                                      |
| :--------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md) | What are the layers/modules, how does data flow, what is the task state machine, where does code live?                       |
| [protocol.md](protocol.md)         | What JSON goes in and out of a provider? Manifest, `task_request`, `task_result`, `ProviderEvent` schemas and parsing rules. |
| [providers.md](providers.md)       | What is each provider CLI's real flag surface, capability set, binary resolution path, and drift policy?                     |
| [execution.md](execution.md)       | How are tasks scheduled, made parallel, locked, isolated, failed, retried, parked, resumed, and interrupted?                 |
| [config.md](config.md)             | Where does config live, what overrides what, what happens on first run, how do I change my default provider?                 |
| [recovery.md](recovery.md)         | How is progress tracked, what is recorded on failure, and how does a run resume after a crash or exhausted credits?          |
| [logging.md](logging.md)           | What does Baya record about its own behavior, where does it go, and what is the full event vocabulary?                       |
| [cli.md](cli.md)                   | What commands and flags does `baya` expose, and what are the exit codes?                                                     |
| [testing.md](testing.md)           | How is any of this tested without spending money? Fake-provider harness, test tiers, commands.                               |
| [conventions.md](conventions.md)   | Repo layout, TS/ESM/Jest setup, hard rules, definition of done, license (MIT).                                               |

## Status

Landed: M0 foundation, M1 walking skeleton, M3 provider breadth. `baya ./tasks.md` plans → renders DAG → confirms → resolves task-named models → runs sequentially → streams provider output → writes artifacts → prints report with **Flagged** section.

- Protocol: zod schemas, manifest validation (cycle paths), pure graph layer, degradation ladder (native/verbatim/fenced/synthesized).
- Providers: `codex`/`claude`/`opencode`/`copilot` adapters, registry + `baya doctor`, model catalog + resolution + model gate, failure classifier, contract tier (`BAYA_CONTRACT=1`).
- Runtime: context bus (`link-only`/`truncate`), `state.json` checkpointing, directory lock, layered config + wizard + `modelAliases`/`modelCatalog`, `ora` progress.

Sequential still — parallelism, retries, resume, signal teardown are M2. Plan + build order: [../specs/001/02-plan.md](../specs/001/02-plan.md). Refinement record: [../specs/001/](../specs/001/) (`00-validation.md`, `01-spec.md`, `02-plan.md`).

## Authoring

Write every page to the `token-optimize` skill's rules as you edit (telegraphic, imperative, one fact per line, no prose, no mock blocks), mandated by `AGENTS.md` §0. Run the full `/token-optimize` skill only for a new page or large rewrite. Keep the Maintenance Invariant header and `> **Answers:**` line.
