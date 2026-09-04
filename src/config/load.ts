import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ProviderIdSchema, type ProviderId } from '../manifest/index.js';
import type { ToolCapability } from '../providers/tools.js';
import {
  BUILTIN_CONFIG,
  CONFIG_VERSION,
  ConfigFileSchema,
  type ConfigFile,
  type ResolvedConfig,
} from './schema.js';
import { userConfigPath } from './paths.js';

/**
 * Layered config (config.md §Precedence). Highest wins:
 * flags > env > project > user > built-in.
 *
 * Every value records the layer it came from, so `baya config --show` can
 * explain itself instead of printing an unattributed blob.
 */
export const LAYER_NAMES = ['flags', 'env', 'user', 'built-in'] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

export interface ConfigLayer {
  name: LayerName;
  /** File path for `project`/`user`; a description otherwise. */
  origin: string;
  values: ConfigFile;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** Dotted key -> the layer that supplied it. */
  sources: Record<string, LayerName>;
  layers: ConfigLayer[];
  userPath: string;
  /** True when no user config file exists — the first-run wizard's trigger. */
  userConfigExists: boolean;
}

/**
 * A malformed config is a hard error naming the file and the offending key —
 * never a silent reset. Silently discarding a user's settings because one key
 * is misspelled is the worst possible response to a typo.
 */
export class ConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
  }
}

function readConfigFile(path: string): ConfigFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(path, (err as Error).message);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(path, `not valid JSON — ${(err as Error).message}`);
  }

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const key = issue?.path.join('.') ?? '<root>';
    throw new ConfigError(path, `invalid key "${key}" — ${issue?.message ?? 'unknown'}`);
  }
  return result.data;
}

export interface ConfigFlags {
  defaultProvider?: string | undefined;
  defaultModel?: string | undefined;
  plannerProvider?: string | undefined;
  plannerModel?: string | undefined;
}

function providerOrThrow(value: string, origin: string): ProviderId {
  const parsed = ProviderIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(origin, `unknown provider "${value}"`);
  }
  return parsed.data;
}

function envLayer(env: NodeJS.ProcessEnv): ConfigFile {
  const values: ConfigFile = {};
  const set = (
    section: 'defaults' | 'planner',
    key: 'provider' | 'model',
    raw: string | undefined,
  ): void => {
    if (raw === undefined || raw === '') return;
    const target = (values[section] ??= {});
    if (key === 'provider') target.provider = providerOrThrow(raw, 'env');
    else target.model = raw;
  };
  set('defaults', 'provider', env['BAYA_DEFAULT_PROVIDER']);
  set('defaults', 'model', env['BAYA_DEFAULT_MODEL']);
  set('planner', 'provider', env['BAYA_PLANNER_PROVIDER']);
  set('planner', 'model', env['BAYA_PLANNER_MODEL']);
  return values;
}

function flagLayer(flags: ConfigFlags): ConfigFile {
  const values: ConfigFile = {};
  if (flags.defaultProvider) {
    values.defaults = { provider: providerOrThrow(flags.defaultProvider, 'flags') };
  }
  if (flags.defaultModel) {
    values.defaults = { ...values.defaults, model: flags.defaultModel };
  }
  if (flags.plannerProvider) {
    values.planner = { provider: providerOrThrow(flags.plannerProvider, 'flags') };
  }
  if (flags.plannerModel) {
    values.planner = { ...values.planner, model: flags.plannerModel };
  }
  return values;
}

export interface LoadConfigOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  flags?: ConfigFlags;
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const env = options.env ?? process.env;
  const userPath = userConfigPath(env);

  const user = readConfigFile(userPath);

  const layers: ConfigLayer[] = [
    { name: 'flags', origin: 'command line', values: flagLayer(options.flags ?? {}) },
    { name: 'env', origin: 'BAYA_* environment', values: envLayer(env) },
    { name: 'user', origin: userPath, values: user ?? {} },
    { name: 'built-in', origin: 'built-in defaults', values: {} },
  ];

  const config: ResolvedConfig = {
    defaults: { ...BUILTIN_CONFIG.defaults },
    planner: { ...BUILTIN_CONFIG.planner },
    providers: {},
    modelAliases: {},
    modelCatalog: {},
  };
  const sources: Record<string, LayerName> = {
    'defaults.provider': 'built-in',
    'defaults.model': 'built-in',
    'planner.provider': 'built-in',
    'planner.model': 'built-in',
  };

  // Lowest precedence first, so a higher layer simply overwrites.
  for (const layer of [...layers].reverse()) {
    for (const section of ['defaults', 'planner'] as const) {
      const values = layer.values[section];
      if (!values) continue;
      if (values.provider !== undefined) {
        config[section].provider = values.provider;
        sources[`${section}.provider`] = layer.name;
      }
      if (values.model !== undefined) {
        config[section].model = values.model;
        sources[`${section}.model`] = layer.name;
      }
    }
    for (const [id, settings] of Object.entries(layer.values.providers ?? {})) {
      const providerId = id as ProviderId;
      config.providers[providerId] = { ...config.providers[providerId], ...settings };
      for (const key of Object.keys(settings)) {
        sources[`providers.${providerId}.${key}`] = layer.name;
      }
    }
    for (const [name, target] of Object.entries(layer.values.modelAliases ?? {})) {
      config.modelAliases[name] = target;
      sources[`modelAliases.${name}`] = layer.name;
    }
    for (const [id, models] of Object.entries(layer.values.modelCatalog ?? {})) {
      const providerId = id as ProviderId;
      const byId = new Map(
        (config.modelCatalog[providerId] ?? []).map((model) => [model.id, model]),
      );
      for (const model of models) byId.set(model.id, model);
      config.modelCatalog[providerId] = [...byId.values()];
      sources[`modelCatalog.${providerId}`] = layer.name;
    }
  }

  // The planner falls back to the task default rather than to nothing: a user
  // who answered one setup question has answered this one too.
  if (config.planner.provider === null && config.defaults.provider !== null) {
    config.planner.provider = config.defaults.provider;
    sources['planner.provider'] = sources['defaults.provider'] ?? 'built-in';
  }

  return {
    config,
    sources,
    layers,
    userPath,
    userConfigExists: user !== null,
  };
}

/** Only providers that configured one appear: "configured empty" ≠ "not configured". */
export function providerToolSettings(config: ResolvedConfig): {
  providerTools: Partial<Record<ProviderId, readonly ToolCapability[]>>;
  extraArgs: Partial<Record<ProviderId, readonly string[]>>;
} {
  const providerTools: Partial<Record<ProviderId, readonly ToolCapability[]>> = {};
  const extraArgs: Partial<Record<ProviderId, readonly string[]>> = {};
  for (const [id, settings] of Object.entries(config.providers)) {
    const providerId = id as ProviderId;
    if (settings.tools !== undefined) providerTools[providerId] = settings.tools;
    if (settings.extraArgs !== undefined) extraArgs[providerId] = settings.extraArgs;
  }
  return { providerTools, extraArgs };
}

/**
 * The `providers.<id>.bin` overrides in the shape the provider registry takes.
 * Every command that resolves a binary needs these — a configured path is the
 * first link of the resolution chain, and a command that skips it reports "not
 * found" for a provider the very next run would resolve.
 */
export function binOverrides(
  config: ResolvedConfig,
): Partial<Record<ProviderId, string>> {
  return Object.fromEntries(
    Object.entries(config.providers)
      .filter(([, settings]) => settings.bin !== undefined)
      .map(([id, settings]) => [id, settings.bin as string]),
  ) as Partial<Record<ProviderId, string>>;
}

/** Atomic write (config.md), like `state.json`: no torn file is ever observable. */
export function writeConfigFile(path: string, values: ConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = { version: CONFIG_VERSION, ...values };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function readUserConfig(env: NodeJS.ProcessEnv = process.env): ConfigFile {
  return readConfigFile(userConfigPath(env)) ?? {};
}

/** `baya config set <key> <value>`. Returns the file it wrote. */
export function setConfigValue(
  key: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = userConfigPath(env);
  const current = readConfigFile(path) ?? {};
  const [section, field] = key.split('.');

  // `baya config set modelAliases.luna gpt-5.6-luna` — or `... null` to drop it.
  if (section === 'modelAliases' && field) {
    const next: ConfigFile = { ...current, modelAliases: { ...current.modelAliases } };
    const map = next.modelAliases as Record<string, string>;
    if (value === 'null') delete map[field];
    else map[field] = value;
    if (Object.keys(map).length === 0) delete next.modelAliases;
    writeConfigFile(path, next);
    return path;
  }

  // `baya config set modelCatalog.codex.gpt-5 "GPT-5, fast"` — the value is the
  // model's description; `... null` drops the entry. Same persistence rules as
  // the modelAliases branch: prune empty containers, write the user layer only.
  if (section === 'modelCatalog') {
    const parts = key.split('.');
    const providerRaw = parts[1];
    // Model ids contain dots (`gpt-5.6-luna`), so the id is everything past the
    // provider segment, rejoined.
    const modelId = parts.slice(2).join('.');
    if (!providerRaw || !modelId) {
      throw new ConfigError(path, `unknown config key "${key}"`);
    }
    const providerId = providerOrThrow(providerRaw, path);
    const next: ConfigFile = { ...current, modelCatalog: { ...current.modelCatalog } };
    const catalog = next.modelCatalog as Record<
      string,
      Array<{ id: string; aliases: string[]; description: string }>
    >;
    const entries = [...(catalog[providerId] ?? [])];
    const idx = entries.findIndex((model) => model.id === modelId);
    const existing = idx === -1 ? undefined : entries[idx];
    if (value === 'null') {
      if (idx !== -1) entries.splice(idx, 1);
    } else if (existing) {
      entries[idx] = { ...existing, description: value };
    } else {
      entries.push({ id: modelId, aliases: [], description: value });
    }
    if (entries.length === 0) delete catalog[providerId];
    else catalog[providerId] = entries;
    if (Object.keys(catalog).length === 0) delete next.modelCatalog;
    writeConfigFile(path, next);
    return path;
  }

  if ((section !== 'defaults' && section !== 'planner') || !field) {
    throw new ConfigError(path, `unknown config key "${key}"`);
  }
  const next: ConfigFile = { ...current, [section]: { ...current[section] } };
  const target = next[section] as { provider?: ProviderId | null; model?: string | null };

  if (field === 'provider') {
    target.provider = value === 'null' ? null : providerOrThrow(value, path);
  } else if (field === 'model') {
    target.model = value === 'null' ? null : value;
  } else {
    throw new ConfigError(path, `unknown config key "${key}"`);
  }

  writeConfigFile(path, next);
  return path;
}
