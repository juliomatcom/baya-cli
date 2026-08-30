import { readLog, runCli, taskResult } from "../helpers/runCli.js";

/**
 * A failure must stay local: its descendants become `skipped`, never `failed`,
 * and the run reports rather than aborting.
 */
const PLAN = {
  tasks: [
    {
      id: "build-ui",
      title: "Build UI",
      instruction: "build",
      provider: "codex",
      model: null,
      depends_on: [],
      access: "read-write",
      cwd: null,
    },
    {
      id: "write-tests",
      title: "Write tests",
      instruction: "test",
      provider: "codex",
      model: null,
      depends_on: ["build-ui"],
      access: "read-write",
      cwd: null,
    },
    {
      id: "integrate",
      title: "Integrate",
      instruction: "integrate",
      provider: "codex",
      model: null,
      depends_on: ["write-tests"],
      access: "read-write",
      cwd: null,
    },
  ],
};

const failing = {
  __planner__: { final: PLAN },
  "build-ui": {
    stderr: "codex: something went wrong",
    exit_code: 1,
    final: null,
  },
  "write-tests": { final: taskResult("ok", { task_id: "write-tests", summary: "s" }) },
  integrate: { final: taskResult("ok", { task_id: "integrate", summary: "s" }) },
};

describe("failure semantics", () => {
  it("marks every descendant skipped, not failed", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario: failing });
    const state = result.readJson(result.paths!.state) as {
      totals: Record<string, number>;
      tasks: Record<string, { state: string; blocked_by: string | null }>;
    };
    expect(state.tasks["build-ui"]?.state).toBe("failed");
    expect(state.tasks["write-tests"]).toMatchObject({
      state: "skipped",
      blocked_by: "build-ui",
    });
    expect(state.tasks["integrate"]).toMatchObject({ state: "skipped" });
    expect(state.totals).toMatchObject({ failed: 1, skipped: 2, succeeded: 0 });
  });

  it("exits 1 and says so, rather than aborting mid-run", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario: failing });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("1 failed");
    expect(result.stderr).toContain("2 skipped");
  });

  it("records a normalized failure a resume could act on", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario: failing });
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { failure: { kind: string; retry: string } | null }>;
    };
    expect(state.tasks["build-ui"]?.failure).toMatchObject({
      kind: "crash",
      retry: "now",
    });
  });

  // `--group-size 1`: "the provider wrote no result at all" is a property of a
  // process, and only a process running one task can be in that state. In a
  // group the other members still answer, so the document exists.
  it("synthesizes a task_result even when the provider wrote none", async () => {
    const result = await runCli(["./tasks.md", "--yes", "--group-size", "1"], {
      scenario: failing,
    });
    const failed = result.readJson(result.paths!.result("build-ui")) as {
      status: string;
      error: { message: string };
      notes: unknown[];
    };
    expect(failed.status).toBe("failed");
    expect(failed.error.message).toContain("something went wrong");
    expect(failed.notes).toEqual([]);
  });

  it("logs task.failed and task.skipped with their causes", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario: failing });
    const lines = readLog(result.paths!);
    expect(lines.find((line) => line["event"] === "task.failed")).toMatchObject({
      task_id: "build-ui",
      kind: "crash",
    });
    expect(lines.filter((line) => line["event"] === "task.skipped")).toHaveLength(2);
  });

  it("lets an independent branch finish while another fails", async () => {
    const forked = {
      tasks: [
        ...PLAN.tasks.slice(0, 2),
        {
          id: "docs",
          title: "Docs",
          instruction: "write docs",
          provider: "codex",
          model: null,
          depends_on: [],
          access: "read-only",
          cwd: null,
        },
      ],
    };
    const result = await runCli(["./tasks.md", "--yes"], {
      scenario: {
        __planner__: { final: forked },
        "build-ui": { stderr: "boom", exit_code: 1, final: null },
        "write-tests": {
          final: taskResult("ok", { task_id: "write-tests", summary: "s" }),
        },
        docs: { final: taskResult("ok", { task_id: "docs", summary: "documented" }) },
      },
    });
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { state: string }>;
    };
    expect(state.tasks["docs"]?.state).toBe("succeeded");
    expect(state.tasks["write-tests"]?.state).toBe("skipped");
    expect(result.code).toBe(1);
  });

  it("reports a note from a failed task — that is often where the useful one is", async () => {
    const result = await runCli(["./tasks.md", "--yes"], {
      scenario: {
        __planner__: { final: { tasks: [PLAN.tasks[0]] } },
        "build-ui": {
          final: taskResult("failed", {
            task_id: "build-ui",
            summary: "",
            error: { message: "quota exceeded", retryable: false },
            notes: [
              { severity: "action_required", message: "top up credits to continue" },
            ],
          }),
        },
      },
    });
    expect(result.stderr).toContain("top up credits to continue");
    expect(result.code).toBe(1);
  });
});

describe("a question with no escalation available yet", () => {
  it("parks the task and surfaces the question instead of guessing", async () => {
    const result = await runCli(["./tasks.md", "--yes"], {
      scenario: {
        __planner__: { final: { tasks: PLAN.tasks.slice(0, 2) } },
        "build-ui": {
          final: taskResult("needs_input", {
            task_id: "build-ui",
            summary: "",
            question: {
              text: "Which CSS framework?",
              options: ["tailwind"],
              default: null,
            },
          }),
        },
        "write-tests": {
          final: taskResult("ok", { task_id: "write-tests", summary: "s" }),
        },
      },
    });
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { state: string }>;
    };
    expect(state.tasks["build-ui"]?.state).toBe("parked");
    expect(state.tasks["write-tests"]?.state).toBe("skipped");
    expect(result.stderr).toContain("Which CSS framework?");
    expect(result.code).toBe(1);
  });
});

describe("a provider that cannot be resolved", () => {
  it("stops at setup with a pointer to doctor, before spending anything", async () => {
    const result = await runCli(["./tasks.md", "--yes"], {
      scenario: {
        __planner__: { final: { tasks: [PLAN.tasks[0]] } },
      },
      config: { providers: { codex: { bin: "/nonexistent/codex" } } },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("baya doctor");
  });
});
