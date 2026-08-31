import {
  checkTaskText,
  linearFallback,
  plan,
  parsePlanDraft,
  splitSections,
} from "../../../src/planner/index.js";
import { validateManifest } from "../../../src/manifest/index.js";
import { captureLogger } from "../../helpers/logger.js";

const source = { path: "tasks.md", sha256: "abc" };

const draft = (tasks: unknown[]) => JSON.stringify({ tasks });

const validDraft = draft([
  { id: "a", title: "A", instruction: "do a", depends_on: [] },
  { id: "b", title: "B", instruction: "do b", depends_on: ["a"] },
]);

const cycleDraft = draft([
  { id: "a", title: "A", instruction: "do a", depends_on: ["b"] },
  { id: "b", title: "B", instruction: "do b", depends_on: ["a"] },
]);

const danglingDraft = draft([
  { id: "a", title: "A", instruction: "do a", depends_on: ["ghost"] },
]);

function scripted(responses: string[]): {
  runner: (prompt: string, attempt: number) => Promise<string>;
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    prompts,
    runner: (prompt, attempt) => {
      prompts.push(prompt);
      return Promise.resolve(responses[attempt] ?? responses[responses.length - 1] ?? "");
    },
  };
}

const options = (runner: (p: string, a: number) => Promise<string>) => ({
  taskText: "# One\n\ndo a\n\n# Two\n\ndo b\n",
  source,
  runner,
  logger: captureLogger().logger,
  providers: ["codex"] as const,
  defaultProvider: "codex" as const,
  schemaPath: "/abs/plan.schema.json",
});

describe("parsePlanDraft", () => {
  it("parses a bare JSON object", () => {
    expect(parsePlanDraft('{"tasks":[]}')).toEqual({ tasks: [] });
  });

  it("extracts the last fenced json block", () => {
    const raw = 'Here you go:\n```json\n{"tasks":[{"id":"a"}]}\n```\nHope that helps.';
    expect(parsePlanDraft(raw)).toEqual({ tasks: [{ id: "a" }] });
  });

  it("returns null on garbage rather than guessing", () => {
    expect(parsePlanDraft("I could not do that.")).toBeNull();
  });
});

describe("plan", () => {
  it("accepts a valid plan on the first attempt", async () => {
    const { runner, prompts } = scripted([validDraft]);
    const result = await plan(options(runner));
    expect(result.origin).toBe("planner");
    expect(result.attempts).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(result.manifest.tasks.map((task) => task.id)).toEqual(["a", "b"]);
  });

  it("repairs through cycle, then dangling dep, then a valid plan", async () => {
    const { runner, prompts } = scripted([cycleDraft, danglingDraft, validDraft]);
    const captured = captureLogger();
    const result = await plan({ ...options(runner), logger: captured.logger });

    expect(result.origin).toBe("planner");
    expect(result.attempts).toBe(3);
    // The repair prompt quotes the concrete failure, not "the plan was invalid".
    expect(prompts[1]).toContain("dependency cycle: ");
    expect(prompts[2]).toContain('depends on unknown task "ghost"');
    expect(
      captured.events.filter((event) => event === "plan.repair.attempted"),
    ).toHaveLength(2);
  });

  it("falls back to a linear chain after three garbage responses, and warns", async () => {
    const { runner } = scripted(["nonsense", "still nonsense", "nope"]);
    const captured = captureLogger();
    const result = await plan({ ...options(runner), logger: captured.logger });

    expect(result.origin).toBe("fallback");
    expect(result.attempts).toBe(3);
    expect(result.warnings[0]).toContain("falling back to a linear chain");
    expect(captured.events).toContain("plan.fallback.linear");
    expect(result.manifest.tasks.map((task) => task.id)).toEqual(["one", "two"]);
  });

  it("never aborts: the fallback manifest is itself valid", async () => {
    const { runner } = scripted(["nonsense"]);
    const result = await plan(options(runner));
    expect(validateManifest(result.manifest, { allowlist: ["codex"] }).ok).toBe(true);
  });

  it("treats an empty task list as a failed plan, not a successful empty run", async () => {
    const { runner } = scripted([draft([])]);
    const result = await plan(options(runner));
    expect(result.origin).toBe("fallback");
  });
});

describe("splitSections", () => {
  it("splits on the shallowest heading level", () => {
    expect(splitSections("# A\n\ntext a\n\n# B\n\ntext b").map((s) => s.title)).toEqual([
      "A",
      "B",
    ]);
  });

  it("ignores deeper headings nested under a top-level one", () => {
    const sections = splitSections("# A\n\n## detail\n\n# B\n");
    expect(sections.map((s) => s.title)).toEqual(["A", "B"]);
    expect(sections[0]?.body).toContain("## detail");
  });

  it("falls back to top-level list items when there is one heading", () => {
    expect(
      splitSections("# Tasks\n\n- first thing\n- second thing\n").map((s) => s.title),
    ).toEqual(["first thing", "second thing"]);
  });

  it("treats an unstructured document as a single task", () => {
    expect(splitSections("just do the thing")).toHaveLength(1);
  });
});

describe("linearFallback", () => {
  it("plans nothing for a section the list already marks done", () => {
    // The fallback has no model to read the marker for it, so a planner outage
    // must not silently re-run — and re-pay for — finished work.
    const manifest = linearFallback("# A — done\n\na\n\n# B\n\nb", source);
    expect(manifest.tasks.map((task) => task.title)).toEqual(["B"]);
  });

  it("chains every task to the one before it, in document order", () => {
    const manifest = linearFallback("# A\n\na\n\n# B\n\nb\n\n# C\n\nc", source);
    expect(manifest.tasks.map((task) => [task.id, task.depends_on])).toEqual([
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
    ]);
  });

  it("de-duplicates ids from repeated headings", () => {
    const manifest = linearFallback("# Tests\n\na\n\n# Tests\n\nb", source);
    expect(manifest.tasks.map((task) => task.id)).toEqual(["tests", "tests-2"]);
  });

  it("produces valid ids from headings that slugify to nothing", () => {
    const manifest = linearFallback("# ???\n\na\n\n# !!!\n\nb", source);
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it("is deterministic", () => {
    const taskText = "# A\n\na\n\n# B\n\nb";
    expect(linearFallback(taskText, source)).toEqual(linearFallback(taskText, source));
  });
});

describe("splitSections — non-Markdown inputs", () => {
  it("splits a plain-text file on enumerated lines", () => {
    const txt = "1 design the api\n2 build the ui\n3 write the tests\n";
    expect(splitSections(txt).map((s) => s.title)).toEqual([
      "design the api",
      "build the ui",
      "write the tests",
    ]);
  });

  it("splits an unmarked file on blank lines", () => {
    const txt =
      "Design the orders API.\n\nGenerate the schema from it.\n\nBuild the table.";
    expect(splitSections(txt)).toHaveLength(3);
  });

  it("splits a YAML-ish list", () => {
    const yaml = "tasks:\n  - design the api\n  - build the ui\n";
    expect(splitSections(yaml).map((s) => s.title)).toEqual([
      "design the api",
      "build the ui",
    ]);
  });

  it("still treats a single paragraph as one task", () => {
    expect(splitSections("just do the thing, then ship it")).toHaveLength(1);
  });
});

describe("checkTaskText", () => {
  it("passes usable text", () => {
    expect(checkTaskText("- do a thing\n", "tasks.txt")).toBeNull();
  });

  it("rejects an empty file", () => {
    expect(checkTaskText("   \n", "tasks.txt")).toContain("empty");
  });

  it("rejects a binary file", () => {
    expect(checkTaskText("PK\u0003\u0004", "archive.zip")).toContain(
      "does not look like a text file",
    );
  });
});
