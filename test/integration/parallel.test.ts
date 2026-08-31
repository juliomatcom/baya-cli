import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorkspace, runCli, taskResult, type Workspace } from "../helpers/runCli.js";

/**
 * The scheduler admits several groups at once (execution.md §Scheduler), under
 * the global cap, the per-provider cap and the single-writer semaphore.
 *
 * Overlap is read off the fake provider's `writes_file` start/end markers
 * rather than inferred from wall-clock timing, which flakes.
 */
interface Marker {
  pid: number;
  event: "start" | "end";
  ts: number;
}

/** The most processes alive at any point, from the marker log. */
function peakConcurrency(markerPath: string): number {
  const markers = readFileSync(markerPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Marker);
  let live = 0;
  let peak = 0;
  for (const marker of markers) {
    live += marker.event === "start" ? 1 : -1;
    peak = Math.max(peak, live);
  }
  return peak;
}

function fanIn(access: "read-only" | "read-write"): object {
  const leaves = ["a", "b", "c", "d"].map((id) => ({
    id,
    title: `Leaf ${id}`,
    instruction: "leaf",
    provider: "codex",
    model: null,
    depends_on: [],
    access,
    cwd: null,
  }));
  return {
    tasks: [
      ...leaves,
      {
        id: "join",
        title: "Join",
        instruction: "join",
        provider: "codex",
        model: null,
        depends_on: ["a", "b", "c", "d"],
        access,
        cwd: null,
      },
    ],
  };
}

/**
 * A workspace whose scenario names a marker file inside it — the path is only
 * knowable once the workspace exists, so the scenario is written afterwards.
 */
function stage(access: "read-only" | "read-write"): {
  workspace: Workspace;
  markerPath: string;
} {
  const workspace = makeWorkspace();
  const markerPath = join(workspace.cwd, "markers.jsonl");
  writeFileSync(
    workspace.scenarioPath,
    JSON.stringify({ by_task: scenarioFor(access, markerPath) }),
  );
  return { workspace, markerPath };
}

function scenarioFor(
  access: "read-only" | "read-write",
  markerPath: string,
): Record<string, unknown> {
  const perTask = Object.fromEntries(
    ["a", "b", "c", "d", "join"].map((id) => [
      id,
      {
        hang_ms: 150,
        writes_file: markerPath,
        final: taskResult("ok", { task_id: id, summary: `did ${id}` }),
      },
    ]),
  );
  return { __planner__: { final: fanIn(access) }, ...perTask };
}

describe("the parallel scheduler", () => {
  it("overlaps ready groups without exceeding the per-provider cap", async () => {
    const { workspace, markerPath } = stage("read-only");
    const result = await runCli(
      ["./tasks.md", "--yes", "--group-size", "1", "--max-parallel", "4"],
      { workspace },
    );

    expect(result.code).toBe(0);
    const state = result.readJson(result.paths!.state) as {
      totals: Record<string, number>;
    };
    expect(state.totals.succeeded).toBe(5);

    // codex caps at 2 concurrent processes, under a global budget of 4.
    const peak = peakConcurrency(markerPath);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("never overlaps two writers", async () => {
    const { workspace, markerPath } = stage("read-write");
    const result = await runCli(
      ["./tasks.md", "--yes", "--group-size", "1", "--max-parallel", "4"],
      { workspace },
    );

    expect(result.code).toBe(0);
    expect(peakConcurrency(markerPath)).toBe(1);
  });

  it("runs the fan-in only after every upstream has finished", async () => {
    const { workspace } = stage("read-only");
    const result = await runCli(
      ["./tasks.md", "--yes", "--group-size", "1", "--max-parallel", "4"],
      { workspace },
    );
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { started_at: string; ended_at: string }>;
    };
    const joined = Date.parse(state.tasks["join"]!.started_at);
    for (const id of ["a", "b", "c", "d"]) {
      expect(Date.parse(state.tasks[id]!.ended_at)).toBeLessThanOrEqual(joined);
    }
  });
});
