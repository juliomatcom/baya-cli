import { claudeAdapter } from "../../../src/providers/index.js";
import {
  PROTOCOL_VERSION,
  type Task,
  type TaskRequest,
} from "../../../src/manifest/index.js";

const ESC = String.fromCharCode(27);

const SCHEMA = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { status: { type: "string" } },
});

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "gen-schema",
  title: "Generate DB schema",
  instruction: "Create the tables.",
  provider: "claude",
  model: null,
  depends_on: [],
  access: "read-only",
  cwd: null,
  ...overrides,
});

const request: TaskRequest = {
  baya: PROTOCOL_VERSION,
  kind: "task_request",
  run_id: "run-1",
  task: { id: "gen-schema", title: "t", instruction: "i" },
  workspace: { cwd: "/work", access: "read-only", isolation: "shared" },
  context: [],
  response_contract: { schema_path: "/work/.baya/schema/task_result.schema.json" },
  constraints: { max_runtime_s: 900 },
};

const input = (overrides = {}) => ({
  bin: "/usr/local/bin/claude",
  task: task(),
  request,
  model: null as string | null,
  cwd: "/work",
  schemaPath: "/work/.baya/schema/task_result.schema.json",
  schemaContents: SCHEMA,
  resultFile: "/work/.baya/runs/r1/tasks/gen-schema/result.json",
  prompt: "do the thing",
  ...overrides,
});

const claudeBlob = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "sess-123",
    result: "all done",
    total_cost_usd: 0.042,
    usage: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  });

const conformingResult = JSON.stringify({
  baya: PROTOCOL_VERSION,
  kind: "task_result",
  task_id: "gen-schema",
  status: "ok",
  summary: "created 4 tables",
});

describe("claudeAdapter.buildRun argv", () => {
  it("matches the recorded surface", () => {
    expect(claudeAdapter.buildRun(input()).argv).toMatchSnapshot();
  });

  // The two regressions this pins: `acceptEdits` pre-approves edits only and
  // `plan` refuses every non-readonly tool, so under `-p` — with nobody to
  // answer a prompt — both had Bash denied outright.
  it("uses auto at either access level", () => {
    const ro = claudeAdapter.buildRun(input()).argv;
    expect(ro[ro.indexOf("--permission-mode") + 1]).toBe("auto");
    const rw = claudeAdapter.buildRun(
      input({ task: task({ access: "read-write" }) }),
    ).argv;
    expect(rw[rw.indexOf("--permission-mode") + 1]).toBe("auto");
    expect([...ro, ...rw]).not.toContain("acceptEdits");
    expect([...ro, ...rw]).not.toContain("plan");
  });

  // `access: "read-only"` bounds what a task may mutate, not whether it may act: a
  // task that runs the suite and reports back needs Bash and writes nothing.
  it("withholds the editing tools from a read-only task, but never Bash", () => {
    const argv = claudeAdapter.buildRun(input()).argv;
    const denied = argv[argv.indexOf("--disallowed-tools") + 1] as string;
    expect(denied.split(",")).toEqual(["Write", "Edit", "NotebookEdit"]);
    expect(denied).not.toContain("Bash");
  });

  it("withholds nothing from a writing task", () => {
    const argv = claudeAdapter.buildRun(
      input({ task: task({ access: "read-write" }) }),
    ).argv;
    expect(argv).not.toContain("--disallowed-tools");
  });

  it("withholds nothing under --dangerously-allow-all, even read-only", () => {
    const argv = claudeAdapter.buildRun(input({ dangerouslyAllowAll: true })).argv;
    expect(argv).not.toContain("--disallowed-tools");
  });

  it("escalates to bypassPermissions under --dangerously-allow-all", () => {
    const argv = claudeAdapter.buildRun(input({ dangerouslyAllowAll: true })).argv;
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  it("passes --model only when a model is set", () => {
    expect(claudeAdapter.buildRun(input()).argv).not.toContain("--model");
    expect(claudeAdapter.buildRun(input({ model: "opus" })).argv).toContain("--model");
  });

  it("passes --session-id only when one was pre-assigned", () => {
    expect(claudeAdapter.buildRun(input()).argv).not.toContain("--session-id");
    const argv = claudeAdapter.buildRun(input({ sessionId: "uuid-1" })).argv;
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("uuid-1");
  });

  it("never passes a file path to --json-schema — it must be inline JSON", () => {
    const argv = claudeAdapter.buildRun(input()).argv;
    const value = argv[argv.indexOf("--json-schema") + 1] as string;
    // The value is the schema document, not the path that names it.
    expect(value).not.toBe("/work/.baya/schema/task_result.schema.json");
    expect(argv).not.toContain("/work/.baya/schema/task_result.schema.json");
    expect(JSON.parse(value)).toMatchObject({ type: "object" });
    // claude's validator cannot resolve the 2020-12 meta-schema ref.
    expect(JSON.parse(value)).not.toHaveProperty("$schema");
  });

  it("delivers the prompt on stdin, never argv, never inherited", () => {
    const plan = claudeAdapter.buildRun(input());
    expect(plan.stdin).toBe("pipe");
    expect(plan.stdinData).toBe("do the thing");
    expect(plan.argv).not.toContain("do the thing");
  });

  it("sets cwd on the spawn — claude has no working-directory flag", () => {
    const plan = claudeAdapter.buildRun(input({ cwd: "/somewhere/else" }));
    expect(plan.cwd).toBe("/somewhere/else");
    expect(plan.argv).not.toContain("-C");
    expect(plan.argv).not.toContain("--cd");
  });

  it("builds a resume around the session id", () => {
    expect(
      claudeAdapter.buildResume("sess-9", "use postgres", input()).argv,
    ).toMatchSnapshot();
  });

  it("never pairs --resume with --session-id, which would create and continue at once", () => {
    const withId = input({ sessionId: "sess-9" });
    expect(claudeAdapter.buildResume("sess-9", "answer", withId).argv).not.toContain(
      "--session-id",
    );
    expect(claudeAdapter.buildContinue?.("sess-9", withId).argv).not.toContain(
      "--session-id",
    );
    // A cold run still pre-assigns it.
    expect(claudeAdapter.buildRun(withId).argv).toContain("--session-id");
  });

  it("continues a chain by sending the next task_request into --resume", () => {
    const plan = claudeAdapter.buildContinue?.("sess-9", input());
    expect(plan?.argv.slice(0, 3)).toEqual([
      "/usr/local/bin/claude",
      "--resume",
      "sess-9",
    ]);
    expect(plan?.stdinData).toBe(input().prompt);
  });
});

describe("claudeAdapter.parseEvents", () => {
  it("maps the result blob onto session + text + final", () => {
    const events = claudeAdapter.parseEvents(claudeBlob());
    expect(events).toContainEqual({ t: "session", id: "sess-123" });
    expect(events).toContainEqual({ t: "text", text: "all done" });
    expect(events.some((e) => e.t === "final")).toBe(true);
  });

  it("maps an errored blob onto an error event, not text", () => {
    const events = claudeAdapter.parseEvents(
      claudeBlob({
        is_error: true,
        subtype: "error_during_execution",
        result: "429 rate limit",
      }),
    );
    expect(events).toContainEqual({
      t: "error",
      kind: "rate_limit",
      message: "429 rate limit",
    });
    expect(events.some((e) => e.t === "text")).toBe(false);
  });

  it("strips ANSI before parsing", () => {
    const events = claudeAdapter.parseEvents(`${ESC}[2m${claudeBlob()}${ESC}[0m`);
    expect(events).toContainEqual({ t: "session", id: "sess-123" });
  });

  it("keeps a non-JSON line as unknown rather than dropping it", () => {
    expect(claudeAdapter.parseEvents("Loading…")).toEqual([
      { t: "unknown", raw: "Loading…" },
    ]);
  });
});

describe("claudeAdapter.extractResult", () => {
  const ctx = (raw: string, over: Partial<Record<string, unknown>> = {}) => ({
    taskId: "gen-schema",
    events: claudeAdapter.parseEvents(raw),
    resultFileContents: null,
    exitCode: 0,
    stderr: "",
    ...over,
  });

  it("rung 1: reads .structured_output when the schema was enforced", () => {
    const result = claudeAdapter.extractResult(
      ctx(claudeBlob({ structured_output: JSON.parse(conformingResult) })),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("created 4 tables");
  });

  it("rungs 2–3: parses a conforming .result string when there is no structured_output", () => {
    const result = claudeAdapter.extractResult(
      ctx(claudeBlob({ result: conformingResult })),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("created 4 tables");
  });

  it("normalizes the task id from structured_output so a result cannot be misrouted", () => {
    const wrong = { ...JSON.parse(conformingResult), task_id: "other" };
    const result = claudeAdapter.extractResult(
      ctx(claudeBlob({ structured_output: wrong })),
    );
    expect(result.task_id).toBe("gen-schema");
  });

  it("warns on a result that parsed despite denials, without failing it", () => {
    const result = claudeAdapter.extractResult(
      ctx(
        claudeBlob({
          structured_output: JSON.parse(conformingResult),
          permission_denials: [
            { tool_name: "Bash" },
            { tool_name: "Bash" },
            { tool_name: "Write" },
          ],
        }),
      ),
    );
    // The work landed, so the task is not a failure — but the denial has to
    // reach the report rather than only the prose summary.
    expect(result.status).toBe("ok");
    const warning = result.notes.find((note) => note.severity === "warn");
    expect(warning?.message).toContain("Bash \u00d72");
    expect(warning?.message).toContain("Write");
  });

  it("leaves a clean result's notes untouched", () => {
    const result = claudeAdapter.extractResult(
      ctx(claudeBlob({ structured_output: JSON.parse(conformingResult) })),
    );
    expect(result.notes).toEqual([]);
  });

  it("reports permission denials as a non-retryable failure", () => {
    const result = claudeAdapter.extractResult(
      ctx(
        claudeBlob({
          result: "blocked",
          permission_denials: [{ tool_name: "Bash" }, { tool_name: "Write" }],
        }),
      ),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toContain("Bash");
  });

  it("turns an is_error blob into a failure, non-retryable on auth", () => {
    const result = claudeAdapter.extractResult(
      ctx(claudeBlob({ is_error: true, result: "invalid api key" })),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.retryable).toBe(false);
  });

  it("synthesizes a failure when claude wrote nothing parseable", () => {
    const result = claudeAdapter.extractResult({
      taskId: "gen-schema",
      events: [],
      resultFileContents: null,
      exitCode: 1,
      stderr: "segfault",
    });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("no parseable result");
  });
});

describe("claudeAdapter.extractUsage", () => {
  it("pulls cost and tokens from the result blob", () => {
    const events = claudeAdapter.parseEvents(claudeBlob());
    expect(claudeAdapter.extractUsage?.(events)).toEqual({
      cost_usd: 0.042,
      input_tokens: 100,
      output_tokens: 20,
    });
  });

  it("folds cache tokens into the input count", () => {
    const events = claudeAdapter.parseEvents(
      claudeBlob({
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
          output_tokens: 20,
        },
      }),
    );
    expect(claudeAdapter.extractUsage?.(events)?.input_tokens).toBe(1050);
  });

  it("returns nothing when there is no final blob", () => {
    expect(claudeAdapter.extractUsage?.([])).toEqual({});
  });
});

describe("claude observations", () => {
  const ctx = (transcript: string | null) => ({
    taskId: "t1",
    events: [],
    resultFileContents: null,
    exitCode: 0,
    stderr: "",
    transcript,
  });

  it("declares the transcript as its source, because its events cannot carry tools", () => {
    expect(claudeAdapter.capabilities.observations).toBe("transcript");
    expect(claudeAdapter.capabilities.events).toBe("json");
    expect(typeof claudeAdapter.transcriptPath).toBe("function");
  });

  it("reads observations out of the transcript it is handed", () => {
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "u1",
              name: "Read",
              input: { file_path: "/repo/a.ts" },
            },
          ],
        },
      }),
    ].join("\n");
    expect(claudeAdapter.extractObservations?.(ctx(transcript))).toEqual([
      { kind: "read", path: "/repo/a.ts" },
    ]);
  });

  it("contributes nothing, and fails nothing, when no transcript was found", () => {
    expect(claudeAdapter.extractObservations?.(ctx(null))).toEqual([]);
  });
});
