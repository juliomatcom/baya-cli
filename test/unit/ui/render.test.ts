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

describe("startup", () => {
  it("names the agent and model before anything runs", () => {
    const out = render(
      line("run.agent", {
        provider: "codex",
        model: "gpt-5-codex",
        planner_provider: "codex",
        planner_model: "gpt-5-codex",
      }),
    );
    expect(out).toContain("agent");
    expect(out).toContain("codex");
    expect(out).toContain("gpt-5-codex");
  });

  it("says (provider default) when no model is pinned", () => {
    const out = render(line("run.agent", { provider: "codex", model: "" }));
    expect(out).toContain("(provider default)");
  });

  it("announces each task as it spawns, with its provider and model", () => {
    const out = render(
      line("task.spawned", {
        task_id: "gen-schema",
        provider: "codex",
        model: "gpt-5-codex",
      }),
    );
    expect(out).toContain("gen-schema");
    expect(out).toContain("codex");
    expect(out).toContain("gpt-5-codex");
  });

  it("shows the exact provider command, flags and all, prompt collapsed", () => {
    const prompt = "You are executing one task in a Baya run. ".repeat(10);
    const out = render(
      line("task.spawned", {
        task_id: "gen-schema",
        provider: "copilot",
        model: "gpt-5.6-luna",
        prompt_bytes: Buffer.byteLength(prompt),
        argv: [
          "copilot",
          "-p",
          prompt,
          "--output-format",
          "json",
          "--model",
          "gpt-5.6-luna",
        ],
      }),
    );
    expect(out).toContain("$ copilot -p <prompt> --output-format json");
    expect(out).toContain("--model gpt-5.6-luna");
    expect(out).not.toContain("You are executing");
  });

  it("has no command line when argv is absent", () => {
    const out = render(
      line("task.spawned", { task_id: "t", provider: "codex", model: "m" }),
    );
    expect(out).not.toContain("$ ");
  });
});

describe("attribution column", () => {
  it("shows an over-long task id in full rather than cutting it", () => {
    const out = render(
      line("provider.text", {
        task_id: "create-number-generator-with-a-very-long-name",
        text: "hi",
      }),
    );
    expect(out).not.toContain("…");
    expect(out).toContain("create-number-generator-with-a-very-long-name");
  });
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

  it("shows a provider error in full, wrapped and never truncated", () => {
    const message =
      "Model metadata for gpt-5-mini not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
    const out = render(
      line("provider.error", { task_id: "gen-schema", provider: "codex", message }),
    );
    expect(out).not.toContain("…");
    const rows = (out ?? "").split("\n");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.includes("gen-schema"))).toBe(true);
    const reassembled = rows
      .map((row) => row.replace(/^.*│ /, "").replace(/^! /, ""))
      .join(" ");
    expect(reassembled).toContain(message);
  });

  it("keeps a provider error visible even under --quiet", () => {
    expect(
      quietRender(line("provider.error", { task_id: "a", message: "boom" })),
    ).toContain("boom");
  });

  it("suppresses all live output under --quiet", () => {
    expect(quietRender(line("provider.text", { task_id: "a", text: "x" }))).toBeNull();
    expect(quietRender(line("provider.tool", { task_id: "a", name: "Read" }))).toBeNull();
    expect(quietRender(line("provider.stderr", { task_id: "a", text: "x" }))).toBeNull();
  });
});

describe("completion lines", () => {
  it("shows the summary's first line in full, without the rest and without cutting", () => {
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
    expect(out).not.toContain("…");
    expect(out).toContain("x".repeat(200));
  });

  it("shows the token meter on a success line when the provider reported usage", () => {
    const out = render(
      line("task.succeeded", {
        task_id: "gen-schema",
        provider: "codex",
        duration_ms: 8112,
        summary: "done",
        input_tokens: 122_271,
        output_tokens: 1570,
      }),
    );
    expect(out).toContain("124k tok");
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

  /**
   * `--quiet` drops narration, not outcomes. Failures, parks and skips were
   * never suppressed here, so hiding only successes left a quiet run showing
   * every bad result and no good one.
   */
  it("keeps every outcome under --quiet, and drops the narration around them", () => {
    for (const outcome of [
      line("task.succeeded", { task_id: "a", summary: "done" }),
      line("task.failed", { task_id: "a", message: "boom" }),
      line("task.parked", { task_id: "a", question: "which db?" }),
      line("task.skipped", { task_id: "a", blocked_by: "b" }),
    ]) {
      expect({ event: outcome.event, shown: quietRender(outcome) !== null }).toEqual({
        event: outcome.event,
        shown: true,
      });
    }

    for (const chatter of [
      line("provider.text", { task_id: "a", text: "thinking" }),
      line("provider.tool", { task_id: "a", name: "Read" }),
      line("provider.stderr", { task_id: "a", text: "warming up" }),
      line("task.spawned", { task_id: "a", provider: "codex" }),
    ]) {
      expect({ event: chatter.event, shown: quietRender(chatter) !== null }).toEqual({
        event: chatter.event,
        shown: false,
      });
    }
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
