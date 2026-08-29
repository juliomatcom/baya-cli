import { buildModelAsk, planModelGate, runModelGate } from "../../../src/ui/index.js";
import { BUILTIN_CATALOG } from "../../../src/providers/index.js";
import { createTheme } from "../../../src/ui/theme.js";
import {
  MANIFEST_VERSION,
  type Manifest,
  type Task,
} from "../../../src/manifest/index.js";

const theme = createTheme("never");

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "t",
  title: "T",
  instruction: "do it",
  provider: null,
  model: null,
  depends_on: [],
  writes: false,
  cwd: null,
  ...overrides,
});

const manifest = (tasks: Task[]): Manifest => ({
  version: MANIFEST_VERSION,
  source: { path: "tasks.md", sha256: "x" },
  tasks,
});

const base = {
  catalog: BUILTIN_CATALOG,
  userAliases: {} as Record<string, string>,
  defaultProvider: "codex" as const,
  theme,
};

describe("planModelGate", () => {
  it("auto-resolves catalog aliases and leaves null models alone", () => {
    const plan = planModelGate(
      manifest([
        task({ id: "a", model: "luna" }),
        task({ id: "b", model: "sonnet" }),
        task({ id: "c" }),
      ]),
      { catalog: BUILTIN_CATALOG, userAliases: {}, defaultProvider: "codex" },
    );
    expect(plan.auto.get("a")).toEqual({ provider: "codex", model: "gpt-5.6-luna" });
    expect(plan.auto.get("b")).toEqual({ provider: "claude", model: "claude-sonnet-5" });
    expect(plan.auto.has("c")).toBe(false);
    expect(plan.asks).toHaveLength(0);
  });

  it("queues an unresolved model as an ask with candidates", () => {
    const plan = planModelGate(manifest([task({ id: "x", model: "quantum-9000" })]), {
      catalog: BUILTIN_CATALOG,
      userAliases: {},
      defaultProvider: "codex",
    });
    expect(plan.asks[0]).toMatchObject({ taskId: "x", requested: "quantum-9000" });
    expect(plan.asks[0]?.fallbackProvider).toBe("codex");
  });

  it("falls back to the run default provider, not a weak fuzzy catalog match", () => {
    const plan = planModelGate(manifest([task({ id: "x", model: "invaidModel" })]), {
      catalog: BUILTIN_CATALOG,
      userAliases: {},
      defaultProvider: "claude",
    });
    expect(plan.asks[0]?.requested).toBe("invaidModel");
    expect(plan.asks[0]?.fallbackProvider).toBe("claude");
  });

  it("still pattern-routes the fallback when the model name is recognisable", () => {
    const plan = planModelGate(manifest([task({ id: "x", model: "gpt-9-imaginary" })]), {
      catalog: BUILTIN_CATALOG,
      userAliases: {},
      defaultProvider: "claude",
    });
    expect(plan.asks[0]?.fallbackProvider).toBe("codex");
  });
});

describe("buildModelAsk", () => {
  it("starts the cursor on the default-provider fallback when no candidate is strong", () => {
    const [ask] = planModelGate(manifest([task({ id: "x", model: "invaidModel" })]), {
      catalog: BUILTIN_CATALOG,
      userAliases: {},
      defaultProvider: "codex",
    }).asks;
    const prompt = buildModelAsk(ask!, theme);
    expect(prompt.default).toBe(JSON.stringify({ provider: "codex", model: null }));
    // the weak candidate is still offered, just not pre-selected
    expect(prompt.choices[0]?.name).not.toContain("Run codex");
  });

  it("leaves the cursor on a strong typo candidate", () => {
    const [ask] = planModelGate(
      manifest([task({ id: "x", model: "claude-sonnet-5x" })]),
      {
        catalog: BUILTIN_CATALOG,
        userAliases: {},
        defaultProvider: "codex",
      },
    ).asks;
    const prompt = buildModelAsk(ask!, theme);
    expect(prompt.default).toBeUndefined();
    expect(prompt.choices[0]?.name).toContain("claude");
  });
});

describe("runModelGate — non-interactive", () => {
  it("rewrites the manifest for confident matches under --yes", async () => {
    const out = await runModelGate({
      ...base,
      manifest: manifest([task({ id: "a", model: "luna" })]),
      yes: true,
      stdinIsTty: false,
    });
    expect(out.decision).toBe("ok");
    if (out.decision === "ok") {
      expect(out.manifest.tasks[0]).toMatchObject({
        provider: "codex",
        model: "gpt-5.6-luna",
      });
    }
  });

  it("accepts a high-confidence best match (typo) under --yes", async () => {
    const out = await runModelGate({
      ...base,
      defaultProvider: "claude",
      manifest: manifest([task({ id: "a", model: "sonet" })]),
      yes: true,
      stdinIsTty: false,
    });
    expect(out.decision).toBe("ok");
    if (out.decision === "ok") {
      expect(out.manifest.tasks[0]?.model).toBe("claude-sonnet-5");
    }
  });

  it("aborts — never defaults — when a named model cannot be resolved", async () => {
    const out = await runModelGate({
      ...base,
      manifest: manifest([task({ id: "a", model: "quantum-9000" })]),
      yes: true,
      stdinIsTty: false,
    });
    expect(out.decision).toBe("aborted");
    if (out.decision === "aborted") {
      expect(out.message).toContain("quantum-9000");
      expect(out.message).toContain("never");
    }
  });

  it("respects a raised autoThreshold", async () => {
    const out = await runModelGate({
      ...base,
      defaultProvider: "claude",
      manifest: manifest([task({ id: "a", model: "sonet" })]),
      yes: true,
      stdinIsTty: false,
      autoThreshold: 0.99,
    });
    expect(out.decision).toBe("aborted");
  });

  it("does nothing when no task named a model", async () => {
    const out = await runModelGate({
      ...base,
      manifest: manifest([task({ id: "a" })]),
      yes: true,
      stdinIsTty: false,
    });
    expect(out.decision).toBe("ok");
    if (out.decision === "ok") expect(out.notes).toEqual([]);
  });
});
