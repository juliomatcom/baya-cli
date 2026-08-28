import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  loadConfig,
  setConfigValue,
  userConfigPath,
} from "../../../src/config/index.js";

function workspace(): { cwd: string; home: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "baya-config-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { cwd, home, env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") } };
}

function writeUser(env: NodeJS.ProcessEnv, values: unknown): void {
  const path = userConfigPath(env);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(values));
}

function writeProject(cwd: string, values: unknown): void {
  mkdirSync(join(cwd, ".baya"), { recursive: true });
  writeFileSync(join(cwd, ".baya", "config.json"), JSON.stringify(values));
}

describe("loadConfig precedence", () => {
  it("falls back to built-in defaults with no config anywhere", () => {
    const { cwd, env } = workspace();
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.defaults).toEqual({ provider: null, model: null });
    expect(loaded.sources["defaults.provider"]).toBe("built-in");
    expect(loaded.userConfigExists).toBe(false);
  });

  it("reads the user layer and records it as the source", () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: "codex", model: null } });
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.defaults.provider).toBe("codex");
    expect(loaded.sources["defaults.provider"]).toBe("user");
    expect(loaded.userConfigExists).toBe(true);
  });

  it("lets the project layer override the user layer", () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: "codex" } });
    writeProject(cwd, { defaults: { provider: "claude" } });
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.defaults.provider).toBe("claude");
    expect(loaded.sources["defaults.provider"]).toBe("project");
  });

  it("lets env override the project layer", () => {
    const { cwd, env } = workspace();
    writeProject(cwd, { defaults: { provider: "claude" } });
    const loaded = loadConfig({
      cwd,
      env: { ...env, BAYA_DEFAULT_PROVIDER: "opencode" },
    });
    expect(loaded.config.defaults.provider).toBe("opencode");
    expect(loaded.sources["defaults.provider"]).toBe("env");
  });

  it("lets flags override everything", () => {
    const { cwd, env } = workspace();
    writeProject(cwd, { defaults: { provider: "claude" } });
    const loaded = loadConfig({
      cwd,
      env: { ...env, BAYA_DEFAULT_PROVIDER: "opencode" },
      flags: { defaultProvider: "codex" },
    });
    expect(loaded.config.defaults.provider).toBe("codex");
    expect(loaded.sources["defaults.provider"]).toBe("flags");
  });

  it("merges provider settings across layers and tracks each key's source", () => {
    const { cwd, env } = workspace();
    writeUser(env, { providers: { codex: { maxConcurrency: 4 } } });
    writeProject(cwd, { providers: { codex: { bin: "/custom/codex" } } });
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.providers.codex).toEqual({
      maxConcurrency: 4,
      bin: "/custom/codex",
    });
    expect(loaded.sources["providers.codex.bin"]).toBe("project");
    expect(loaded.sources["providers.codex.maxConcurrency"]).toBe("user");
  });

  it("defaults the planner to the task provider so one answer settles both", () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: "codex" } });
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.planner.provider).toBe("codex");
  });

  it("keeps an explicit planner provider distinct from the task default", () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: "codex" }, planner: { provider: "claude" } });
    expect(loadConfig({ cwd, env }).config.planner.provider).toBe("claude");
  });
});

describe("malformed config", () => {
  it("names the file and the offending key, and never silently resets", () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: "codex" }, nonsense: true });
    expect(() => loadConfig({ cwd, env })).toThrow(ConfigError);
    expect(() => loadConfig({ cwd, env })).toThrow(/nonsense/);
  });

  it("reports invalid JSON as such", () => {
    const { cwd, env } = workspace();
    const path = userConfigPath(env);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not json");
    expect(() => loadConfig({ cwd, env })).toThrow(/not valid JSON/);
  });

  it("rejects an unknown provider id rather than storing it", () => {
    const { cwd, env } = workspace();
    writeUser(env, { defaults: { provider: "rogue" } });
    expect(() => loadConfig({ cwd, env })).toThrow(ConfigError);
  });
});

describe("setConfigValue", () => {
  it("writes the user layer and is readable back", () => {
    const { cwd, env } = workspace();
    setConfigValue("defaults.provider", "codex", env);
    expect(loadConfig({ cwd, env }).config.defaults.provider).toBe("codex");
  });

  it("preserves the other keys already in the file", () => {
    const { cwd, env } = workspace();
    setConfigValue("defaults.provider", "codex", env);
    setConfigValue("defaults.model", "some-model", env);
    const loaded = loadConfig({ cwd, env });
    expect(loaded.config.defaults).toEqual({ provider: "codex", model: "some-model" });
  });

  it("accepts the literal null to mean 'the provider's own default'", () => {
    const { cwd, env } = workspace();
    setConfigValue("defaults.model", "null", env);
    expect(loadConfig({ cwd, env }).config.defaults.model).toBeNull();
  });

  it("rejects an unknown key", () => {
    const { env } = workspace();
    expect(() => setConfigValue("defaults.nonsense", "x", env)).toThrow(ConfigError);
  });
});
