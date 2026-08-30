import { resolveRunModel } from "../../../src/ui/index.js";
import { BUILTIN_CATALOG } from "../../../src/providers/index.js";

/**
 * `--default-model` / `--planner-model` used to reach the provider verbatim,
 * so `luna` was handed to codex as `-m luna` and the planner failed on a name
 * the catalog knows perfectly well.
 */
const resolve = (requested: string | null, provider: "codex" | "claude" = "codex") =>
  resolveRunModel(requested, {
    catalog: BUILTIN_CATALOG,
    userAliases: {},
    provider,
    label: "--default-model",
  });

describe("resolveRunModel", () => {
  it("resolves a catalog alias to the id the provider actually accepts", () => {
    const { model, note } = resolve("luna");
    expect(model).toBe("gpt-5.6-luna");
    expect(note).toContain("luna");
  });

  it("leaves an exact id alone, and says nothing about it", () => {
    expect(resolve("gpt-5.6-luna")).toEqual({ model: "gpt-5.6-luna", note: null });
  });

  /**
   * The catalog is a convenience list, not an allowlist. Model ids ship faster
   * than this catalog does, so an unknown name must still reach the provider —
   * resolving it to a fuzzy neighbour, or refusing it, would break real ids.
   */
  it("passes an unknown model through untouched rather than guessing", () => {
    expect(resolve("some-brand-new-model-id")).toEqual({
      model: "some-brand-new-model-id",
      note: null,
    });
  });

  it("follows a user alias", () => {
    const { model } = resolveRunModel("cheap", {
      catalog: BUILTIN_CATALOG,
      userAliases: { cheap: "luna" },
      provider: "codex",
      label: "--default-model",
    });
    expect(model).toBe("gpt-5.6-luna");
  });

  it("applies a model that routes elsewhere, but says so", () => {
    const { model, note } = resolve("luna", "claude");
    expect(model).toBe("gpt-5.6-luna");
    expect(note).toContain("codex model");
  });

  it("has nothing to do when no model was named", () => {
    expect(resolve(null)).toEqual({ model: null, note: null });
  });
});
