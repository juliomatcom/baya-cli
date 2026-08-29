# Conventions

> **Maintenance Invariant:** Repo rules, layout, toolchain. Hard rules non-negotiable; changing one requires updating its lint rule in the SAME commit. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** Repo layout. Toolchain + settings. Hard rules. Definition of done. License.

## License

**MIT** — `LICENSE` (root), copyright `2026 Julio Cesar Martin`. Opening a PR asserts the contribution is MIT-licensed. Prohibit per-file license headers. Keep `LICENSE` copyright line and `package.json` `"license"` identical. New dependency MUST be MIT/BSD/ISC/Apache-2.0 compatible.

## Toolchain

| Concern        | Choice                                                                                                                                                                                                                                                      |
| :------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime        | **Node 24** (`.nvmrc`; `engines.node >= 24`)                                                                                                                                                                                                                |
| Language       | **TypeScript**, `strict: true`, `module: NodeNext`, ESM (`"type": "module"`)                                                                                                                                                                                |
| Tests          | **Jest** + `@swc/jest`                                                                                                                                                                                                                                      |
| Validation     | `zod` — one schema per envelope, `z.infer` for types. Never hand-write a type that a schema already implies.                                                                                                                                                |
| Terminal color | **`chalk` v6** (ESM-only — matches our `type: module`). Used _only_ through `src/ui/theme.ts`.                                                                                                                                                              |
| Prompts        | **`@inquirer/prompts` v8** (ESM; modular `select`/`search`/`input`). Used _only_ in `src/config/wizard.ts` (setup), `src/ui/confirm.ts` (the plan gate), and `src/ui/model-gate.ts` (unresolved-model picker); `src/recovery/prompt.ts` joins them at M2.9. |
| Progress       | **`ora` v9** (ESM). Used _only_ through `src/ui/progress.ts`.                                                                                                                                                                                               |
| Package        | **`baya-cli`** on npm (`baya` itself is taken by an unrelated package)                                                                                                                                                                                      |
| Bin            | `baya` → `dist/cli/index.js`                                                                                                                                                                                                                                |

> **Jest + ESM friction (settled M0.2):** needs `--experimental-vm-modules` (run tests via `npm test`, never bare `npx jest`); trips on `.js` extension resolution under `NodeNext`; `chalk` v6 is ESM-only and detonates first. Fix: `@swc/jest` + `extensionsToTreatAsEsm` + `moduleNameMapper` stripping `.js` from relative imports.

## Layout

```
src/
├─ cli/        arg parsing, command routing, exit codes
├─ config/     layered config load/merge, first-run wizard
│  └─ wizard.ts  one of two modules permitted to import @inquirer/prompts
├─ planner/    task text (any UTF-8: md/txt/yaml/…) → manifest, repair, fallback
├─ manifest/   zod schemas + validation            [pure]
├─ graph/      topo sort, ready-set, descendants   [pure]
├─ providers/  one adapter per CLI + registry
├─ executor/   scheduler, budgets, locks, spawn, signals
├─ context/    result persistence, context assembly, budgeting
├─ escalation/ park queue, stdin ownership, resume dispatch
└─ ui/         DAG render, live status, report
   ├─ theme.ts    THE only module that imports chalk
   ├─ progress.ts THE only module that imports ora
   └─ confirm.ts  the plan gate; the other permitted @inquirer/prompts importer
test/
├─ unit/  integration/  contract/
└─ fixtures/fake-provider.mjs
wiki-llm/      source of truth for architecture, docs, commands
specs/001/     point-in-time refinement record
```

## Hard rules

1. **No `shell: true`.** Ever. All spawns take `argv: string[]`. Lint-enforced.
2. **The manifest never carries argv, shell strings, env vars, or executable paths.** Adapters alone construct argv. This is the privilege boundary.
3. **Never regex provider prose for meaning.** Semantics come from validated JSON fields only.
4. **Never hard-code model ids.** Unset ⇒ provider default. Model names churn.
5. **Never assume `$PATH`.** Use the resolution chain (`providers.md`).
6. **Never document an unverified flag as fact.** Mark it UNVERIFIED. The corollary for event and item shapes: read them out of a recorded run in `.baya/runs/`, never from a provider's docs ([testing.md](testing.md) §Dogfooding).
7. **All child processes spawn `detached: true`** and are killed by process group.
8. **`state.json` writes are atomic** (tmp + `rename`).
9. **No raw `console.*`** — use the shared logger. Redact secret-shaped strings before any write.
10. **Push logic into the pure layers** (`manifest`, `graph`, `context`) where it is cheap to test.
11. **Each terminal-owning library has a single importer**, lint-enforced by `no-restricted-imports`: `chalk` only in `src/ui/theme.ts`, `ora` only in `src/ui/progress.ts`, `@inquirer/prompts` only in `src/config/wizard.ts`, `src/ui/confirm.ts`, and `src/ui/model-gate.ts`. Everywhere else uses semantic tokens (`theme.ok`, `theme.taskId`). A bare `chalk.green` outside `theme.ts` is a lint error.
12. **Color never enters machine-readable output.** `--json`, `report.json`, `result.json`, `events.jsonl`, `stdout.log` are always ANSI-free — forced, not inferred from TTY detection.
13. **No test may open an interactive prompt.** Wizard logic lives in pure choice-builder functions; `BAYA_NO_INPUT=1` and `--default-provider` bypass the prompt entirely.
14. **`state.json` is written before an action is taken, never after** — a crash must never lose a transition.
15. **Restore the terminal cursor on every exit path.** `ora` hides it; SIGINT/SIGTERM/`uncaughtException` must all restore it.
16. **Stop the spinner before any prompt.** A live spinner and a prompt corrupt each other.
    16b. **All persistent terminal output goes through `src/ui/progress.ts`.** Writing straight to stderr while `ora` spins garbles the line — the progress module clears, writes, and re-renders.
17. **One Baya per directory**, enforced by `.baya/baya.lock` at startup. Coordination _within_ a run is in-memory; the lock file exists only to refuse a second process and to survive a crash.
18. **Log before acting, never after** — and never to stdout.
19. **Never encode meaning in color alone.** Every colored status also carries a glyph, so the output survives piping, `NO_COLOR`, and colorblind readers.

## Definition of done

- [ ] Pre-execution integration audit passed — zero broken cross-module imports/types.
- [ ] `npm run typecheck && npm run lint && npm test` clean.
- [ ] New behavior has a test; bug fixes have a failing-first regression test.
- [ ] No network or real-provider I/O outside the contract tier.
- [ ] Affected `wiki-llm/` page updated in the same commit, written to the `token-optimize` skill's rules inline (AGENTS.md §0); full skill run only for a new page or large rewrite; new page ⇒ `index.md` row.
- [ ] Comments only where the WHY is unrecoverable from the code.
- [ ] Formatter run before commit.

## Documentation split

| Location     | Holds                                                                                                                                                     |
| :----------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wiki-llm/`  | **Source of truth.** Architecture, protocol, provider surfaces, commands, runbooks, conventions. Kept current; every page token-optimized (AGENTS.md §0). |
| `specs/001/` | Point-in-time record of this refinement: what the original spec got wrong, the refined target, the phased plan. Not updated as code evolves.              |
| `README.md`  | Only: what Baya is, quickstart, repo layout, pointer to `wiki-llm/index.md`. No runbooks, no CLI reference.                                               |
| `AGENTS.md`  | Agent operating rules.                                                                                                                                    |
