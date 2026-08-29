import { existsSync } from "node:fs";
import { readLog, runCli, taskResult } from "../helpers/runCli.js";

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
      // A fan-in, so this task is never a session continuation and therefore
      // always receives memory in its prompt rather than in its transcript.
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

  it("does not fold a fan-in into an upstream's session", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { continued_from: string | null }>;
    };
    expect(state.tasks["use-memory"]?.continued_from).toBeNull();
  });
});

/**
 * `codex exec resume <thread_id>` is still UNVERIFIED (M6.5). The cold retry is
 * what makes shipping session reuse safe before it is settled, so it gets its
 * own case: a CLI that refuses the resume must cost one wasted spawn, not the
 * task.
 */
describe("a continuation the CLI refuses", () => {
  const CHAIN = {
    tasks: [
      {
        id: "first",
        title: "First",
        instruction: "Do the first thing.",
        provider: "codex",
        model: null,
        depends_on: [],
        access: "read-write",
        cwd: null,
      },
      {
        id: "second",
        title: "Second",
        instruction: "Do the second thing.",
        provider: "codex",
        model: null,
        depends_on: ["first"],
        access: "read-write",
        cwd: null,
      },
    ],
  };

  const refusing = {
    __planner__: { final: CHAIN },
    first: {
      emit: [{ line: '{"type":"thread.started","thread_id":"t-1"}' }],
      final: taskResult("ok", { task_id: "first", summary: "First done." }),
    },
    second: {
      // The prompt only says this on a continuation, so this rejects exactly
      // the resumed invocation and accepts the cold retry.
      reject_stdin: "continuing in the same session",
      emit: [{ line: '{"type":"thread.started","thread_id":"t-2"}' }],
      final: taskResult("ok", { task_id: "second", summary: "Second done." }),
    },
  };

  it("falls back to a cold run and still completes the task", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario: refusing });
    expect(result.code).toBe(0);

    const state = result.readJson(result.paths!.state) as {
      totals: Record<string, number>;
      tasks: Record<string, { state: string; continued_from: string | null }>;
    };
    expect(state.totals).toMatchObject({ succeeded: 2, failed: 0 });
    // The continuation was attempted and abandoned, so the record says cold.
    expect(state.tasks["second"]?.continued_from).toBeNull();
  });

  it("says so in the log rather than silently absorbing it", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario: refusing });
    const events = readLog(result.paths!).map((entry) => entry.event);
    expect(events).toContain("task.continue.failed");
  });
});

/**
 * Chain depth. `codex exec resume` keeps the same thread id, so a guard keyed
 * on the session id treated turn 3 as a second claim on turn 1's session and
 * capped every chain at two turns. Measured on a real six-task run before it
 * was keyed on the parent task instead.
 */
describe("a chain longer than two", () => {
  const ids = ["step-one", "step-two", "step-three", "step-four"];
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
          // Every turn reports the same thread id, exactly as codex does.
          emit: [{ line: '{"type":"thread.started","thread_id":"t-1"}' }],
          final: taskResult("ok", { task_id: id, summary: `${id} done.` }),
        },
      ]),
    ),
  };

  it("keeps collapsing past turn two", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario: linear });
    expect(result.code).toBe(0);
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { continued_from: string | null }>;
    };
    expect(state.tasks["step-one"]?.continued_from).toBeNull();
    expect(state.tasks["step-two"]?.continued_from).toBe("step-one");
    expect(state.tasks["step-three"]?.continued_from).toBe("step-two");
    expect(state.tasks["step-four"]?.continued_from).toBe("step-three");
  });

  it("still refuses to let two siblings fork one parent's session", async () => {
    // Spread first, then override: the other way round the linear planner
    // silently won and this asserted nothing.
    const forked = {
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
    const result = await runCli(["./tasks.md", "--yes"], { scenario: forked });
    const state = result.readJson(result.paths!.state) as {
      tasks: Record<string, { continued_from: string | null }>;
    };
    const continued = ["step-two", "step-three"].filter(
      (id) => state.tasks[id]?.continued_from === "step-one",
    );
    expect(continued).toHaveLength(1);
  });
});
