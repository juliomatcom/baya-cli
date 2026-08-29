import { z } from "zod";
import { ProviderIdSchema } from "../manifest/index.js";
import type { Catalog } from "../providers/catalog.js";

/** Config schema (config.md §Schema). Every key here exists in `src/config/`. */
export const CONFIG_VERSION = 1;

const ProviderSettingsSchema = z
  .object({
    /** Absolute path override for the binary; skips the resolution chain. */
    bin: z.string().optional(),
    maxConcurrency: z.number().int().positive().optional(),
  })
  .strict();

const DefaultsSchema = z
  .object({
    provider: ProviderIdSchema.nullable().optional(),
    /** `null` => the provider's own default. The recommended value. */
    model: z.string().nullable().optional(),
  })
  .strict();

/**
 * User-defined model nicknames: `{ "luna": "gpt-5.6-luna", "fast": "haiku" }`.
 * A task (or the planner, reading the task list) may then name `luna`, and Baya
 * expands it to the real id before routing. Pure string substitution — no API
 * call, so it costs nothing, unlike validating an id against a provider.
 */
const ModelAliasesSchema = z.record(z.string().min(1), z.string().min(1));

/**
 * The cached model catalog written at first run: the hardcoded lists for
 * `codex`/`claude`/`copilot` plus whatever `opencode models` returned, so a
 * run resolves names without touching the network. `baya config refresh-models`
 * rewrites it.
 */
const CatalogModelSchema = z
  .object({
    id: z.string().min(1),
    aliases: z.array(z.string()).default([]),
    description: z.string().default(""),
  })
  .strict();
const ModelCatalogSchema = z.record(ProviderIdSchema, z.array(CatalogModelSchema));

/** One config file, as read from disk. Every key optional — layers merge. */
export const ConfigFileSchema = z
  .object({
    version: z.literal(CONFIG_VERSION).optional(),
    defaults: DefaultsSchema.optional(),
    planner: DefaultsSchema.optional(),
    providers: z.record(ProviderIdSchema, ProviderSettingsSchema).optional(),
    modelAliases: ModelAliasesSchema.optional(),
    modelCatalog: ModelCatalogSchema.optional(),
  })
  .strict();
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

/** The merged view. `null` is a real answer here; `undefined` never survives merge. */
export interface ResolvedConfig {
  defaults: { provider: z.infer<typeof ProviderIdSchema> | null; model: string | null };
  planner: { provider: z.infer<typeof ProviderIdSchema> | null; model: string | null };
  providers: Partial<Record<z.infer<typeof ProviderIdSchema>, ProviderSettings>>;
  /** Nickname -> real model id, merged key-by-key across layers. */
  modelAliases: Record<string, string>;
  /** Cached catalog (built-in lists + live `opencode models`), merged per provider by id. */
  modelCatalog: Catalog;
}

export const BUILTIN_CONFIG: ResolvedConfig = {
  defaults: { provider: null, model: null },
  planner: { provider: null, model: null },
  providers: {},
  modelAliases: {},
  modelCatalog: {},
};

/** Keys `baya config set` and `--show` address, in display order. */
export const SETTABLE_KEYS = [
  "defaults.provider",
  "defaults.model",
  "planner.provider",
  "planner.model",
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];
