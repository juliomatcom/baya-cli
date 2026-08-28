import { readLog, runCli, taskResult } from "../helpers/runCli.js";

/**
 * stdin discipline (providers.md §1). `claude -p` blocks 3s per task on
 * inherited stdin and `codex exec` writes a spurious warning; across a 20-task
 * run that is a minute of pure latency. Every spawn sets stdin explicitly.
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
  ],
};

describe("prompt delivery", () => {
  it("hands the prompt to the child on stdin, and the child actually receives it", async () => {
    const result = await runCli(["./tasks.md", "--yes"], {
      scenario: {
        __planner__: { final: PLAN },
        // The fake fails with exit 2 unless stdin carries this substring.
        a: {
          expect_stdin: "Respond with a single JSON object",
          final: taskResult("ok", { task_id: "a", summary: "read the prompt" }),
        },
      },
    });
    expect(result.code).toBe(0);
    const spawned = readLog(result.paths!).find(
      (line) => line["event"] === "task.spawned",
    );
    expect(spawned?.["delivery"]).toBe("stdin");
  });

  it("completes well inside the 3s stall an inherited stdin would cost", async () => {
    const started = Date.now();
    const result = await runCli(["./tasks.md", "--yes"], {
      scenario: {
        __planner__: { final: PLAN },
        a: { final: taskResult("ok", { task_id: "a", summary: "fast" }) },
      },
    });
    expect(result.code).toBe(0);
    // Two spawns (planner + task). Inheriting stdin would cost ~3s each.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("emits no stdin warning on either stream", async () => {
    const result = await runCli(["./tasks.md", "--yes"], {
      scenario: {
        __planner__: { final: PLAN },
        a: { final: taskResult("ok", { task_id: "a", summary: "quiet" }) },
      },
    });
    expect(result.stderr.toLowerCase()).not.toContain("no stdin data received");
    expect(result.readText(result.paths!.stderr("a"))).not.toContain(
      "Reading additional input",
    );
  });
});
