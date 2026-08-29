# Configuration & First-Run Setup

> **Maintenance Invariant:** Config schema, precedence, wizard, model resolution. Every key here must exist in `src/config/`. Update in the SAME commit as any schema or precedence change. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** Where config lives, how layers override, what happens on first run, how the user changes their default provider and model names later.

## Precedence

Highest wins. Every value records its source for `baya config --show`.

| #   | Layer     | Location                                                               |
| :-- | :-------- | :--------------------------------------------------------------------- |
| 1   | CLI flags | `--default-provider`, `--planner-model`, …                             |
| 2   | Env       | `BAYA_*`                                                               |
| 3   | Project   | `./.baya/config.json` (gitignored — personal overrides)                |
| 4   | **User**  | `$XDG_CONFIG_HOME/baya/config.json`, else `~/.config/baya/config.json` |
| 5   | Built-in  | provider defaults                                                      |

Wizard writes **layer 4**. `defaults`/`planner`/`providers` merge per key; `modelAliases` merges per entry key; `modelCatalog` merges per provider, then by entry `id`, with higher layers winning.

## Schema

```json
{
  "version": 1,
  "defaults": { "provider": "codex", "model": null },
  "planner":  { "provider": "codex", "model": null },
  "providers": { "codex": { "bin": "/custom/path/codex", "maxConcurrency": 2 } },
  "modelAliases": { "fast": "gpt-5.6-luna" },
  "modelCatalog": { "codex": [ { "id": "gpt-5.6-luna", "aliases": ["luna"], "description": "…" } ], "opencode": [ … ] }
}
```

- `model: null` ⇒ provider's own default. `defaults` = task fallback; `planner` = parses the task list → DAG. Wizard sets both from one answer; edit the file to split.
- `modelAliases` — `nickname → real id`. `baya config set modelAliases.<name> <id>` (`… null` drops).
- `modelCatalog` — user-editable resolution catalog. `BUILTIN_CATALOG` (`src/providers/catalog.ts`) provides the base; config layers merge per provider and by entry `id`, with higher layers replacing lower entries. `baya config set modelCatalog.<provider>.<id> <description>` adds or re-describes one entry (`… null` drops it); unknown `<provider>` errors. See **Model resolution** and **What the file stores**.

### What the file stores

**Invariant: never a snapshot of `BUILTIN_CATALOG`.** The built-in lists ship in the binary; a stored copy pins them to the version that wrote it. Written files hold only what the binary cannot reproduce:

1. the live `opencode models` cache (recomputable — `opencode` is the one provider that enumerates);
2. user-authored entries — an added id, a changed `description`, an extra alias, an entry for a provider with no list command.

**Migration rule** (`withoutBuiltinEntries`, `src/providers/catalog.ts`) — applied on every rewrite (wizard, `refresh-models`), never on read:

- Entry byte-identical (`id` + `aliases` + `description`) to the built-in entry with the same `id` ⇒ **drop** — `BUILTIN_CATALOG` already provides it.
- Entry differing in `aliases` or `description` ⇒ **keep** — a deliberate override.
- `id` absent from `BUILTIN_CATALOG` ⇒ **keep** — user-added, or a built-in the shipped list has since dropped.
- `opencode` entry with no aliases and empty description ⇒ **cache**: replaced by a fresh `opencode models` list, kept as-is when that list is unavailable.
- `opencode` entry carrying an alias or description ⇒ **keep**, even when the live list no longer has that `id`.

No live list (`opencode` missing or listing nothing) ⇒ `refresh-models` warns and keeps the stored entries rather than wiping the cache.

Safe because loading merges `BUILTIN_CATALOG` under the config layers: dropping an entry equal to the base leaves the resolved catalog identical. Reads never mutate the file — an un-migrated config keeps working, just larger.

**Limitation:** an old snapshot entry whose built-in text has since changed reads as a deliberate override and is kept, shadowing the new built-in wording. Delete the entry to fall back to the shipped one.

## First-run wizard

**Trigger — ALL must hold:** no user config · command needs a provider (`run`/`plan`) · stdin AND stdout are TTYs · no explicit provider flag. Never for `doctor`/`config`/`--help`/`--version`, nor with `--default-provider` / `--yes` / `CI=true` / `BAYA_NO_INPUT=1`.

**Flow — two questions, then continue the original command.** Never re-invoke.

- **Q1 Provider.** Only resolved providers selectable; undetected ones listed disabled with an install hint (list doubles as discovery).
- **Q2 Model.** Picker from the full merged catalog (only the live `opencode` part of it is stored — see **What the file stores**). Sources: `opencode` = live `opencode models` (≈190, `provider/model` form); `codex`/`claude`/`copilot` = hardcoded `src/providers/catalog.ts` (no list command). Each entry `{ id, aliases, description }` — description shown + scored during best-match. Choices: "Provider default (recommended)" + catalog entries + "Enter manually".

**No CLI validates a model name cheaply** (`codex` HTTP 400, `claude` `unrecognized_model`, only `opencode` enumerates) — Baya never calls one. It resolves against the stored catalog and only spawns once the id is known.

## Model resolution

Every run, before the plan gate, each task that **names** a model resolves (`src/ui/model-gate.ts` + `src/providers/catalog.ts`, M3.6):

1. **user alias** — `modelAliases` entry, followed recursively;
2. **exact** — id or catalog alias (`luna` → `gpt-5.6-luna`), case-insensitive;
3. **best match** — similarity score (exact/prefix/substring, char-bigram Dice for typos, token overlap, discounted description match) over every catalog entry;
4. **no confident match** — gate prompts: best match / that provider's default / exit. `--yes` / non-TTY takes a best match only at score ≥ 0.85, else exit `2`.

**A named model never silently runs on the default.** Explicit `task.provider` wins ties, then run default. `providerForModel` (`src/manifest/aliases.ts`) supplies a provider for a plausible literal id not in the catalog. `baya config refresh-models` re-fetches `opencode` only; edit `src/providers/catalog.ts` when a built-in list drifts.

## Non-TTY / zero-provider

| Situation                                   | Behavior                                                                |
| :------------------------------------------ | :---------------------------------------------------------------------- |
| No config, not a TTY, **one** provider      | Use it, warn to stderr, proceed.                                        |
| No config, not a TTY, **several** providers | Exit `2`: pass `--default-provider` or run `baya config`. Never prompt. |
| **Zero** providers (any context)            | Exit `2` with install hints → `baya doctor`.                            |

## Commands

| Command                         | Purpose                                                                                             |
| :------------------------------ | :-------------------------------------------------------------------------------------------------- |
| `baya config`                   | Re-run the wizard, overwrite stored defaults.                                                       |
| `baya config --show`            | Resolved config + source layer per value + `modelAliases` / `modelCatalog` counts.                  |
| `baya config refresh-models`    | Re-fetch `opencode models`; rewrite `modelCatalog` = live list + user entries.                      |
| `baya config set <key> <value>` | `defaults.*`, `planner.*`, `modelAliases.<name>`, or `modelCatalog.<provider>.<id>` (`null` drops). |
| `baya config path`              | Print the user config file path.                                                                    |

## Implementation notes

- **`@inquirer/prompts`** v8 (ESM, modular). `select`, `search`, `input`.
- **Wizard logic pure.** `buildProviderChoices` / `buildModelChoices` return choice descriptors; only the thin prompt call touches I/O. Unit-test the pure half — **no test opens a prompt.**
- `--default-provider` and `BAYA_NO_INPUT=1` bypass the wizard entirely.
- Config writes atomic (tmp + `rename`), like `state.json`.
- Malformed user config ⇒ clear error naming the file + offending key. Never a silent reset.
