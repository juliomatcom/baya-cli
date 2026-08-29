# Configuration & First-Run Setup

> **Maintenance Invariant:** Config schema, precedence, and the setup wizard. Every key here must exist in `src/config/`. Update in the SAME commit as any schema or precedence change.
> **Answers:** Where does config live, how do layers override each other, what happens on first run, and how does the user change their default provider later?

## Precedence

Highest wins. Every value records its source so `baya config --show` can explain itself.

| # | Layer | Location |
| :-- | :-- | :-- |
| 1 | CLI flags | `--default-provider`, `--planner-model`, … |
| 2 | Env | `BAYA_*` |
| 3 | Project | `./.baya/config.json` (gitignored — personal overrides, not shared) |
| 4 | **User** | `$XDG_CONFIG_HOME/baya/config.json`, else `~/.config/baya/config.json` |
| 5 | Built-in | provider defaults |

The setup wizard writes **layer 4**, so a machine-wide choice is made once and every project inherits it.

## Schema

```json
{
  "version": 1,
  "defaults": { "provider": "codex", "model": null },
  "planner":  { "provider": "codex", "model": null },
  "providers": {
    "codex":  { "bin": "/custom/path/codex", "maxConcurrency": 2 },
    "claude": { "maxConcurrency": 1 }
  },
  "modelAliases": { "fast": "gpt-5.6-luna" },
  "modelCatalog": { "codex": [ { "id": "gpt-5.6-luna", "aliases": ["luna"], "description": "…" } ], "opencode": [ … ] }
}
```

`model: null` means **use the provider's own default** — the recommended value for `defaults`/`planner`.

`defaults` is the fallback for tasks; `planner` parses the Markdown into a DAG. The wizard sets both from one answer; edit the file to split them.

`modelAliases` — user nicknames, `nickname -> real id`. Set with `baya config set modelAliases.<name> <id>` (`… null` drops one). Merged key-by-key across layers.

`modelCatalog` — the resolution catalog, written at first run: the hardcoded lists for `codex`/`claude`/`copilot` (from `src/providers/catalog.ts`) plus whatever `opencode models` returned. `baya config refresh-models` rewrites it. See **Model resolution** below.

## First-run wizard

### Trigger

Runs only when **all** hold: no user config exists · the command needs a provider (`run`, `plan`) · stdin **and** stdout are TTYs · no explicit provider flag was passed.

Never runs for `doctor`, `config`, `--help`, `--version`, nor when `--default-provider` is given, `--yes` is set, `CI=true`, or `BAYA_NO_INPUT=1`.

### Flow — two questions, then continue

**Q1 — Provider.** Only providers actually resolved on this system are selectable; undetected ones are listed **disabled with an install hint**, so the list doubles as discovery.

```
? Default provider for Baya
❯ codex      0.5x   ~/.local/bin/codex
  claude     2.1.251
  opencode   1.2x
  ─────────────
  copilot    not installed — npm i -g @github/copilot
```

**Q2 — Model.** Composed per provider from what that CLI can actually tell us:

```
? Default model for codex
❯ Provider default (recommended)
  gpt-5.4-codex
  Enter a model name manually…
```

The model picker is built from the catalog the wizard is about to store:

| Provider | Catalog source |
| :-- | :-- |
| `opencode` | **live** — `opencode models` (≈190 entries, `provider/model` form) |
| `codex` / `claude` / `copilot` | **hardcoded** in `src/providers/catalog.ts` — these CLIs have no list command |

Each entry is `{ id, aliases, description }`; the description is shown in the picker and scored during best-match. The wizard writes the whole catalog to `modelCatalog` so every later run resolves names offline.

**No CLI validates a model name cheaply** (`codex` HTTP 400s, `claude` reports `unrecognized_model`, neither enumerates), so Baya does not call one — it resolves against the stored catalog instead (**Model resolution** below) and only spawns once the id is known.

Then: write the config, print its path, and **continue with the command the user originally ran.** Never make them re-invoke.

## Model resolution

Every run, before the plan gate, each task that **names** a model is resolved (`src/ui/model-gate.ts` + `src/providers/catalog.ts`, M3.6):

1. **user alias** — a `modelAliases` entry, followed recursively;
2. **exact** — the id or a catalog alias (`luna` → `gpt-5.6-luna`), case-insensitive;
3. **best match** — a similarity score (exact/prefix/substring, character-bigram Dice for typos, token overlap, and a discounted description match) over every catalog entry;
4. **no confident match** — the plan gate asks: pick the best match, run that provider on its default, or exit. `--yes`/non-TTY accepts a best match only at score ≥ 0.85, else exits `2`.

**A task that named a model never silently runs on the default.** An explicit `task.provider` wins ties; then the run default. `providerForModel` (`src/manifest/aliases.ts`) still supplies the provider for a plausible-looking literal id that is not in the catalog.

`baya config refresh-models` re-fetches the `opencode` list and rewrites `modelCatalog`; the hardcoded lists come along unchanged. Edit `src/providers/catalog.ts` when a built-in list drifts.

### Non-TTY and zero-provider behavior

A wizard that blocks a pipe is the worst failure mode in the system, so the fallbacks are explicit:

| Situation | Behavior |
| :-- | :-- |
| No config, not a TTY, **exactly one** provider found | Use it, warn to stderr, proceed. |
| No config, not a TTY, **several** providers found | Exit `2`: pass `--default-provider` or run `baya config`. Never prompt. |
| **Zero** providers found (any context) | Exit `2` with install hints, pointing at `baya doctor`. |

## Commands

| Command | Purpose |
| :-- | :-- |
| `baya config` | Re-run the wizard and overwrite the stored defaults. |
| `baya config --show` | Print the resolved config **with the source layer of each value**, plus `modelAliases` and `modelCatalog` counts. |
| `baya config refresh-models` | Re-fetch `opencode models` and rewrite `modelCatalog` (hardcoded lists unchanged). |
| `baya config set <key> <value>` | Non-interactive set: `defaults.*`, `planner.*`, or `modelAliases.<name>` (value `null` drops it). |
| `baya config path` | Print the user config file path. |

## Implementation notes

- **`@inquirer/prompts`** (v8, ESM — same project as `inquirer`, modular rather than the v14 monolith). Uses `select`, `search`, `input`.
- **Keep the wizard's logic pure.** `buildProviderChoices(detected)` and `buildModelChoices(provider, enumerated)` are pure functions returning choice descriptors; only the thin prompt call touches I/O. Unit-test the pure half — **no test may ever open a prompt.**
- `--default-provider` and `BAYA_NO_INPUT=1` bypass the wizard entirely, keeping CI and the test suite away from interactive code paths.
- Config writes are atomic (tmp + `rename`), like `state.json`.
- A malformed user config is a clear error naming the file and the offending key — never a silent reset that discards the user's settings.
