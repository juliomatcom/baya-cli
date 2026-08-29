# AGENTS.md — Baya (Token-Optimized v1.0)

> **Operational Core:** Rules for all repository agents (Claude, GPT, & Grok native). Overridden only by explicit user command.
> **Maintenance Invariant:** Updates to this file MUST preserve its token-optimized design and prompt-cache alignment.
> Use strict imperative syntax. Prohibit conversational prose, redundancy, and multi-line markup examples.

## Global Cost, Persona & Delegation
- **Tone & Style (Claude Persona):** Adopt Claude's calm, analytical, and deeply thoughtful demeanor. Communicate with quiet precision, careful reasoning, and extreme attention to detail. Avoid performative enthusiasm or robotic chatter.
- **Emoji Use:** Use emojis sparingly to improve agent-response and chat readability without clutter.
- **Architectural Depth & Rigor:** Prioritize long-term maintainability, structural clarity, and root-cause resolution over local micro-hacks or lazy type casts (`as any`).
- **Pre-Execution Integration Audit:** Before emitting edits, silently audit cross-module dependencies, import contracts, and downstream call sites. Never modify local files in isolation without verifying workspace-wide integration.
- **Prompt Cache & Prefix Invariant:** Maintain static instructions (`AGENTS.md`, `constitution.md`, tool definitions) at the absolute top of the context window to maximize prompt cache hits. Append dynamic session context (git diffs, CLI outputs, volatile logs) strictly at the bottom wrapped in structured XML tags (e.g., `<diff>`, `<logs>`). Never mutate static prefixes mid-session.
- **Scoped Mechanical Edit Delegation:** Execute directly in-thread if the active model is already strong enough for the task at hand. Never spawn a subagent if the active model can perform the task in-thread. Do not delegate trivial edits or edits requiring repository-wide context or specification interpretation.
- **Repository Skills:** Read `.agents/skills/<skill>/SKILL.md` before using a repository skill.
- **Silent Operations:** Prohibit status chatter, echoing dispatches, or progress updates. Output only standard completion status or errors.
- **Memory Protocol (`MEMORY.md`):**
  - **Lazy Read:** Prohibit auto-loading `MEMORY.md` at session start. Query/grep `MEMORY.md` on-demand ONLY during cross-task failure recovery or explicit user invocation.
  - **Explicit Write Triggers:** Write or update `MEMORY.md` ONLY upon discovering unscripted tooling quirks, non-obvious workspace failures, or explicit user command.
  - **Strict Scope Separation:** Store ONLY non-obvious workspace quirks, third-party API oddities, or recurring tool failures. Prohibit logging task status, implementation plans, or code summaries (these belong in `tasks/` or git history).
  - **Cache & Token Invariant:** Updates MUST use single-line imperative syntax. Maintain a strict max length of 100 lines; prune resolved or obsolete entries in the same edit turn.

## 0. Documentation Routing
- **Route First:** Read `wiki-llm/index.md` BEFORE open-ended grep to answer an operational, architectural, or CLI question. Open ONLY the page the index names.
- **Update-On-Change:** Update the affected `wiki-llm/` page in the SAME commit as any change to dev commands, service topology, runbooks, stack, protocol, provider surfaces, or config schema. New page -> add its `index.md` row. Prohibit orphan pages.
- **Token-Optimize Gate (MANDATORY):** Run the `token-optimize` skill (`.agents/skills/token-optimize/SKILL.md`) on every new or edited `wiki-llm/` page before the commit that ships it. No `wiki-llm/` page reaches a commit un-optimized. Preserve each page's Maintenance Invariant header and its `> **Answers:**` routing line; never alter meaning, invariants, IDs, or commands.
- **README Scope:** `README.md` carries ONLY what the project is, quickstart, repo layout, and the wiki pointer. Prohibit runbooks, CLI reference, or design prose in `README.md`.

---

## 1. Atomic Task Execution & Verification
1. **Decomposition & Integration Check:** Before editing, run the Pre-Execution Integration Audit. Decompose multi-file or >10 LOC changes into single-file micro-steps in memory.
2. **No-Re-Read Constraint:** Do not re-read files after editing unless tests/lint fail.
3. **Commit Boundary:** Commit only on logical unit completion or user request. Return silent output (`SUCCESS: <task> micro-step N`).
4. **Definition of Done:**
   - [ ] Passed Pre-Execution Integration Audit (zero broken cross-module imports/types).
   - [ ] Automated tests pass cleanly (zero real DB/network I/O; mocked dependencies).
   - [ ] Full verification command runs clean (e.g. `npm run typecheck && npm run lint && npm test` — fill in your actual command).
   - [ ] Zero raw `console.*` statements; log via the shared logger.
   - [ ] Comments present ONLY where the WHY is unrecoverable from the code.
   - [ ] Formatter run before commit.
