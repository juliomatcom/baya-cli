---
name: token-optimize
description: 'Audit and compress repository configuration, agent files, or prompt documentation (e.g., AGENTS.md, specifications, task definitions) to maximize token efficiency. Strips prose and redundancies while locking down 100% of underlying technical constraints, requirements, and invariants.'
license: MIT
allowed-tools: Read, Write, Edit, Bash
---

# Token Optimize Document (Telegraphic Compression)

## Operational Workflow

### 0. Target Evaluation

1. Accept file paths specified by the user (e.g., `AGENTS.md`, `specs/001-tapescan/spec.md`).
2. Verify target files exist on the hard drive before processing. Abort if paths are invalid.

### 1. Leak Analysis (Audit Phase)

Scan the target file strictly for the **Three Core Token Leaks**:

- **Conversational Prose:** Narrative framing, introductory explanations, polite transitions, or justifications.
- **Structural Redundancy:** Overlapping definitions, rules repeated across sections, or duplicate checklist criteria.
- **Template Inflation:** Heavy, literal markdown or multi-line mock files code examples that can be replaced with structural/semantic inline rules.

### 2. Immutable Preservation Gate (Safety Check)

Before altering a single line, index and isolate the logical invariants. You are **FORBIDDEN** from modifying, dropping, or relaxing:

- Explicit alphanumeric requirement IDs (`FR-###`, `NFR-###`, `T-###`).
- Core system invariants, non-negotiable architectural layers, or technical limitations.
- Traceability links or file-hierarchy logic.

### 3. Telegraphic Refactoring

Rewrite the contents into a token-dense structure adhering to these compilation rules:

1. **Imperative Directives:** Convert descriptive descriptions into aggressive, direct commands (e.g., Change _"You should always use the logger"_ to _"Log via @tapescan/logger only"_).
2. **Consolidate Scope:** Merge repetitive sections into high-density rule lists.
3. **De-duplicate Layouts:** Strip visual content mockups. Describe file schemas or block structures using clean structural fields or inline parameters.

### 4. Injection of the Maintenance Invariant

Prepend or anchor a strict metadata note to the top of the newly generated file to lock down its architectural density against future conversational drift.

- _Template text:_ `> **Maintenance Invariant:** Updates to this file MUST preserve its token-optimized design. Use strict imperative syntax. Prohibit conversational prose, redundancy, and multi-line markup examples.`

### 5. Final Code Serialization

1. Overwrite the file on disk or provide the optimized output block.
2. Provide a clear metrics summary to the user detailing:
   - Initial character/word count.
   - Post-optimization character/word count.
   - Estimated token savings percentage.

## Core Restrictions (Don'ts)

- ❌ Don't alter the meaning, severity, or scope of any architectural instruction.
- ❌ Don't drop error states, target commands, tool restrictions, or error-tracking loops.
- ❌ Don't introduce nested markdown configurations that risk breaking parser engines.
- ❌ Don't summarize or omit necessary configuration keys to save space; compression must apply to style, never to structural data.
