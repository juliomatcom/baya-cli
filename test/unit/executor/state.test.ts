import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunStateSchema,
  StateStore,
  emptyTaskEntry,
  makeRunId,
  readState,
  runPaths,
  type RunState,
} from "../../../src/executor/index.js";

function initialState(taskIds: string[]): RunState {
  return {
    version: 1,
    run_id: "20260828T2152Z-a1f4c9-1",
    status: "running",
    started_at: "2026-08-28T21:52:03.000Z",
    updated_at: "2026-08-28T21:52:03.000Z",
    source: { path: "tasks.md", sha256: "abc" },
    manifest_path: "manifest.json",
    config_snapshot: {
      planner: { provider: "codex", model: null },
      defaults: { provider: "codex", model: null },
      max_parallel: 1,
      isolation: "shared",
      context_strategy: "link-only",
      context_budget: 12_000,
      memory: true,
      memory_budget: 1200,
      session_reuse: true,
    },
    totals: {
      succeeded: 0,
      failed: 0,
      skipped: 0,
      parked: 0,
      pending: taskIds.length,
      running: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
    },
    tasks: Object.fromEntries(taskIds.map((id) => [id, emptyTaskEntry()])),
  };
}

function store(taskIds: string[]): { store: StateStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "baya-state-")), "state.json");
  return { store: new StateStore(path, initialState(taskIds)), path };
}

describe("makeRunId", () => {
  it("is <utc-timestamp>-<rand>-<pid>", () => {
    expect(makeRunId(new Date("2026-08-28T21:52:04.118Z"), 3182)).toMatch(
      /^20260828T215204Z-[0-9a-f]{6}-3182$/,
    );
  });

  it("sorts lexically by start time", () => {
    const early = makeRunId(new Date("2026-08-28T21:00:00Z"), 1);
    const late = makeRunId(new Date("2026-08-28T22:00:00Z"), 1);
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("is unique across calls in the same second", () => {
    const now = new Date();
    expect(makeRunId(now, 1)).not.toBe(makeRunId(now, 1));
  });
});

describe("StateStore", () => {
  it("checkpoints on construction so a crash before the first task still leaves state", () => {
    const { store: s, path } = store(["a"]);
    s.checkpoint();
    expect(readState(path).run_id).toBe(s.get().run_id);
  });

  it("recomputes totals on every transition", () => {
    const { store: s } = store(["a", "b"]);
    s.transition("a", { state: "succeeded", cost_usd: 0.21 });
    s.transition("b", { state: "failed" });
    expect(s.get().totals).toMatchObject({
      succeeded: 1,
      failed: 1,
      pending: 0,
      cost_usd: 0.21,
    });
  });

  it("rounds accumulated cost so a long run does not render float noise", () => {
    const { store: s } = store(["a", "b", "c"]);
    s.transition("a", { state: "succeeded", cost_usd: 0.1 });
    s.transition("b", { state: "succeeded", cost_usd: 0.2 });
    s.transition("c", { state: "succeeded", cost_usd: 0.12 });
    expect(s.get().totals.cost_usd).toBe(0.42);
  });

  it("writes a parseable file after every transition, so a kill mid-run loses nothing", () => {
    const { store: s, path } = store(["a", "b"]);
    s.transition("a", { state: "running", pid: 4242 });
    // Simulates reading the file at the instant a SIGKILL landed.
    const snapshot = RunStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(snapshot.tasks["a"]).toMatchObject({ state: "running", pid: 4242 });
    expect(snapshot.tasks["b"]?.state).toBe("pending");
  });

  it("stamps updated_at on each write", () => {
    const { store: s } = store(["a"]);
    const before = s.get().updated_at;
    s.transition("a", { state: "running" });
    expect(s.get().updated_at).not.toBe(before);
  });

  it("fires the checkpoint hook — the state.checkpointed trace event", () => {
    const path = join(mkdtempSync(join(tmpdir(), "baya-state-")), "state.json");
    const seen: string[] = [];
    const s = new StateStore(path, initialState(["a"]), (state) =>
      seen.push(state.status),
    );
    s.transition("a", { state: "succeeded" });
    s.setStatus("completed");
    expect(seen).toEqual(["running", "completed"]);
  });

  it("refuses a malformed state file rather than starting fresh", () => {
    const path = join(mkdtempSync(join(tmpdir(), "baya-state-")), "state.json");
    writeFileSync(path, JSON.stringify({ version: 1, run_id: "x" }));
    expect(() => readState(path)).toThrow();
  });
});

describe("runPaths", () => {
  it("puts every artifact under the run's task directory", () => {
    const paths = runPaths("/work", "run-1");
    expect(paths.request("gen-schema")).toBe(
      "/work/.baya/runs/run-1/tasks/gen-schema/request.json",
    );
    expect(paths.lockFile).toBe("/work/.baya/baya.lock");
    expect(paths.log).toBe("/work/.baya/runs/run-1/baya.jsonl");
  });
});
