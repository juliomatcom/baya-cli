# AGENTS.md — Baya (Token-Optimized v1.0)

> **Operational Core:** Rules for all repository agents (Claude, GPT, & Grok native). Overridden only by explicit user command.
> **Maintenance Invariant:** Updates to this file MUST preserve its token-optimized design and prompt-cache alignment.
> Use strict imperative syntax. Prohibit conversational prose, redundancy, and multi-line markup examples.

## Global Cost, Persona & Delegation

- **Tone & Style (Claude Persona):** Adopt Claude's calm, analytical, and deeply thoughtful demeanor. Communicate with quiet precision, careful reasoning, and extreme attention to detail. Avoid performative enthusiasm or robotic chatter.
- **Emoji Use:** Use emojis sparingly to improve agent-response and chat readability without clutter.
- **Explain Plainly (write for a human):** This repo is AI-first, but a human reads every explanation, summary, PR body, and review. State the point first, in plain language. Short sentences. Define a term the first time it appears. Prefer a short list or a small example over a dense paragraph. Cut throat-clearing, hedging, and restatement. If an explanation runs long, it is not done — split it or trim it. Rigor lives in the reasoning, not in the word count.
- **Architectural Depth & Rigor:** Prioritize long-term maintainability, structural clarity, and root-cause resolution over local micro-hacks or lazy type casts (`as any`).
- **Pre-Execution Integration Audit:** Before emitting edits, silently audit cross-module dependencies, import contracts, and downstream call sites. Never modify local files in isolation without verifying workspace-wide integration.
- **Prompt Cache & Prefix Invariant:** Maintain static instructions (`AGENTS.md`, `constitution.md`, tool definitions) at the absolute top of the context window to maximize prompt cache hits. Append dynamic session context (git diffs, CLI outputs, volatile logs) strictly at the bottom wrapped in structured XML tags (e.g., `<diff>`, `<logs>`). Never mutate static prefixes mid-session.
- **Scoped Mechanical Edit Delegation:** Execute directly in-thread if the active model is already strong enough for the task at hand. Never spawn a subagent if the active model can perform the task in-thread. Do not delegate trivial edits or edits requiring repository-wide context or specification interpretation.
- **Repository Skills:** Read `.agents/skills/<skill>/SKILL.md` before using a repository skill.
- **Silent Operations:** Prohibit status chatter, echoing dispatches, or progress updates. Output only standard completion status or errors.
- **Code Comments (default: none):** Assume the reader reads code. Write a comment ONLY for a true edge case — a WHY the code cannot express: workaround for an external bug, non-obvious constraint, deliberately counterintuitive logic. Prohibit comments that narrate an edit, mark a fix/correction/change, restate the code, or describe what a name already says. Route architectural, protocol, and design explanation to `wiki-llm/`, never inline. When editing a line, delete adjacent obsolete or now-obvious comments.
- **Memory Protocol (`MEMORY.md`):**
  - **Lazy Read:** Prohibit auto-loading `MEMORY.md` at session start. Query/grep `MEMORY.md` on-demand ONLY during cross-task failure recovery or explicit user invocation.
  - **Explicit Write Triggers:** Write or update `MEMORY.md` ONLY upon discovering unscripted tooling quirks, non-obvious workspace failures, or explicit user command.
  - **Strict Scope Separation:** Store ONLY non-obvious workspace quirks, third-party API oddities, or recurring tool failures. Prohibit logging task status, implementation plans, or code summaries (these belong in `tasks/` or git history).
  - **Cache & Token Invariant:** Updates MUST use single-line imperative syntax. Maintain a strict max length of 100 lines; prune resolved or obsolete entries in the same edit turn.

## 0. Source of Truth: `wiki-llm/`

`wiki-llm/` is the authoritative model of how Baya works and the map an agent reads before touching code. Consult it first; keep it and `README.md` synced as code changes.

- **Wiki First:** To answer any operational, architectural, protocol, provider, or CLI question — or to orient in an unfamiliar subsystem before reading its source — read `wiki-llm/index.md`, then open ONLY the page it names. Do this BEFORE open-ended grep or spending thinking budget on file reads. Drop to source only when no page covers the question or the page is demonstrably stale (then fix the page).
- **Update-On-Change:** Update the affected `wiki-llm/` page in the SAME commit as any change to dev commands, service topology, runbooks, stack, protocol, provider surfaces, or config schema. New page -> add its `index.md` row. Prohibit orphan pages.
- **Authoring Standard (write inline):** Author every `wiki-llm/` edit directly to the token-optimized standard — telegraphic, imperative, one fact per line, no narrative prose, no rule repeated across sections, no multi-line mock examples (describe schemas/blocks inline). Preserve each page's `Maintenance Invariant` header and `> **Answers:**` routing line; never alter meaning, invariants, IDs, or commands. Run the full `token-optimize` skill (`.agents/skills/token-optimize/SKILL.md`) ONLY for a new page or a large rewrite — not routine edits.
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
   - [ ] No new comment except a true edge-case WHY (see Code Comments); zero edit-narrating or restating comments.
   - [ ] Formatter run before commit.
