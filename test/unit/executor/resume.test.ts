import { resumeReset, resumeTargets } from "../../../src/executor/index.js";
import type { RunState, TaskStateEntry } from "../../../src/executor/index.js";

function state(tasks: Record<string, string>): RunState {
  return {
    version: 1,
    run_id: "r1",
    status: "failed",
    started_at: "2026-08-30T12:00:00.000Z",
    updated_at: "2026-08-30T12:10:00.000Z",
    source: { path: "/tmp/tasks.md", sha256: "abc" },
    manifest_path: "/tmp/manifest.json",
    config_snapshot: {
      planner: { provider: "codex", model: null },
      defaults: { provider: "codex", model: null },
      max_parallel: 4,
      isolation: "shared",
      context_strategy: "link-only",
      context_budget: 12000,
      memory: true,
      memory_budget: 1200,
      group_size: 6,
      retries: 1,
    },
    totals: {
      succeeded: 0,
      failed: 0,
      skipped: 0,
      parked: 0,
      pending: 0,
      running: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
    },
    tasks: Object.fromEntries(
      Object.entries(tasks).map(([id, taskState]) => [
        id,
        { state: taskState } as TaskStateEntry,
      ]),
    ),
  };
}

describe("resumeTargets", () => {
  it("keeps only the succeeded tasks and re-runs everything else", () => {
    const targets = resumeTargets(
      state({
        design: "succeeded",
        build: "failed",
        verify: "skipped",
        docs: "parked",
        deploy: "running",
      }),
      ["design", "build", "verify", "docs", "deploy"],
    );
    expect(targets.keep).toEqual(["design"]);
    expect(targets.rerun).toEqual(["build", "verify", "docs", "deploy"]);
  });

  it("re-runs a task the checkpoint never recorded", () => {
    const targets = resumeTargets(state({ design: "succeeded" }), ["design", "build"]);
    expect(targets.rerun).toEqual(["build"]);
  });

  it("has nothing to re-run once every task succeeded", () => {
    const targets = resumeTargets(state({ a: "succeeded", b: "succeeded" }), ["a", "b"]);
    expect(targets.rerun).toEqual([]);
    expect(targets.keep).toEqual(["a", "b"]);
  });

  it("follows the manifest's order, not the checkpoint's", () => {
    const targets = resumeTargets(state({ b: "failed", a: "failed" }), ["a", "b"]);
    expect(targets.rerun).toEqual(["a", "b"]);
  });
});

describe("resumeReset", () => {
  it("clears the last attempt's verdict without touching its history", () => {
    const patch = resumeReset();
    expect(patch).toMatchObject({ state: "pending", failure: null, blocked_by: null });
    // Attempts and usage are the run's history: the next attempt adds to them.
    expect(patch).not.toHaveProperty("attempts");
    expect(patch).not.toHaveProperty("cost_usd");
  });
});
