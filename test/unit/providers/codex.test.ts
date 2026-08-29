import { codexAdapter } from "../../../src/providers/index.js";
import {
  PROTOCOL_VERSION,
  type Task,
  type TaskRequest,
} from "../../../src/manifest/index.js";

const ESC = String.fromCharCode(27);

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "gen-schema",
  title: "Generate DB schema",
  instruction: "Create the tables.",
  provider: "codex",
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
  bin: "/usr/local/bin/codex",
  task: task(),
  request,
  model: null,
  cwd: "/work",
  schemaPath: "/work/.baya/schema/task_result.schema.json",
  schemaContents: '{"type":"object"}',
  resultFile: "/work/.baya/runs/r1/tasks/gen-schema/result.json",
  prompt: "do the thing",
  ...overrides,
});

describe("codexAdapter.buildRun argv", () => {
  it("matches the recorded surface", () => {
    expect(codexAdapter.buildRun(input()).argv).toMatchSnapshot();
  });

  it("uses the workspace-write sandbox only for read-write access", () => {
    expect(
      codexAdapter.buildRun(input({ task: task({ access: "read-write" }) })).argv,
    ).toMatchSnapshot();
  });

  it("passes -m only when a model is set — model ids are never hard-coded", () => {
    expect(codexAdapter.buildRun(input()).argv).not.toContain("-m");
    expect(codexAdapter.buildRun(input({ model: "some-model" })).argv).toContain("-m");
  });

  it("escalates to danger-full-access only under --dangerously-allow-all", () => {
    const argv = codexAdapter.buildRun(input({ dangerouslyAllowAll: true })).argv;
    expect(argv[argv.indexOf("-s") + 1]).toBe("danger-full-access");
  });

  it("never uses -p for the prompt: for codex, -p is --profile", () => {
    const argv = codexAdapter.buildRun(input()).argv;
    expect(argv).not.toContain("-p");
    expect(argv).not.toContain("--profile");
    // The prompt travels by stdin behind the `-` positional, never in argv.
    expect(argv).not.toContain("do the thing");
    expect(argv[argv.length - 1]).toBe("-");
  });

  it("delivers the prompt on stdin and never inherits it", () => {
    const plan = codexAdapter.buildRun(input());
    expect(plan.stdin).toBe("pipe");
    expect(plan.stdinData).toBe("do the thing");
  });

  it("builds a resume around the captured thread id", () => {
    expect(
      codexAdapter.buildResume("thread-42", "use postgres", input()).argv,
    ).toMatchSnapshot();
  });
});

describe("codexAdapter.parseEvents", () => {
  it("maps thread.started onto the session id that resume needs", () => {
    expect(
      codexAdapter.parseEvents('{"type":"thread.started","thread_id":"t-9"}'),
    ).toEqual([{ t: "session", id: "t-9" }]);
  });

  it("maps an agent_message item onto text", () => {
    expect(
      codexAdapter.parseEvents(
        '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}',
      ),
    ).toEqual([{ t: "text", text: "hi" }]);
  });

  it("maps other completed items onto tool events with a readable name", () => {
    const [event] = codexAdapter.parseEvents(
      '{"type":"item.completed","item":{"type":"file_change","path":"a.sql"}}',
    );
    expect(event).toMatchObject({ t: "tool", name: "Edit(a.sql)" });
  });

  it("names every path in a file_change — the field is `changes`, not `path`", () => {
    // The real shape. Reading `path` produced a bare `Edit()` for every file
    // change codex has ever reported.
    const [event] = codexAdapter.parseEvents(
      '{"type":"item.completed","item":{"type":"file_change","changes":' +
        '[{"path":"/repo/src/a.ts","kind":"update"},{"path":"/repo/t/a.test.ts","kind":"add"}],' +
        '"status":"completed"}}',
    );
    expect(event).toMatchObject({
      t: "tool",
      name: "Edit(/repo/src/a.ts, /repo/t/a.test.ts)",
    });
  });

  it("surfaces a completed `error` item as a full error event, not an abbreviated tool", () => {
    const message =
      "Model metadata for `gpt-5-mini` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
    expect(
      codexAdapter.parseEvents(
        `{"type":"item.completed","item":{"id":"item_0","type":"error","message":${JSON.stringify(message)}}}`,
      ),
    ).toEqual([{ t: "error", kind: "other", message }]);
  });

  it("keeps an unrecognized type as unknown rather than dropping it", () => {
    expect(codexAdapter.parseEvents('{"type":"turn.started"}')).toEqual([
      { t: "unknown", raw: '{"type":"turn.started"}' },
    ]);
  });

  it("keeps a non-JSON line as unknown", () => {
    expect(codexAdapter.parseEvents("not json at all")).toEqual([
      { t: "unknown", raw: "not json at all" },
    ]);
  });

  it("strips ANSI before parsing, since provider output is untrusted", () => {
    const line = `${ESC}[32m{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}${ESC}[0m`;
    expect(codexAdapter.parseEvents(line)).toEqual([{ t: "text", text: "hi" }]);
  });

  it("classifies a rate-limit error event", () => {
    expect(
      codexAdapter.parseEvents('{"type":"error","message":"rate limit exceeded"}'),
    ).toEqual([{ t: "error", kind: "rate_limit", message: "rate limit exceeded" }]);
  });
});

describe("codexAdapter.extractResult", () => {
  const ok = JSON.stringify({
    baya: PROTOCOL_VERSION,
    kind: "task_result",
    task_id: "gen-schema",
    status: "ok",
    summary: "done",
  });

  it("reads the schema-enforced file — rung 1, no parsing", () => {
    const result = codexAdapter.extractResult({
      taskId: "gen-schema",
      events: [],
      resultFileContents: ok,
      exitCode: 0,
      stderr: "",
    });
    expect(result.status).toBe("ok");
    expect(result.notes).toEqual([]);
  });

  it("overrides a mismatched task_id so a result cannot be misrouted", () => {
    const result = codexAdapter.extractResult({
      taskId: "gen-schema",
      events: [],
      resultFileContents: ok.replace("gen-schema", "some-other-task"),
      exitCode: 0,
      stderr: "",
    });
    expect(result.task_id).toBe("gen-schema");
  });

  it("synthesizes a failure when no result file was written", () => {
    const result = codexAdapter.extractResult({
      taskId: "gen-schema",
      events: [],
      resultFileContents: null,
      exitCode: 1,
      stderr: "boom",
    });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("no result file");
  });

  it("prefers a classified error event over the raw stderr tail", () => {
    const result = codexAdapter.extractResult({
      taskId: "gen-schema",
      events: [{ t: "error", kind: "auth", message: "unauthorized" }],
      resultFileContents: null,
      exitCode: 1,
      stderr: "noise",
    });
    expect(result.error).toEqual({ message: "unauthorized", retryable: false });
  });

  it("reports the last error, past a non-fatal diagnostic that came first", () => {
    const result = codexAdapter.extractResult({
      taskId: "gen-schema",
      events: [
        { t: "error", kind: "other", message: "Model metadata for `x` not found." },
        { t: "error", kind: "auth", message: "unauthorized" },
      ],
      resultFileContents: null,
      exitCode: 1,
      stderr: "noise",
    });
    expect(result.error).toEqual({ message: "unauthorized", retryable: false });
  });
});

describe("codexAdapter.extractUsage", () => {
  it("recovers usage from the turn.completed line kept as unknown", () => {
    const events = codexAdapter.parseEvents(
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}',
    );
    expect(codexAdapter.extractUsage?.(events)).toEqual({
      input_tokens: 10,
      output_tokens: 4,
    });
  });

  it("sums usage across turns when a task was resumed", () => {
    const events = codexAdapter.parseEvents(
      [
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}',
        '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":2}}',
      ].join("\n"),
    );
    expect(codexAdapter.extractUsage?.(events)).toEqual({
      input_tokens: 17,
      output_tokens: 6,
    });
  });

  it("returns nothing when codex emitted no usage line", () => {
    const events = codexAdapter.parseEvents('{"type":"turn.started"}');
    expect(codexAdapter.extractUsage?.(events)).toEqual({});
  });
});

describe("codex observations", () => {
  const ctx = (events: ReturnType<typeof codexAdapter.parseEvents>) => ({
    taskId: "t1",
    events,
    resultFileContents: null,
    exitCode: 0,
    stderr: "",
    transcript: null,
  });

  it("reads commands and their exit status straight out of the event stream", () => {
    const events = codexAdapter.parseEvents(
      '{"type":"item.completed","item":{"type":"command_execution","command":' +
        '"/bin/zsh -lc \'npm test\'","exit_code":"1","status":"failed"}}\n' +
        '{"type":"item.completed","item":{"type":"command_execution","command":' +
        '"/bin/zsh -lc \'npm run lint\'","exit_code":"0","status":"completed"}}',
    );
    expect(codexAdapter.extractObservations?.(ctx(events))).toEqual([
      { kind: "command", command: "/bin/zsh -lc 'npm test'", ok: false },
      { kind: "command", command: "/bin/zsh -lc 'npm run lint'", ok: true },
    ]);
  });

  it("reports every changed path, which the `path` bug used to swallow", () => {
    const events = codexAdapter.parseEvents(
      '{"type":"item.completed","item":{"type":"file_change","changes":' +
        '[{"path":"src/a.ts","kind":"update"}],"status":"completed"}}',
    );
    expect(codexAdapter.extractObservations?.(ctx(events))).toEqual([
      { kind: "write", path: "src/a.ts" },
    ]);
  });

  it("reads its observations from its own events, needing no sidecar", () => {
    expect(codexAdapter.capabilities.observations).toBe("events");
    expect(codexAdapter.transcriptPath).toBeUndefined();
  });
});

describe("codex session continuation", () => {
  it("continues a thread with the next task_request on stdin", () => {
    const plan = codexAdapter.buildContinue?.("thread-9", input());
    expect(plan?.argv).toEqual([
      "/usr/local/bin/codex",
      "exec",
      "resume",
      "thread-9",
      ...codexAdapter.buildRun(input()).argv.slice(2),
    ]);
    expect(plan?.stdinData).toBe(input().prompt);
  });
});
