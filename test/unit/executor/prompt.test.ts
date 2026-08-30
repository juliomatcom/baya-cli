import { renderGroupPrompt, renderPrompt } from "../../../src/executor/prompt.js";
import { PROTOCOL_VERSION, type TaskRequest } from "../../../src/manifest/index.js";

const request = (
  context: TaskRequest["context"] = [],
  task: TaskRequest["task"] = {
    id: "gen-schema",
    title: "Generate DB schema",
    instruction: "Create tables.",
  },
): TaskRequest => ({
  baya: PROTOCOL_VERSION,
  kind: "task_request",
  run_id: "run-1",
  task,
  workspace: { cwd: "/work", access: "read-write", isolation: "shared" },
  context,
  response_contract: { schema_path: "/work/.baya/schema/task_result.schema.json" },
  constraints: { max_runtime_s: 900 },
});

const upstream = (over: Partial<TaskRequest["context"][number]> = {}) => ({
  task_id: "design-api",
  title: "Design the API",
  status: "ok",
  summary: "Six endpoints.",
  result_path: "/work/.baya/runs/r/tasks/design-api/result.json",
  output_path: "/work/.baya/runs/r/tasks/design-api/output.md",
  inline: "## API",
  ...over,
});

describe("renderPrompt", () => {
  it("omits the memory section entirely when there is nothing to say", () => {
    const text = renderPrompt(request());
    expect(text).not.toContain("# Known about this workspace");
    expect(text).toContain("# Response contract");
  });

  it("places memory with the workspace, not with the upstream results", () => {
    const text = renderPrompt(request([upstream()]), {
      memory: "# Known about this workspace\n\n- Commands that ran clean: `npm test`",
    });
    expect(text.indexOf("# Upstream results")).toBeLessThan(text.indexOf("# Workspace"));
    expect(text.indexOf("# Workspace")).toBeLessThan(
      text.indexOf("# Known about this workspace"),
    );
    expect(text.indexOf("# Known about this workspace")).toBeLessThan(
      text.indexOf("# Response contract"),
    );
  });
});

describe("renderGroupPrompt", () => {
  const second = request([], {
    id: "seed-db",
    title: "Seed the database",
    instruction: "Insert fixtures.",
  });

  it("is byte for byte renderPrompt for a group of one", () => {
    expect(renderGroupPrompt([request()])).toBe(renderPrompt(request()));
  });

  it("states the workspace once and every task's contract separately", () => {
    const text = renderGroupPrompt([request(), second]);
    expect(text.match(/# Workspace/g)).toHaveLength(1);
    expect(text).toContain("# Task 1 of 2: Generate DB schema");
    expect(text).toContain("# Task 2 of 2: Seed the database");
    // The response is one document naming every task, so a result cannot be
    // filed under the wrong id.
    expect(text).toContain("- gen-schema");
    expect(text).toContain("- seed-db");
  });

  it("points at an upstream produced earlier in the group instead of repeating it", () => {
    const withDep = request([upstream({ task_id: "gen-schema", inline: null })], {
      id: "seed-db",
      title: "Seed the database",
      instruction: "Insert fixtures.",
    });
    const text = renderGroupPrompt([request(), withDep]);
    expect(text).toContain("You did this earlier in this same conversation");
    expect(text).not.toContain("<upstream_output>");
    // The paths stay: they cost ~nothing and the agent may still want the file.
    expect(text).toContain("/work/.baya/runs/r/tasks/design-api/output.md");
  });

  it("still inlines an upstream from outside the group", () => {
    const text = renderGroupPrompt([request([upstream()]), second]);
    expect(text).toContain("<upstream_output>");
  });
});
