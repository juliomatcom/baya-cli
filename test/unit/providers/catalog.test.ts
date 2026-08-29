import {
  BUILTIN_CATALOG,
  mergeCatalog,
  opencodeCatalog,
  resolveModel,
  scoreModel,
} from "../../../src/providers/index.js";

describe("BUILTIN_CATALOG", () => {
  it("covers the three CLIs with no list command", () => {
    expect(Object.keys(BUILTIN_CATALOG).sort()).toEqual(["claude", "codex", "copilot"]);
    expect(BUILTIN_CATALOG.opencode).toBeUndefined();
  });

  it("gives codex the sol/terra/luna family with aliases", () => {
    const ids = (BUILTIN_CATALOG.codex ?? []).map((m) => m.id);
    expect(ids).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect((BUILTIN_CATALOG.codex ?? []).flatMap((m) => m.aliases)).toEqual([
      "sol",
      "terra",
      "luna",
    ]);
  });
});

describe("mergeCatalog", () => {
  it("adds opencode's live list without touching the built-ins", () => {
    const merged = mergeCatalog(BUILTIN_CATALOG, {
      opencode: opencodeCatalog(["anthropic/claude-sonnet-4", "openai/gpt-5"]),
    });
    expect(merged.opencode).toHaveLength(2);
    expect(merged.codex).toEqual(BUILTIN_CATALOG.codex);
  });

  it("overrides a built-in entry by id, keeps the rest", () => {
    const merged = mergeCatalog(BUILTIN_CATALOG, {
      codex: [{ id: "gpt-5.6-luna", aliases: ["luna", "cheap"], description: "x" }],
    });
    const luna = (merged.codex ?? []).find((m) => m.id === "gpt-5.6-luna");
    expect(luna?.aliases).toEqual(["luna", "cheap"]);
    expect(merged.codex).toHaveLength(3);
  });

  it("is a no-op when there is nothing extra", () => {
    expect(mergeCatalog(BUILTIN_CATALOG, undefined)).toBe(BUILTIN_CATALOG);
  });
});

describe("scoreModel", () => {
  const luna = {
    id: "gpt-5.6-luna",
    aliases: ["luna"],
    description: "optimized for cost",
  };

  it("scores an exact id or alias at 1", () => {
    expect(scoreModel("gpt-5.6-luna", luna)).toBe(1);
    expect(scoreModel("LUNA", luna)).toBe(1);
  });

  it("scores a one-character typo highly", () => {
    expect(scoreModel("lunaa", luna)).toBeGreaterThan(0.7);
    expect(
      scoreModel("sonet", {
        id: "claude-sonnet-5",
        aliases: ["sonnet"],
        description: "",
      }),
    ).toBeGreaterThan(0.8);
  });

  it("scores an unrelated name near zero", () => {
    expect(scoreModel("quantum-9000", luna)).toBeLessThan(0.3);
  });

  it("can match on the description", () => {
    expect(scoreModel("cost optimized", luna)).toBeGreaterThan(0.2);
  });
});

describe("resolveModel", () => {
  const opts = { catalog: BUILTIN_CATALOG, runDefaultProvider: "codex" as const };

  it("resolves a catalog alias to its id and provider", () => {
    const r = resolveModel("luna", opts);
    expect(r.match).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-luna",
      via: "alias",
    });
  });

  it("resolves a full id", () => {
    expect(resolveModel("claude-sonnet-5", opts).match).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-5",
      via: "exact",
    });
  });

  it("follows a user alias, marking it as such", () => {
    const r = resolveModel("fast", {
      ...opts,
      userAliases: { fast: "gpt-5.6-luna" },
    });
    expect(r.match).toMatchObject({ model: "gpt-5.6-luna", via: "user-alias" });
  });

  it("prefers the task's explicit provider on a cross-provider tie", () => {
    const catalog = {
      codex: [{ id: "shared", aliases: [], description: "" }],
      claude: [{ id: "shared", aliases: [], description: "" }],
    };
    expect(
      resolveModel("shared", {
        catalog,
        runDefaultProvider: "codex",
        taskProvider: "claude",
      }).match?.provider,
    ).toBe("claude");
  });

  it("returns ranked candidates and no match for a typo", () => {
    const r = resolveModel("sonet", {
      catalog: BUILTIN_CATALOG,
      runDefaultProvider: "claude",
    });
    expect(r.match).toBeNull();
    expect(r.candidates[0]).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-5",
    });
  });

  it("offers a pattern-matched literal as a low-confidence candidate", () => {
    const r = resolveModel("gpt-9-turbo", { catalog: {}, runDefaultProvider: "claude" });
    expect(r.match).toBeNull();
    expect(r.candidates).toContainEqual(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-9-turbo",
        via: "literal",
      }),
    );
  });

  it("returns nothing usable for a truly unknown name", () => {
    const r = resolveModel("quantum-9000", {
      catalog: BUILTIN_CATALOG,
      runDefaultProvider: "codex",
    });
    expect(r.match).toBeNull();
    expect(r.candidates.every((c) => c.score < 0.5)).toBe(true);
  });
});
