import { renderPrompt } from "../../../src/executor/prompt.js";
import { PROTOCOL_VERSION, type TaskRequest } from "../../../src/manifest/index.js";

const request = (context: TaskRequest["context"] = []): TaskRequest => ({
  baya: PROTOCOL_VERSION,
  kind: "task_request",
  run_id: "run-1",
  task: { id: "gen-schema", title: "Generate DB schema", instruction: "Create tables." },
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

  it("tells a continuation it is one, and that the contract still applies", () => {
    const text = renderPrompt(request(), { continuation: { inSession: [] } });
    expect(text).toContain("continuing in the same session");
    expect(text).toContain("NEW task with its own response contract");
  });

  it("points at an upstream the agent produced itself instead of repeating it", () => {
    const text = renderPrompt(request([upstream()]), {
      continuation: { inSession: ["design-api"] },
    });
    expect(text).toContain("You produced this earlier in this session");
    expect(text).not.toContain("<upstream_output>");
    // The paths stay: they cost ~nothing and the agent may still want the file.
    expect(text).toContain("/work/.baya/runs/r/tasks/design-api/output.md");
  });

  it("still inlines an upstream from outside the session", () => {
    const text = renderPrompt(request([upstream()]), {
      continuation: { inSession: ["something-else"] },
    });
    expect(text).toContain("<upstream_output>");
  });
});
