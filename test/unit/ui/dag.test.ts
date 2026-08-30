import { renderDag } from "../../../src/ui/index.js";
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
  access: "read-only",
  cwd: null,
  ...overrides,
});

const manifest = (tasks: Task[]): Manifest => ({
  version: MANIFEST_VERSION,
  source: { path: "tasks.md", sha256: "x" },
  tasks,
});

describe("renderDag", () => {
  it("shows the resolved provider after model-alias routing", () => {
    const out = renderDag(
      manifest([task({ id: "ask-sonnet", model: "sonnet" })]),
      theme,
      "codex",
    );
    expect(out).toContain("claude sonnet");
    expect(out).not.toContain("default sonnet");
  });

  it("shows a pinned model even when the provider is the run default", () => {
    const out = renderDag(manifest([task({ id: "x", model: "luna" })]), theme, "codex");
    expect(out).toContain("codex luna");
  });

  it("falls back to 'default' when no default provider is passed and none is pinned", () => {
    const out = renderDag(manifest([task({ id: "x" })]), theme);
    expect(out).toContain("default");
  });

  it("groups tasks into dependency stages", () => {
    const out = renderDag(
      manifest([task({ id: "a" }), task({ id: "b", depends_on: ["a"] })]),
      theme,
      "codex",
    );
    expect(out).toContain("stage 1");
    expect(out).toContain("stage 2");
    expect(out).toContain("← a");
  });

  it("heads the preview with the stage count", () => {
    const out = renderDag(
      manifest([task({ id: "a" }), task({ id: "b", depends_on: ["a"] })]),
      theme,
      "codex",
    );
    expect(out).toContain("Run order · 2 stages");
  });

  /**
   * The line describes the **graph**, never execution: the executor is
   * sequential until M2.1, and grouping puts a stage's tasks in one process to
   * be worked through in order.
   */
  it("explains stage independence only when a stage holds more than one task", () => {
    const parallel = renderDag(
      manifest([task({ id: "a" }), task({ id: "b" })]),
      theme,
      "codex",
    );
    expect(parallel).toContain("no dependencies within a stage");

    // A pure chain has one task per stage — there is no independence to explain.
    const chain = renderDag(
      manifest([task({ id: "a" }), task({ id: "b", depends_on: ["a"] })]),
      theme,
      "codex",
    );
    expect(chain).not.toContain("no dependencies within a stage");
  });

  it("says 'stage', singular, for a one-stage plan", () => {
    const out = renderDag(manifest([task({ id: "a" })]), theme, "codex");
    expect(out).toContain("Run order · 1 stage");
    expect(out).not.toContain("1 stages");
  });
});
