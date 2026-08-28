import { createEventRenderer } from "../../../src/ui/render.js";
import { createTheme } from "../../../src/ui/theme.js";
import type { LogLine } from "../../../src/log/index.js";

const theme = createTheme("never");
const render = createEventRenderer({ theme, width: 80 });
const quietRender = createEventRenderer({ theme, quiet: true, width: 80 });

const line = (event: string, fields: Record<string, unknown> = {}): LogLine => ({
  ts: "2026-08-28T21:52:04.118Z",
  level: "info",
  event,
  run_id: "run-1",
  ...fields,
});

describe("live provider output", () => {
  it("prefixes assistant prose with the task id — attribution is mandatory", () => {
    const out = render(
      line("provider.text", { task_id: "gen-schema", text: "adding the FK" }),
    );
    expect(out).toContain("gen-schema");
    expect(out).toContain("adding the FK");
  });

  it("prefixes every wrapped row, not just the first", () => {
    const out = render(
      line("provider.text", { task_id: "gen-schema", text: "word ".repeat(60) }),
    );
    const rows = (out ?? "").split("\n");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.includes("gen-schema"))).toBe(true);
  });

  it("renders a tool call on one line with its abbreviated input", () => {
    const out = render(
      line("provider.tool", {
        task_id: "gen-schema",
        name: "Read(src/db.ts)",
        input: "",
      }),
    );
    expect(out).toContain("⚒ Read(src/db.ts)");
    expect(out?.split("\n")).toHaveLength(1);
  });

  it("forwards child stderr, where these CLIs put their diagnostics", () => {
    expect(
      render(line("provider.stderr", { task_id: "gen-schema", text: "warn: x" })),
    ).toContain("warn: x");
  });

  it("suppresses all live output under --quiet", () => {
    expect(quietRender(line("provider.text", { task_id: "a", text: "x" }))).toBeNull();
    expect(quietRender(line("provider.tool", { task_id: "a", name: "Read" }))).toBeNull();
    expect(quietRender(line("provider.stderr", { task_id: "a", text: "x" }))).toBeNull();
  });
});

describe("completion lines", () => {
  it("shows the summary's first line, capped at 120 characters", () => {
    const out = render(
      line("task.succeeded", {
        task_id: "gen-schema",
        provider: "codex",
        duration_ms: 8112,
        summary: `${"x".repeat(200)}\nsecond line`,
      }),
    );
    expect(out).toContain("✓");
    expect(out).toContain("8.1s");
    expect(out).not.toContain("second line");
    expect(out?.length).toBeLessThan(200);
  });

  it("marks a failure with its own glyph, not colour alone", () => {
    const out = render(
      line("task.failed", {
        task_id: "build-ui",
        provider: "codex",
        message: "quota exceeded",
      }),
    );
    expect(out).toContain("✗");
    expect(out).toContain("quota exceeded");
  });

  it("names the blocking ancestor on a skip", () => {
    const out = render(
      line("task.skipped", { task_id: "integrate", blocked_by: "build-ui" }),
    );
    expect(out).toContain("⊘");
    expect(out).toContain("depends on build-ui");
  });

  it("shows a parked task's question", () => {
    const out = render(
      line("task.parked", {
        task_id: "deploy",
        provider: "codex",
        question: "which region?",
      }),
    );
    expect(out).toContain("⏸");
    expect(out).toContain("which region?");
  });

  it("suppresses success lines under --quiet but keeps failures", () => {
    expect(
      quietRender(line("task.succeeded", { task_id: "a", summary: "done" })),
    ).toBeNull();
    expect(
      quietRender(line("task.failed", { task_id: "a", message: "boom" })),
    ).not.toBeNull();
  });
});

describe("notes", () => {
  it("prints a warn note immediately, wrapped under its task", () => {
    const out = render(
      line("task.note", {
        task_id: "gen-schema",
        severity: "warn",
        message: "locks users",
      }),
    );
    expect(out).toContain("!");
    expect(out).toContain("locks users");
  });

  it("prints an action_required note immediately, with its own glyph", () => {
    const out = render(
      line("task.note", {
        task_id: "deploy",
        severity: "action_required",
        message: "set SECRET",
      }),
    );
    expect(out).toContain("⚑");
  });

  it("holds an info note for the end-of-run report", () => {
    expect(
      render(
        line("task.note", { task_id: "a", severity: "info", message: "assumed utf8" }),
      ),
    ).toBeNull();
  });

  it("prints warn and action notes even under --quiet", () => {
    expect(
      quietRender(
        line("task.note", { task_id: "a", severity: "warn", message: "risky" }),
      ),
    ).not.toBeNull();
  });
});

describe("noise", () => {
  it("hides session ids at info", () => {
    expect(
      render(line("provider.session", { task_id: "a", session_id: "s-1" })),
    ).toBeNull();
  });

  it("shows them under --verbose, where debug lines reach the terminal", () => {
    const out = render({
      ...line("provider.session", { task_id: "a", session_id: "s-1" }),
      level: "debug",
    });
    expect(out).toContain("provider.session");
  });

  it("warns loudly when the planner fell back", () => {
    expect(render(line("plan.fallback.linear", { reason: "no valid plan" }))).toContain(
      "document order",
    );
  });
});
