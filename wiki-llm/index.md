# wiki-llm — Baya Documentation Index

> **Maintenance Invariant:** Routing table only. One row per page. Prohibit orphan pages. Prohibit content here — content lives in the page. Update this row set in the SAME commit as any new/renamed page.
> **Answers:** Which wiki page answers my question?

Baya is a local multi-provider CLI orchestrator: freeform Markdown → LLM-planned JSON DAG → parallel dispatch to local agent CLIs (`opencode`, `codex`, `claude`, `copilot`) over a strict JSON protocol.

| Page | Answers |
| :-- | :-- |
| [architecture.md](architecture.md) | What are the layers/modules, how does data flow, what is the task state machine, where does code live? |
| [protocol.md](protocol.md) | What JSON goes in and out of a provider? Manifest, `task_request`, `task_result`, `ProviderEvent` schemas and parsing rules. |
| [providers.md](providers.md) | What is each provider CLI's real flag surface, capability set, binary resolution path, and drift policy? |
| [execution.md](execution.md) | How are tasks scheduled, made parallel, locked, isolated, failed, retried, parked, resumed, and interrupted? |
| [config.md](config.md) | Where does config live, what overrides what, what happens on first run, how do I change my default provider? |
| [recovery.md](recovery.md) | How is progress tracked, what is recorded on failure, and how does a run resume after a crash or exhausted credits? |
| [logging.md](logging.md) | What does Baya record about its own behavior, where does it go, and what is the full event vocabulary? |
| [cli.md](cli.md) | What commands and flags does `baya` expose, and what are the exit codes? |
| [testing.md](testing.md) | How is any of this tested without spending money? Fake-provider harness, test tiers, commands. |
| [conventions.md](conventions.md) | Repo layout, TS/ESM/Jest setup, hard rules, definition of done. |

## Status
M0 foundation landed through M0.7: toolchain scaffold, Jest+ESM, the `no-shell-exec` and chalk-import-restriction lint rules, the fake-provider test harness, the structured logger, offline CI, and `src/ui/theme.ts`. No product behavior yet — that starts at M1. Refinement record: [../specs/001/](../specs/001/) — `00-validation.md` (what was wrong with the original spec), `01-spec.md` (refined spec v2), `02-plan.md` (phased task plan).

## Known documentation gaps
- `.agents/skills/token-optimize/SKILL.md` is referenced by `AGENTS.md` §0 but **does not exist**. Pages here follow its style by convention; author the skill or drop the reference.
