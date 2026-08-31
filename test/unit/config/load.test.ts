import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  loadConfig,
  setConfigValue,
  userConfigPath,
} from '../../../src/config/index.js';
import {
  BUILTIN_CATALOG,
  mergeCatalog,
  resolveModel,
} from '../../../src/providers/index.js';

function workspace(): { cwd: string; home: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'baya-config-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { cwd, home, env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') } };
}

function writeUser(env: NodeJS.ProcessEnv, values: unknown): void {
  const path = userConfigPath(env);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(values));
}

describe('loadConfig precedence', () => {
  it('falls back to built-in defaults with no config anywhere', () => {
    const { cwd, env } = workspace();
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.defaults).toEqual({ provider: null, model: null });
    expect(loaded.sources['defaults.provider']).toBe('built-in');
    expect(loaded.userConfigExists).toBe(false);
  });

  it('reads the user layer and records it as the source', () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: 'codex', model: null } });
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.defaults.provider).toBe('codex');
    expect(loaded.sources['defaults.provider']).toBe('user');
    expect(loaded.userConfigExists).toBe(true);
  });

  it('lets env override the user layer', () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: 'claude' } });
    const loaded = loadConfig({
      cwd,
      env: { ...env, BAYA_DEFAULT_PROVIDER: 'opencode' },
    });
    expect(loaded.config.defaults.provider).toBe('opencode');
    expect(loaded.sources['defaults.provider']).toBe('env');
  });

  it('lets flags override everything', () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: 'claude' } });
    const loaded = loadConfig({
      cwd,
      env: { ...env, BAYA_DEFAULT_PROVIDER: 'opencode' },
      flags: { defaultProvider: 'codex' },
    });
    expect(loaded.config.defaults.provider).toBe('codex');
    expect(loaded.sources['defaults.provider']).toBe('flags');
  });

  it("merges provider settings across layers and tracks each key's source", () => {
    const { cwd, env } = workspace();
    writeUser(env, {
      providers: { codex: { maxConcurrency: 4, bin: '/custom/codex' } },
    });
    const loaded = loadConfig({
      cwd,
      env,
      flags: { defaultProvider: 'claude' },
    });
    expect(loaded.config.providers.codex).toEqual({
      maxConcurrency: 4,
      bin: '/custom/codex',
    });
    expect(loaded.sources['providers.codex.bin']).toBe('user');
    expect(loaded.sources['defaults.provider']).toBe('flags');
  });

  it('defaults the planner to the task provider so one answer settles both', () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: 'codex' } });
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.planner.provider).toBe('codex');
  });

  it('keeps an explicit planner provider distinct from the task default', () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: 'codex' }, planner: { provider: 'claude' } });
    expect(loadConfig({ cwd, env }).config.planner.provider).toBe('claude');
  });
});

describe('malformed config', () => {
  it('names the file and the offending key, and never silently resets', () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: 'codex' }, nonsense: true });
    expect(() => loadConfig({ cwd, env })).toThrow(ConfigError);
    expect(() => loadConfig({ cwd, env })).toThrow(/nonsense/);
  });

  it('reports invalid JSON as such', () => {
    const { cwd, env } = workspace();
    const path = userConfigPath(env);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{not json');
    expect(() => loadConfig({ cwd, env })).toThrow(/not valid JSON/);
  });

  it('rejects an unknown provider id rather than storing it', () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: 'rogue' } });
    expect(() => loadConfig({ cwd, env })).toThrow(ConfigError);
  });
});

describe('setConfigValue', () => {
  it('writes the user layer and is readable back', () => {
    const { cwd, env } = workspace();
    setConfigValue('defaults.provider', 'codex', env);
    expect(loadConfig({ cwd, env }).config.defaults.provider).toBe('codex');
  });

  it('preserves the other keys already in the file', () => {
    const { cwd, env } = workspace();
    setConfigValue('defaults.provider', 'codex', env);
    setConfigValue('defaults.model', 'some-model', env);
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.defaults).toEqual({ provider: 'codex', model: 'some-model' });
  });

  it("accepts the literal null to mean 'the provider's own default'", () => {
    const { cwd, env } = workspace();
    setConfigValue('defaults.model', 'null', env);
    expect(loadConfig({ cwd, env }).config.defaults.model).toBeNull();
  });

  it('rejects an unknown key', () => {
    const { env } = workspace();
    expect(() => setConfigValue('defaults.nonsense', 'x', env)).toThrow(ConfigError);
  });

  it('adds a modelCatalog entry with the value as its description', () => {
    const { cwd, env } = workspace();
    setConfigValue('modelCatalog.codex.gpt-5.6-luna', 'Fast luna variant', env);
    const entries = loadConfig({ cwd, env }).config.modelCatalog.codex ?? [];
    expect(entries).toContainEqual({
      id: 'gpt-5.6-luna',
      aliases: [],
      description: 'Fast luna variant',
    });
  });

  it('updates the description of an existing modelCatalog entry, keeping aliases', () => {
    const { cwd, env } = workspace();
    writeUser(env, {
      version: 1,
      modelCatalog: { codex: [{ id: 'gpt-5', aliases: ['big'], description: 'old' }] },
    });
    setConfigValue('modelCatalog.codex.gpt-5', 'new description', env);
    expect(loadConfig({ cwd, env }).config.modelCatalog.codex).toEqual([
      { id: 'gpt-5', aliases: ['big'], description: 'new description' },
    ]);
  });

  it('overrides a built-in catalog id, storing only the override', () => {
    const { cwd, env } = workspace();
    setConfigValue('modelCatalog.codex.gpt-5.6-luna', 'my cheaper luna', env);
    const stored = loadConfig({ cwd, env }).config.modelCatalog;
    // The user layer holds just the override, never a copy of the shipped list.
    expect(stored.codex).toEqual([
      { id: 'gpt-5.6-luna', aliases: [], description: 'my cheaper luna' },
    ]);
    // Merged beneath the shipped catalog, the override wins for that id while
    // the other built-in codex entries stay put.
    const merged = mergeCatalog(BUILTIN_CATALOG, stored);
    expect((merged.codex ?? []).find((m) => m.id === 'gpt-5.6-luna')?.description).toBe(
      'my cheaper luna',
    );
    expect((merged.codex ?? []).map((m) => m.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
  });

  it('removes a modelCatalog entry on null and prunes empty containers', () => {
    const { cwd, env } = workspace();
    writeUser(env, {
      version: 1,
      modelCatalog: { codex: [{ id: 'gpt-5', aliases: [], description: 'x' }] },
      defaults: { provider: 'codex' },
    });
    setConfigValue('modelCatalog.codex.gpt-5', 'null', env);
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.modelCatalog.codex).toBeUndefined();
    expect(loaded.config.defaults.provider).toBe('codex');
  });

  it('rejects an unknown provider segment', () => {
    const { env } = workspace();
    expect(() => setConfigValue('modelCatalog.rogue.gpt-5', 'x', env)).toThrow(
      ConfigError,
    );
  });

  it('rejects a modelCatalog key with no model id', () => {
    const { env } = workspace();
    expect(() => setConfigValue('modelCatalog.codex', 'x', env)).toThrow(ConfigError);
  });
});

describe('modelCatalog override resolves end to end', () => {
  it('a user entry overriding a built-in id wins through loadConfig → merge → resolveModel', () => {
    const { cwd, env } = workspace();
    // The user redefines a shipped codex id, adding an alias the built-in
    // `gpt-5.6-luna` never had and rewriting its description.
    writeUser(env, {
      version: 1,
      defaults: { provider: 'codex' },
      modelCatalog: {
        codex: [
          {
            id: 'gpt-5.6-luna',
            aliases: ['luna', 'penny-pincher'],
            description: 'my cheaper luna',
          },
        ],
      },
    });

    const loaded = loadConfig({ cwd, env });
    expect(loaded.sources['modelCatalog.codex']).toBe('user');

    const catalog = mergeCatalog(BUILTIN_CATALOG, loaded.config.modelCatalog);
    // The merge keeps the other built-in codex entries and swaps in the user's.
    expect((catalog.codex ?? []).map((m) => m.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect((catalog.codex ?? []).find((m) => m.id === 'gpt-5.6-luna')).toEqual({
      id: 'gpt-5.6-luna',
      aliases: ['luna', 'penny-pincher'],
      description: 'my cheaper luna',
    });

    // The alias only the user's definition carries resolves — proof the merged
    // catalog resolution sees the override, not the shipped entry.
    const viaNewAlias = resolveModel('penny-pincher', {
      catalog,
      runDefaultProvider: loaded.config.defaults.provider ?? 'codex',
    });
    expect(viaNewAlias.match).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-luna',
      via: 'alias',
    });

    // The built-in alias still resolves to the same id, and the entry behind it
    // is the user's.
    const viaBuiltinAlias = resolveModel('luna', {
      catalog,
      runDefaultProvider: loaded.config.defaults.provider ?? 'codex',
    });
    expect(viaBuiltinAlias.match?.model).toBe('gpt-5.6-luna');
    expect(
      (catalog.codex ?? []).find((m) => m.id === viaBuiltinAlias.match?.model)
        ?.description,
    ).toBe('my cheaper luna');
  });
});
