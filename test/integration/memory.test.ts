import { existsSync } from "node:fs";
import { runCli, taskResult } from "../helpers/runCli.js";
import { DEFAULT_GROUP_SIZE } from "../../src/executor/index.js";

/**
 * Cross-task memory, end to end (execution.md §Memory).
 *
 * The delivery assertion rides on the fake provider's `expect_stdin`: if the
 * memory block never reached the prompt, the task fails and the run exits
 * non-zero. That is a stronger check than reading `memory.json` back, because
 * it proves the fact travelled all the way into what a CLI was actually sent.
 */
const PLAN = {
  tasks: [
    {
      id: "probe-tests",
      title: "Find the test command",
      instruction: "Work out how the suite runs.",
      provider: "codex",
      model: null,
      depends_on: [],
      access: "read-only",
      cwd: null,
    },
    {
      id: "probe-docs",
      title: "Read the docs",
      instruction: "Skim the docs.",
      provider: "codex",
      model: null,
      depends_on: [],
      access: "read-only",
      cwd: null,
    },
    {
      id: "use-memory",
      title: "Do the work",
      instruction: "Change the code.",
      provider: "codex",
      model: null,
      // `read-write`, so it can never share a process with the read-only
      // probes above: memory has to cross a group boundary to reach it.
      depends_on: ["probe-tests", "probe-docs"],
      access: "read-write",
      cwd: null,
    },
  ],
};

const item = (payload: Record<string, unknown>): { line: string } => ({
  line: JSON.stringify({ type: "item.completed", item: payload }),
});

const scenario = {
  __planner__: { final: PLAN },
  "probe-tests": {
    emit: [
      { line: '{"type":"thread.started","thread_id":"t-1"}' },
      item({
        type: "command_execution",
        command: "/bin/zsh -lc 'npm test'",
        exit_code: "1",
        status: "failed",
      }),
      item({
        type: "command_execution",
        command: "/bin/zsh -lc 'npm test -- --runInBand'",
        exit_code: "0",
        status: "completed",
      }),
    ],
    final: taskResult("ok", { task_id: "probe-tests", summary: "Found it." }),
  },
  "probe-docs": {
    emit: [
      { line: '{"type":"thread.started","thread_id":"t-2"}' },
      item({
        type: "command_execution",
        command: "/bin/zsh -lc 'sed -n 1,20p docs/index.md'",
        exit_code: "0",
        status: "completed",
      }),
    ],
    final: taskResult("ok", { task_id: "probe-docs", summary: "Skimmed." }),
  },
  "use-memory": {
    expect_stdin: "npm test",
    emit: [{ line: '{"type":"thread.started","thread_id":"t-3"}' }],
    final: taskResult("ok", { task_id: "use-memory", summary: "Done." }),
  },
};

describe("cross-task memory", () => {
  it("carries an earlier task's dead end into a later task's prompt", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    // `expect_stdin` fails the task if the block never arrived.
    expect(result.code).toBe(0);
  });

  it("records what it derived, so a run can be audited and measured", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const entries = result.readJson(result.paths!.memory) as Array<{
      kind: string;
      value: string;
      sources: string[];
    }>;

    expect(entries).toContainEqual(
      expect.objectContaining({ kind: "command.deadend", value: "npm test" }),
    );
    // Ran clean later, so it is a capability rather than a dead end.
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "command.verified",
        value: "npm test -- --runInBand",
      }),
    );
    // Read by one task only — below the threshold, so not carried.
    expect(entries.map((entry) => entry.value)).not.toContain("docs/index.md");
  });

  it("--no-memory leaves every task blind, and writes no snapshot", async () => {
    const blind = {
      ...scenario,
      "use-memory": { ...scenario["use-memory"], expect_stdin: false },
    };
    const result = await runCli(["./tasks.md", "--yes", "--no-memory"], {
      scenario: blind,
    });
    expect(result.code).toBe(0);
    expect(existsSync(result.paths!.memory)).toBe(false);
  });

  it("is what carries a fact across a group boundary", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { group_id: string | null }>;
    };
    // The two read-only probes share one process; the read-write task cannot
    // join them, so what it knows about `npm test` came through memory.
    expect(state.tasks["probe-tests"]?.group_id).toBe("probe-tests");
    expect(state.tasks["probe-docs"]?.group_id).toBe("probe-tests");
    expect(state.tasks["use-memory"]?.group_id).toBeNull();
  });
});

describe("a chain longer than the group cap", () => {
  const ids = [
    "step-one",
    "step-two",
    "step-three",
    "step-four",
    "step-five",
    "step-six",
    "step-seven",
  ];
  const LINEAR = {
    tasks: ids.map((id, index) => ({
      id,
      title: id,
      instruction: `Do ${id}.`,
      provider: "codex",
      model: null,
      depends_on: index === 0 ? [] : [ids[index - 1]],
      access: "read-only",
      cwd: null,
    })),
  };

  const linear = {
    __planner__: { final: LINEAR },
    ...Object.fromEntries(
      ids.map((id) => [
        id,
        {
          emit: [{ line: '{"type":"thread.started","thread_id":"t-1"}' }],
          final: taskResult("ok", { task_id: id, summary: `${id} done.` }),
        },
      ]),
    ),
  };

  it("collapses a chain into as few processes as the cap allows", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario: linear });
    expect(result.code).toBe(0);
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { group_id: string | null }>;
    };
    // The chain packs `DEFAULT_GROUP_SIZE` tasks at a time, so seven tasks
    // cost ceil(7 / cap) spawns instead of seven. A lone task records no
    // `group_id` — it is its own process.
    const processes = ids.map((id) => state.tasks[id]?.group_id ?? id);
    const distinct = [...new Set(processes)];
    expect(distinct).toHaveLength(Math.ceil(ids.length / DEFAULT_GROUP_SIZE));
    for (const leader of distinct) {
      expect(processes.filter((id) => id === leader).length).toBeLessThanOrEqual(
        DEFAULT_GROUP_SIZE,
      );
    }
  });

  it("groups siblings too, not only chains", async () => {
    const fanout = {
      ...linear,
      __planner__: {
        final: {
          tasks: [
            { ...LINEAR.tasks[0] },
            { ...LINEAR.tasks[1], depends_on: ["step-one"] },
            { ...LINEAR.tasks[2], depends_on: ["step-one"] },
          ],
        },
      },
    };
    const result = await runCli(["./tasks.md", "--yes"], { scenario: fanout });
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { group_id: string | null }>;
    };
    // Two siblings and their parent: one process, where session reuse could
    // only ever have taken one of the two.
    expect(state.tasks["step-two"]?.group_id).toBe("step-one");
    expect(state.tasks["step-three"]?.group_id).toBe("step-one");
  });
});
