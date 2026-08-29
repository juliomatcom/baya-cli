import {
  BUILTIN_CATALOG,
  catalogToPersist,
  mergeCatalog,
  opencodeCatalog,
  resolveModel,
  scoreModel,
  withoutBuiltinEntries,
  type Catalog,
  type CatalogModel,
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

// A data-only edit to BUILTIN_CATALOG that duplicates an id, reuses an alias
// another provider already claims, or forgets a description must fail here with
// a message that names the offending entry — not surface as a confusing
// resolution bug at run time.
describe("BUILTIN_CATALOG invariants", () => {
  const entries = Object.entries(BUILTIN_CATALOG) as Array<[string, CatalogModel[]]>;

  it("has unique model ids within each provider", () => {
    for (const [provider, models] of entries) {
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const model of models) {
        if (seen.has(model.id)) dupes.push(model.id);
        seen.add(model.id);
      }
      expect({ provider, dupes }).toEqual({ provider, dupes: [] });
    }
  });

  it("never reuses an alias across providers", () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const [provider, models] of entries) {
      for (const model of models) {
        for (const alias of model.aliases) {
          const key = alias.toLowerCase();
          const existing = owner.get(key);
          if (existing && existing !== provider) {
            collisions.push(
              `alias "${alias}" claimed by both ${existing} and ${provider} (${model.id})`,
            );
          } else {
            owner.set(key, provider);
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it("gives every entry a non-empty description", () => {
    const missing: string[] = [];
    for (const [provider, models] of entries) {
      for (const model of models) {
        if (model.description.trim() === "") missing.push(`${provider}/${model.id}`);
      }
    }
    expect(missing).toEqual([]);
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

/** A config file as written by the version that stored the whole built-in list. */
function snapshotConfig(): Catalog {
  return JSON.parse(JSON.stringify(BUILTIN_CATALOG)) as Catalog;
}

describe("withoutBuiltinEntries (config migration)", () => {
  it("drops a whole stale snapshot of the built-in catalog", () => {
    expect(withoutBuiltinEntries(snapshotConfig())).toEqual({});
  });

  it("keeps a description the user rewrote inside a snapshot", () => {
    const stored = snapshotConfig();
    const sol = (stored.codex ?? []).find((m) => m.id === "gpt-5.6-sol");
    (sol as CatalogModel).description = "my own note about sol";

    const kept = withoutBuiltinEntries(stored);
    expect(kept).toEqual({
      codex: [
        { id: "gpt-5.6-sol", aliases: ["sol"], description: "my own note about sol" },
      ],
    });
  });

  it("keeps an added alias and an id the built-in list never had", () => {
    const stored = snapshotConfig();
    const luna = (stored.codex ?? []).find((m) => m.id === "gpt-5.6-luna");
    (luna as CatalogModel).aliases = ["luna", "cheap"];
    stored.copilot = [
      ...(stored.copilot ?? []),
      { id: "vendor-model-slug", aliases: [], description: "" },
    ];

    const kept = withoutBuiltinEntries(stored);
    expect((kept.codex ?? []).map((m) => m.id)).toEqual(["gpt-5.6-luna"]);
    expect(kept.copilot).toEqual([
      { id: "vendor-model-slug", aliases: [], description: "" },
    ]);
    expect(kept.claude).toBeUndefined();
  });

  it("never drops opencode entries — no built-in list to compare them against", () => {
    const stored: Catalog = { opencode: opencodeCatalog(["openai/gpt-5"]) };
    expect(withoutBuiltinEntries(stored)).toEqual(stored);
  });

  it("leaves the resolved catalog unchanged — the merge sees the same", () => {
    const stored = snapshotConfig();
    const sonnet = (stored.claude ?? []).find((m) => m.id === "claude-sonnet-5");
    (sonnet as CatalogModel).aliases = ["sonnet", "s5"];

    expect(mergeCatalog(BUILTIN_CATALOG, withoutBuiltinEntries(stored))).toEqual(
      mergeCatalog(BUILTIN_CATALOG, stored),
    );
  });

  it("is empty for an absent catalog", () => {
    expect(withoutBuiltinEntries(undefined)).toEqual({});
  });
});

describe("catalogToPersist (refresh-models)", () => {
  const ids = ["anthropic/claude-sonnet-4", "openai/gpt-5"];

  it("stores the live opencode list and nothing built-in", () => {
    const persisted = catalogToPersist(snapshotConfig(), ids);
    expect(Object.keys(persisted)).toEqual(["opencode"]);
    expect((persisted.opencode ?? []).map((m) => m.id)).toEqual(ids);
  });

  it("preserves a deliberate override of a built-in entry", () => {
    const stored = snapshotConfig();
    const opus = (stored.claude ?? []).find((m) => m.id === "claude-opus-5");
    (opus as CatalogModel).aliases = ["opus", "big"];

    const persisted = catalogToPersist(stored, ids);
    expect(persisted.claude).toEqual([opus]);
    // …and it still wins over the built-in entry once the layers merge.
    const merged = mergeCatalog(BUILTIN_CATALOG, persisted);
    const opusEntry = (merged.claude ?? []).find((m) => m.id === "claude-opus-5");
    expect(opusEntry?.aliases).toEqual(["opus", "big"]);
    expect(merged.claude).toHaveLength((BUILTIN_CATALOG.claude ?? []).length);
  });

  it("replaces the bare opencode cache with the fresh list", () => {
    const stale = opencodeCatalog(["openai/gone", "openai/gpt-5"]);
    const persisted = catalogToPersist({ opencode: stale }, ids);
    expect((persisted.opencode ?? []).map((m) => m.id)).toEqual(ids);
  });

  it("keeps an annotated opencode entry the live list dropped", () => {
    const stored: Catalog = {
      opencode: [
        { id: "openai/gone", aliases: ["ghost"], description: "" },
        { id: "openai/gpt-5", aliases: [], description: "" },
      ],
    };
    const persisted = catalogToPersist(stored, ids);
    expect((persisted.opencode ?? []).map((m) => m.id)).toEqual([...ids, "openai/gone"]);
  });

  it("lets a user alias survive a refresh of the same opencode id", () => {
    const stored: Catalog = {
      opencode: [{ id: "openai/gpt-5", aliases: ["five"], description: "" }],
    };
    const persisted = catalogToPersist(stored, ids);
    const fresh = (persisted.opencode ?? []).find((m) => m.id === "openai/gpt-5");
    expect(fresh?.aliases).toEqual(["five"]);
  });

  it("keeps the stored cache when there is no live list to replace it with", () => {
    const stored: Catalog = { opencode: opencodeCatalog(["openai/gpt-5"]) };
    expect(catalogToPersist(stored, [])).toEqual(stored);
  });

  it("writes nothing at all when the user has no entries and opencode is absent", () => {
    expect(catalogToPersist(snapshotConfig(), [])).toEqual({});
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
