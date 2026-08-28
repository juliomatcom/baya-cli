import {
  ManifestSchema,
  PROTOCOL_VERSION,
  ProviderEventSchema,
  TaskRequestSchema,
  TaskResultSchema,
  TaskSchema,
  taskResultJsonSchema,
  writeTaskResultSchema,
} from "../../../src/manifest/index.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const minimalTask = {
  id: "gen-schema",
  title: "Generate DB schema",
  instruction: "Create the tables.",
};

describe("TaskSchema", () => {
  it("fills the optional half with defaults so a terse planner still validates", () => {
    const task = TaskSchema.parse(minimalTask);
    expect(task).toEqual({
      ...minimalTask,
      provider: null,
      model: null,
      depends_on: [],
      writes: false,
      cwd: null,
    });
  });

  it("round-trips a fully specified task", () => {
    const full = {
      ...minimalTask,
      provider: "codex" as const,
      model: "some-model",
      depends_on: ["design-api"],
      writes: true,
      cwd: "/tmp/x",
    };
    expect(TaskSchema.parse(TaskSchema.parse(full))).toEqual(full);
  });

  it("rejects an unknown provider — the enum is the privilege boundary", () => {
    expect(TaskSchema.safeParse({ ...minimalTask, provider: "rogue" }).success).toBe(
      false,
    );
  });

  it("rejects extra keys, so argv or env can never ride along in a manifest", () => {
    expect(
      TaskSchema.safeParse({ ...minimalTask, argv: ["rm", "-rf", "/"] }).success,
    ).toBe(false);
  });
});

describe("ManifestSchema", () => {
  it("round-trips", () => {
    const manifest = {
      version: 1 as const,
      source: { path: "tasks.md", sha256: "abc" },
      tasks: [TaskSchema.parse(minimalTask)],
    };
    expect(ManifestSchema.parse(manifest)).toEqual(manifest);
  });
});

describe("TaskRequestSchema", () => {
  it("round-trips a request with one context edge", () => {
    const request = {
      baya: PROTOCOL_VERSION,
      kind: "task_request" as const,
      run_id: "20260828T2152Z-a1f4c9-1",
      task: { id: "gen-schema", title: "t", instruction: "i" },
      workspace: { cwd: "/abs", writable: true, isolation: "shared" as const },
      context: [
        {
          task_id: "design-api",
          title: "Design the API",
          status: "ok",
          summary: "s",
          result_path: "/abs/result.json",
          output_path: "/abs/output.md",
          inline: null,
        },
      ],
      response_contract: { schema_path: "/abs/schema.json" },
      constraints: { max_runtime_s: 900 },
    };
    expect(TaskRequestSchema.parse(request)).toEqual(request);
  });
});

describe("TaskResultSchema", () => {
  const base = { baya: PROTOCOL_VERSION, kind: "task_result" as const, task_id: "t1" };

  it("defaults notes to an empty array — never null", () => {
    const result = TaskResultSchema.parse({ ...base, status: "ok", summary: "done" });
    expect(result.notes).toEqual([]);
    expect(result.notes).not.toBeNull();
  });

  it("rejects a null notes field outright", () => {
    expect(
      TaskResultSchema.safeParse({ ...base, status: "ok", summary: "d", notes: null })
        .success,
    ).toBe(false);
  });

  it.each(["ok", "needs_input", "failed"] as const)(
    "accepts notes on status %s — a failed task often has the most useful ones",
    (status) => {
      const extra =
        status === "needs_input"
          ? { question: { text: "which db?", options: null, default: null } }
          : status === "failed"
            ? { error: { message: "boom", retryable: true } }
            : {};
      const parsed = TaskResultSchema.parse({
        ...base,
        status,
        summary: "s",
        notes: [
          { severity: "info", message: "i" },
          { severity: "warn", message: "w" },
          { severity: "action_required", message: "a" },
        ],
        ...extra,
      });
      expect(parsed.notes).toHaveLength(3);
    },
  );

  it("requires a summary on ok", () => {
    expect(
      TaskResultSchema.safeParse({ ...base, status: "ok", summary: "  " }).success,
    ).toBe(false);
  });

  it("requires question.text on needs_input", () => {
    expect(TaskResultSchema.safeParse({ ...base, status: "needs_input" }).success).toBe(
      false,
    );
  });

  it("requires error on failed", () => {
    expect(TaskResultSchema.safeParse({ ...base, status: "failed" }).success).toBe(false);
  });

  it("round-trips a full result", () => {
    const full = {
      ...base,
      status: "ok" as const,
      summary: "Created 4 tables.",
      output: "## Schema",
      notes: [{ severity: "warn" as const, message: "locks users" }],
      question: null,
      error: null,
      artifacts: [{ path: "m/001.sql", kind: "file", description: null }],
      files_changed: ["m/001.sql"],
    };
    expect(TaskResultSchema.parse(TaskResultSchema.parse(full))).toEqual(full);
  });
});

describe("ProviderEventSchema", () => {
  it.each([
    { t: "session", id: "s-1" },
    { t: "text", text: "working" },
    { t: "tool", name: "Read", input: { path: "a.ts" } },
    { t: "final", raw: "{}" },
    { t: "error", kind: "rate_limit", message: "429" },
    { t: "unknown", raw: "surprise" },
  ])("round-trips $t", (event) => {
    expect(ProviderEventSchema.parse(event)).toEqual(event);
  });
});

describe("task_result.schema.json", () => {
  it("names exactly the keys the zod schema accepts", () => {
    const json = taskResultJsonSchema();
    const properties = Object.keys(json["properties"] as Record<string, unknown>).sort();
    const zodKeys = Object.keys(TaskResultSchema.innerType().shape).sort();
    expect(properties).toEqual(zodKeys);
    // Strict dialect: providers that enforce a schema require every key required.
    expect((json["required"] as string[]).sort()).toEqual(zodKeys);
    expect(json["additionalProperties"]).toBe(false);
  });

  it("is emitted to disk atomically and parses as JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "baya-schema-"));
    const path = writeTaskResultSchema(dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(taskResultJsonSchema());
  });
});
