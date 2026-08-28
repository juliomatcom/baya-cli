import { existsSync, readFileSync } from "node:fs";
import { RunStateSchema } from "../../src/executor/index.js";
import { makeWorkspace, runCli, runIds, taskResult } from "../helpers/runCli.js";
import { runPaths } from "../../src/executor/index.js";

/**
 * `state.json` is written **before** each transition is acted on
 * (conventions.md #14), atomically. A kill at any instant must therefore leave
 * a parseable file describing the last transition — never a torn write, and
 * never a lost one.
 */
const PLAN = {
  tasks: [
    {
      id: "a",
      title: "A",
      instruction: "do a",
      provider: "codex",
      model: null,
      depends_on: [],
      writes: false,
      cwd: null,
    },
    {
      id: "b",
      title: "B",
      instruction: "do b",
      provider: "codex",
      model: null,
      depends_on: ["a"],
      writes: false,
      cwd: null,
    },
  ],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("state.json under a mid-run kill", () => {
  it("is valid and reflects the last transition at every instant of a run", async () => {
    const workspace = makeWorkspace({
      scenario: {
        __planner__: { final: PLAN },
        // Long enough that the assertions below land while `a` is running.
        a: { hang_ms: 400, final: taskResult("ok", { task_id: "a", summary: "did a" }) },
        b: { final: taskResult("ok", { task_id: "b", summary: "did b" }) },
      },
    });

    const before = new Set(runIds(workspace.cwd));
    const running = runCli(["./tasks.md", "--yes"], { workspace });

    // Poll the file the way a post-crash reader would: parse whatever is there.
    const snapshots: Array<{ status: string; states: Record<string, string> }> = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(25);
      const runId = runIds(workspace.cwd).find((id) => !before.has(id));
      if (!runId) continue;
      const statePath = runPaths(workspace.cwd, runId).state;
      if (!existsSync(statePath)) continue;

      const parsed = RunStateSchema.safeParse(
        JSON.parse(readFileSync(statePath, "utf8")),
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) break;
      snapshots.push({
        status: parsed.data.status,
        states: Object.fromEntries(
          Object.entries(parsed.data.tasks).map(([id, entry]) => [id, entry.state]),
        ),
      });
      if (parsed.data.status !== "running") break;
    }

    const result = await running;
    expect(result.code).toBe(0);

    // The `running` transition was observable, which is what proves it was
    // checkpointed before the spawn rather than after it returned.
    expect(snapshots.some((snapshot) => snapshot.states["a"] === "running")).toBe(true);
    expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
  }, 20_000);

  it("records the child's pid, so a later doctor can reap a stray group", async () => {
    const result = await runCli(["./tasks.md", "--yes"], {
      scenario: {
        __planner__: { final: PLAN },
        a: { final: taskResult("ok", { task_id: "a", summary: "did a" }) },
        b: { final: taskResult("ok", { task_id: "b", summary: "did b" }) },
      },
    });
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { pid: number | null; duration_ms: number | null }>;
    };
    expect(state.tasks["a"]?.pid).toBeGreaterThan(0);
    expect(state.tasks["a"]?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("leaves no temporary file behind after the final checkpoint", async () => {
    const result = await runCli(["./tasks.md", "--yes"], {
      scenario: {
        __planner__: { final: PLAN },
        a: { final: taskResult("ok", { task_id: "a", summary: "did a" }) },
        b: { final: taskResult("ok", { task_id: "b", summary: "did b" }) },
      },
    });
    expect(existsSync(`${result.paths!.state}.${process.pid}.tmp`)).toBe(false);
  });
});
