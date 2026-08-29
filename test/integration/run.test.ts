import { existsSync } from "node:fs";
import { readLog, runCli, taskResult } from "../helpers/runCli.js";

/**
 * The M1 exit criterion, offline: a two-task chain planned, confirmed, and
 * executed end to end against the fake provider.
 */
const PLAN = {
  tasks: [
    {
      id: "design-api",
      title: "Design the API",
      instruction: "Design six endpoints.",
      provider: "codex",
      model: null,
      depends_on: [],
      writes: false,
      cwd: null,
    },
    {
      id: "gen-schema",
      title: "Generate DB schema",
      instruction: "Create the tables.",
      provider: "codex",
      model: null,
      depends_on: ["design-api"],
      writes: true,
      cwd: null,
    },
  ],
};

const scenario = {
  __planner__: { final: PLAN },
  "design-api": {
    emit: [
      { line: '{"type":"thread.started","thread_id":"t-1"}' },
      {
        line: '{"type":"item.completed","item":{"type":"agent_message","text":"thinking"}}',
      },
    ],
    final: taskResult("ok", {
      task_id: "design-api",
      summary: "Defined 6 REST endpoints and their error shapes.",
      output: "## API\n\nsix endpoints",
    }),
  },
  "gen-schema": {
    emit: [{ line: '{"type":"thread.started","thread_id":"t-2"}' }],
    final: taskResult("ok", {
      task_id: "gen-schema",
      summary: "Created 4 tables with FK constraints.",
      output: "## Schema",
      files_changed: ["migrations/001.sql"],
    }),
  },
};

describe("a two-task chain, end to end", () => {
  it("exits 0 and runs both tasks in dependency order", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    expect(result.code).toBe(0);

    const state = result.readJson(result.paths!.state) as {
      status: string;
      totals: Record<string, number>;
      tasks: Record<string, { state: string; session_id: string | null }>;
    };
    expect(state.status).toBe("completed");
    expect(state.totals).toMatchObject({ succeeded: 2, failed: 0, skipped: 0 });
    expect(state.tasks["design-api"]?.state).toBe("succeeded");
    expect(state.tasks["gen-schema"]?.state).toBe("succeeded");
  });

  it("captures each provider's session id, which is what resume needs", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { session_id: string | null }>;
    };
    expect(state.tasks["design-api"]?.session_id).toBe("t-1");
    expect(state.tasks["gen-schema"]?.session_id).toBe("t-2");
  });

  it("persists every artifact for both tasks", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const paths = result.paths!;
    for (const taskId of ["design-api", "gen-schema"]) {
      for (const artifact of [
        paths.request(taskId),
        paths.result(taskId),
        paths.output(taskId),
        paths.events(taskId),
        paths.stdout(taskId),
        paths.stderr(taskId),
      ]) {
        expect({ artifact, exists: existsSync(artifact) }).toEqual({
          artifact,
          exists: true,
        });
      }
    }
    expect(existsSync(paths.manifest)).toBe(true);
    expect(existsSync(paths.report)).toBe(true);
    expect(existsSync(paths.log)).toBe(true);
  });

  it("emits the task_result JSON Schema the provider is held to", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    expect(existsSync(`${result.paths!.schemaDir}/task_result.schema.json`)).toBe(true);
  });

  it("feeds the upstream result downstream as context", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const request = result.readJson(result.paths!.request("gen-schema")) as {
      context: Array<{ task_id: string; summary: string; inline: string | null }>;
    };
    expect(request.context).toHaveLength(1);
    expect(request.context[0]).toMatchObject({
      task_id: "design-api",
      summary: "Defined 6 REST endpoints and their error shapes.",
      inline: "## API\n\nsix endpoints",
    });
  });

  it("records the manifest and a config snapshot a resume could reproduce", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const state = result.readJson(result.paths!.state) as {
      config_snapshot: Record<string, unknown>;
      source: { sha256: string };
    };
    expect(state.config_snapshot).toMatchObject({
      defaults: { provider: "codex", model: null },
      max_parallel: 1,
      context_strategy: "link-only",
    });
    expect(state.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the event vocabulary", () => {
  it("records the full startup-to-teardown sequence in baya.jsonl", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const events = readLog(result.paths!).map((line) => String(line["event"]));

    const expected = [
      "cli.invoked",
      "source.read",
      "plan.requested",
      "plan.received",
      "plan.validated",
      "plan.confirmed",
      "run.created",
      "run.started",
      "task.ready",
      "task.request.written",
      "task.spawned",
      "task.succeeded",
      "run.completed",
    ];
    // Assert order, not adjacency: provider output interleaves between these.
    let cursor = -1;
    for (const event of expected) {
      const found = events.indexOf(event, cursor + 1);
      expect({ event, found: found > cursor }).toEqual({ event, found: true });
      cursor = found;
    }
  });

  it("stamps every line with the run id, so concurrent logs stay distinguishable", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const lines = readLog(result.paths!);
    expect(lines.every((line) => line["run_id"] === result.runId)).toBe(true);
  });

  it("never inlines a prompt into a log line — only its byte count", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const spawned = readLog(result.paths!).find(
      (line) => line["event"] === "task.spawned",
    );
    expect(spawned?.["prompt"]).toBeUndefined();
    expect(spawned?.["prompt_bytes"]).toBeGreaterThan(0);
    expect(spawned?.["request"]).toContain("request.json");
  });

  it("keeps the prompt out of argv, where untrusted markdown must never land", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const spawned = readLog(result.paths!).find(
      (line) => line["event"] === "task.spawned",
    );
    expect(spawned?.["delivery"]).toBe("stdin");
    expect(JSON.stringify(spawned?.["argv"])).not.toContain("Design six endpoints");
  });
});

describe("--dry-run", () => {
  it("renders the DAG, executes nothing, and exits 0", async () => {
    const result = await runCli(["./tasks.md", "--dry-run"], { scenario });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("design-api");
    expect(result.stderr).toContain("gen-schema");
    expect(existsSync(result.paths!.state)).toBe(false);
  });

  it("is what `baya plan` means", async () => {
    const result = await runCli(["plan", "./tasks.md"], { scenario });
    expect(result.code).toBe(0);
    expect(existsSync(result.paths!.state)).toBe(false);
  });
});

describe("the plan gate", () => {
  it("refuses to hang when stdin is not a TTY and --yes was not passed", async () => {
    const result = await runCli(["./tasks.md"], { scenario, stdinIsTty: false });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--yes");
  });
});

describe("task-list file format", () => {
  it("plans and runs a plain-text (.txt) task list, not just Markdown", async () => {
    const result = await runCli(["./TODO.txt", "--yes"], {
      scenario,
      taskFile: "TODO.txt",
      taskList: "1 design the api\n2 generate the db schema from that design\n",
    });
    expect(result.code).toBe(0);
    const state = result.readJson(result.paths!.state) as { status: string };
    expect(state.status).toBe("completed");
  });

  it("rejects a binary file with a clear message instead of feeding it to the planner", async () => {
    const result = await runCli(["./tasks.bin", "--yes"], {
      scenario,
      taskFile: "tasks.bin",
      taskList: "PK\u0000\u0003\u0004 binary payload",
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not look like a text file");
  });
});
