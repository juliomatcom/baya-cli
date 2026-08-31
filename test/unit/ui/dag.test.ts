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

  /**
   * Grouping is the other half of what the gate is asking about: which tasks
   * share one process. The assertions are about *which tasks land together*,
   * not about how the line reads.
   */
  describe("group projection", () => {
    const sonnet = (id: string, deps: string[] = []): Task =>
      task({ id, model: "claude-sonnet-5", depends_on: deps });

    const groupsIn = (out: string): Map<string, string> => {
      const found = new Map<string, string>();
      for (const line of out.split("\n")) {
        const match = line.match(/^\s+·\s+(\S+).*\(group (#\d+)\)/);
        if (match) found.set(match[1] as string, match[2] as string);
      }
      return found;
    };

    it("puts tasks that share a process under one group number", () => {
      const out = renderDag(
        manifest([sonnet("a"), sonnet("b"), task({ id: "c", model: "luna" })]),
        theme,
        "codex",
      );
      const groups = groupsIn(out);
      expect(groups.get("a")).toBe(groups.get("b"));
      expect(groups.get("c")).not.toBe(groups.get("a"));
    });

    it("shows a chain collapsing across stages into one process", () => {
      const groups = groupsIn(
        renderDag(manifest([sonnet("a"), sonnet("b", ["a"])]), theme, "codex"),
      );
      expect(groups.get("b")).toBe(groups.get("a"));
    });

    it("counts processes against tasks", () => {
      const out = renderDag(manifest([sonnet("a"), sonnet("b")]), theme, "codex");
      expect(out).toContain("2 tasks → 1 process");
    });

    it("warns about a group that fills --group-size, naming it", () => {
      const out = renderDag(
        manifest([sonnet("a"), sonnet("b"), sonnet("c")]),
        theme,
        "codex",
        { groupSize: 3 },
      );
      const groups = groupsIn(out);
      expect(out).toContain(`group ${groups.get("a")} fills`);
      expect(out).toContain("--group-size 3");
    });

    it("stays quiet when no group holds more than one task", () => {
      const out = renderDag(manifest([sonnet("a"), sonnet("b")]), theme, "codex", {
        groupSize: 1,
      });
      expect(out).not.toContain("group #");
      expect(out).not.toContain("processes");
    });

    /**
     * A task pinning the run's own model must not read as a separate process
     * from one that pins nothing — that split would exist in the preview only.
     */
    it("keys against the run defaults, as the scheduler does", () => {
      const groups = groupsIn(
        renderDag(
          manifest([task({ id: "a" }), task({ id: "b", model: "gpt-5.6-luna" })]),
          theme,
          "codex",
          { defaultModel: "gpt-5.6-luna" },
        ),
      );
      expect(groups.get("a")).toBe(groups.get("b"));
    });
  });
});
