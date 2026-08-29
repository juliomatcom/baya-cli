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
  writes: false,
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

  it("groups tasks into dependency layers", () => {
    const out = renderDag(
      manifest([task({ id: "a" }), task({ id: "b", depends_on: ["a"] })]),
      theme,
      "codex",
    );
    expect(out).toContain("layer 1");
    expect(out).toContain("layer 2");
    expect(out).toContain("← a");
  });
});
