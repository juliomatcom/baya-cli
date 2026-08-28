import { z } from "zod";
import { ProviderIdSchema } from "../manifest/index.js";

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

/** One config file, as read from disk. Every key optional — layers merge. */
export const ConfigFileSchema = z
  .object({
    version: z.literal(CONFIG_VERSION).optional(),
    defaults: DefaultsSchema.optional(),
    planner: DefaultsSchema.optional(),
    providers: z.record(ProviderIdSchema, ProviderSettingsSchema).optional(),
  })
  .strict();
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

/** The merged view. `null` is a real answer here; `undefined` never survives merge. */
export interface ResolvedConfig {
  defaults: { provider: z.infer<typeof ProviderIdSchema> | null; model: string | null };
  planner: { provider: z.infer<typeof ProviderIdSchema> | null; model: string | null };
  providers: Partial<Record<z.infer<typeof ProviderIdSchema>, ProviderSettings>>;
}

export const BUILTIN_CONFIG: ResolvedConfig = {
  defaults: { provider: null, model: null },
  planner: { provider: null, model: null },
  providers: {},
};

/** Keys `baya config set` and `--show` address, in display order. */
export const SETTABLE_KEYS = [
  "defaults.provider",
  "defaults.model",
  "planner.provider",
  "planner.model",
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];
