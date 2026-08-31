import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorkspace, runCli, taskResult, type Workspace } from "../helpers/runCli.js";

/**
 * `baya resume` (recovery.md §Resume): the unfinished tasks run again, the
 * succeeded ones never do, and their outputs are still the upstream context.
 */
const PLAN = {
  tasks: [
    {
      id: "design",
      title: "Design",
      instruction: "design",
      provider: "codex",
      model: null,
      depends_on: [],
      access: "read-write",
      cwd: null,
    },
    {
      id: "build",
      title: "Build",
      instruction: "build",
      provider: "codex",
      model: null,
      depends_on: ["design"],
      access: "read-write",
      cwd: null,
    },
    {
      id: "verify",
      title: "Verify",
      instruction: "verify",
      provider: "codex",
      model: null,
      depends_on: ["build"],
      access: "read-write",
      cwd: null,
    },
  ],
};

const ok = (id: string): unknown =>
  taskResult("ok", { task_id: id, summary: `did ${id}`, output: `# ${id}` });

function scenario(workspace: Workspace, byTask: Record<string, unknown>): void {
  writeFileSync(workspace.scenarioPath, JSON.stringify({ by_task: byTask }));
}

/** A first run in which `build` fails, so `verify` is skipped. */
async function failedRun(): Promise<{
  workspace: Workspace;
  paths: NonNullable<Awaited<ReturnType<typeof runCli>>["paths"]>;
  runId: string;
}> {
  const workspace = makeWorkspace();
  scenario(workspace, {
    __planner__: { final: PLAN },
    design: { final: ok("design") },
    build: { exit_code: 1, stderr: "codex: boom", final: null },
    verify: { final: ok("verify") },
  });
  const first = await runCli(["./tasks.md", "--yes", "--group-size", "1"], { workspace });
  expect(first.code).toBe(1);
  return { workspace, paths: first.paths!, runId: first.runId! };
}

describe("baya resume", () => {
  it("re-runs the unfinished tasks and never the succeeded one", async () => {
    const { workspace, paths, runId } = await failedRun();
    const before = readFileSync(paths.state, "utf8");
    expect(JSON.parse(before).tasks.design.state).toBe("succeeded");

    // `design` would fail loudly if it were re-run; the marker records any
    // process that started for it.
    const marker = join(workspace.cwd, "design-ran.jsonl");
    scenario(workspace, {
      __planner__: { final: PLAN },
      design: { writes_file: marker, exit_code: 1, final: null },
      build: { final: ok("build") },
      verify: { final: ok("verify") },
    });

    const resumed = await runCli(["resume", runId, "--group-size", "1"], { workspace });
    expect(resumed.code).toBe(0);
    expect(existsSync(marker)).toBe(false);

    const state = JSON.parse(readFileSync(paths.state, "utf8")) as {
      status: string;
      run_id: string;
      totals: Record<string, number>;
      tasks: Record<string, { state: string; attempts: number; ended_at: string }>;
    };
    expect(state.status).toBe("completed");
    expect(state.run_id).toBe(runId);
    expect(state.totals).toMatchObject({ succeeded: 3, failed: 0, skipped: 0 });
    expect(state.tasks["design"]?.attempts).toBe(1);
    // `attempts` is the task's lifetime process count, not per-resume: one
    // initial attempt, one `--retries` retry inside the failed run, one more on
    // resume. A resume does not reset it or refill the retry budget.
    expect(state.tasks["build"]?.attempts).toBe(3);
    expect(state.tasks["design"]?.ended_at).toBe(
      (JSON.parse(before) as typeof state).tasks["design"]?.ended_at,
    );
  });

  it("hands the kept task's output to the re-run task as context", async () => {
    const { workspace, paths, runId } = await failedRun();
    scenario(workspace, {
      __planner__: { final: PLAN },
      design: { final: ok("design") },
      build: { final: ok("build") },
      verify: { final: ok("verify") },
    });
    await runCli(["resume", runId, "--group-size", "1"], { workspace });

    const request = JSON.parse(readFileSync(paths.request("build"), "utf8")) as {
      context: Array<{ task_id: string; summary: string }>;
    };
    expect(request.context).toHaveLength(1);
    expect(request.context[0]).toMatchObject({
      task_id: "design",
      summary: "did design",
    });
  });

  it("finishes a run an interrupt left half-done", async () => {
    const { workspace, paths, runId } = await failedRun();
    // What a Ctrl+C leaves behind: the run interrupted, its live task still
    // marked `running` with no result of its own.
    const state = JSON.parse(readFileSync(paths.state, "utf8")) as Record<string, any>;
    state.status = "interrupted";
    state.tasks.build = { ...state.tasks.build, state: "running", failure: null };
    writeFileSync(paths.state, JSON.stringify(state));

    scenario(workspace, {
      __planner__: { final: PLAN },
      design: { final: ok("design") },
      build: { final: ok("build") },
      verify: { final: ok("verify") },
    });
    const resumed = await runCli(["resume", runId, "--group-size", "1"], { workspace });
    expect(resumed.code).toBe(0);

    const after = JSON.parse(readFileSync(paths.state, "utf8")) as {
      status: string;
      tasks: Record<string, { state: string }>;
    };
    expect(after.status).toBe("completed");
    expect(after.tasks["build"]?.state).toBe("succeeded");
    expect(after.tasks["verify"]?.state).toBe("succeeded");
  });

  it("warns when the task list changed since the run was planned", async () => {
    const { workspace, runId } = await failedRun();
    writeFileSync(workspace.tasksPath, "# Design the API\n\nsomething else entirely\n");
    scenario(workspace, {
      __planner__: { final: PLAN },
      design: { final: ok("design") },
      build: { final: ok("build") },
      verify: { final: ok("verify") },
    });

    const resumed = await runCli(["resume", runId, "--group-size", "1"], { workspace });
    expect(resumed.code).toBe(0);
    expect(resumed.stderr).toContain("changed since this run was planned");
  });

  it("re-runs the unfinished tasks on the provider --provider names", async () => {
    const { workspace, paths, runId } = await failedRun();
    scenario(workspace, {
      __planner__: { final: PLAN },
      design: { final: ok("design") },
      build: { final: ok("build") },
      verify: { final: ok("verify") },
    });

    // `claude` is not installed in the test workspace, so the override is
    // observable without a second fake binary: the re-run tasks fail on a
    // missing provider while the kept one is untouched.
    const resumed = await runCli(["resume", runId, "--provider", "claude"], {
      workspace,
    });
    expect(resumed.code).toBe(1);
    const state = JSON.parse(readFileSync(paths.state, "utf8")) as {
      tasks: Record<string, { state: string; provider: string }>;
    };
    expect(state.tasks["design"]?.state).toBe("succeeded");
    expect(state.tasks["design"]?.provider).toBe("codex");
    expect(state.tasks["build"]?.provider).toBe("claude");
  });

  it("refuses to guess a run when stdin is not a terminal", async () => {
    const { workspace } = await failedRun();
    const resumed = await runCli(["resume"], { workspace });
    expect(resumed.code).toBe(2);
    expect(resumed.stderr).toContain("run id");
  });

  it("reports an unreadable checkpoint instead of starting fresh", async () => {
    const { workspace, paths, runId } = await failedRun();
    writeFileSync(paths.state, '{"version":1,"status":"fail');
    const resumed = await runCli(["resume", runId], { workspace });
    expect(resumed.code).toBe(2);
    expect(resumed.stderr).toContain("unreadable");
  });
});
