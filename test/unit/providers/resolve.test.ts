import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, resolveBinary } from "../../../src/providers/index.js";
import { codexAdapter } from "../../../src/providers/codex.js";

function makeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\necho fake 1.0.0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("resolveBinary", () => {
  it("takes a config override ahead of everything else", () => {
    const root = mkdtempSync(join(tmpdir(), "baya-resolve-"));
    const override = makeExecutable(join(root, "custom"), "codex");
    makeExecutable(join(root, "path"), "codex");

    expect(
      resolveBinary("codex", { override, env: { PATH: join(root, "path") } }),
    ).toEqual({ bin: override, source: "config" });
  });

  it("refuses a configured path that is not executable rather than falling through", () => {
    const root = mkdtempSync(join(tmpdir(), "baya-resolve-"));
    const onPath = makeExecutable(join(root, "path"), "codex");
    expect(
      resolveBinary("codex", {
        override: join(root, "nope", "codex"),
        env: { PATH: join(root, "path") },
      }),
    ).toBeNull();
    expect(resolveBinary("codex", { env: { PATH: join(root, "path") } })?.bin).toBe(
      onPath,
    );
  });

  it("finds a binary on $PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "baya-resolve-"));
    const bin = makeExecutable(join(root, "path"), "codex");
    expect(resolveBinary("codex", { env: { PATH: join(root, "path") } })).toEqual({
      bin,
      source: "path",
    });
  });

  it("finds a binary in ~/.local/bin when $PATH does not have it — never assume $PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "baya-home-"));
    const bin = makeExecutable(join(home, ".local", "bin"), "codex");
    expect(resolveBinary("codex", { env: { PATH: "/nonexistent", HOME: home } })).toEqual(
      {
        bin,
        source: "known-location",
      },
    );
  });

  it("returns null when nothing resolves", () => {
    const home = mkdtempSync(join(tmpdir(), "baya-home-"));
    expect(
      resolveBinary("codex", { env: { PATH: "/nonexistent", HOME: home } }),
    ).toBeNull();
  });

  it("ignores a directory that shares the binary's name", () => {
    const root = mkdtempSync(join(tmpdir(), "baya-resolve-"));
    mkdirSync(join(root, "path", "codex"), { recursive: true });
    expect(
      resolveBinary("codex", { env: { PATH: join(root, "path"), HOME: root } }),
    ).toBeNull();
  });
});

describe("registry", () => {
  it("reports every registered adapter with its resolution status", async () => {
    const home = mkdtempSync(join(tmpdir(), "baya-home-"));
    const bin = makeExecutable(join(home, ".local", "bin"), "codex");
    const registry = createRegistry([codexAdapter]);

    const statuses = await registry.resolveAll({
      env: { PATH: "/nonexistent", HOME: home },
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.id).toBe("codex");
    expect(statuses[0]?.resolved?.bin).toBe(bin);
    expect(statuses[0]?.resolved?.version).toBe("fake 1.0.0");
  });

  it("reports a missing adapter as unresolved rather than throwing", async () => {
    const home = mkdtempSync(join(tmpdir(), "baya-home-"));
    const registry = createRegistry([codexAdapter]);
    const statuses = await registry.resolveAll({
      env: { PATH: "/nonexistent", HOME: home },
    });
    expect(statuses[0]?.resolved).toBeNull();
  });

  it("has() narrows an unknown string safely", () => {
    const registry = createRegistry([codexAdapter]);
    expect(registry.has("codex")).toBe(true);
    expect(registry.has("rogue")).toBe(false);
  });
});
