import {
  deriveMemory,
  isCapabilityCommand,
  normalizeCommand,
  normalizePath,
  pathsIn,
} from "../../../src/memory/index.js";
import type { TaskObservations } from "../../../src/memory/index.js";

const CWD = "/repo";

describe("normalizeCommand", () => {
  it("unwraps the login shell codex wraps every command in", () => {
    expect(normalizeCommand(`/bin/zsh -lc 'npm run typecheck'`)).toBe(
      "npm run typecheck",
    );
    expect(normalizeCommand(`/bin/bash -lc "npm test"`)).toBe("npm test");
  });

  it("leaves a bare command — claude's shape — untouched", () => {
    expect(normalizeCommand("npm run lint")).toBe("npm run lint");
  });

  it("collapses whitespace so the two providers' spellings dedupe", () => {
    expect(normalizeCommand(`/bin/zsh -lc 'npm   run\n lint'`)).toBe("npm run lint");
  });
});

describe("isCapabilityCommand", () => {
  it.each(["npm test", "npx tsc --noEmit", "make build", "pytest -q"])(
    "keeps %s, whose exit code is the fact",
    (command) => {
      expect(isCapabilityCommand(command)).toBe(true);
    },
  );

  it.each([
    "sed -n '1,20p' a.ts",
    "rg foo",
    "ls src",
    "git status --short",
    "env | rg TMPDIR",
    "ps -A -o pid=",
  ])("drops %s, where a non-zero exit means nothing", (command) => {
    expect(isCapabilityCommand(command)).toBe(false);
  });
});

describe("pathsIn", () => {
  it("digs paths out of an exploration command, which is codex's only signal", () => {
    expect(pathsIn(`sed -n '1,220p' wiki-llm/index.md`)).toEqual(["wiki-llm/index.md"]);
    expect(pathsIn("cat package.json src/cli/args.ts")).toEqual([
      "package.json",
      "src/cli/args.ts",
    ]);
  });

  it("does not mistake a version string for a file", () => {
    expect(pathsIn("codex -m gpt-5.6-luna")).toEqual([]);
    expect(pathsIn("sed -n '1,220p'")).toEqual([]);
  });

  it("does not mistake a property access for a file", () => {
    // Measured: `console.log` was reported as a file earlier tasks needed.
    expect(pathsIn("node -e 'console.log(1)'")).toEqual([]);
    expect(pathsIn("rg Object.keys src/a.ts")).toEqual(["src/a.ts"]);
  });
});

describe("normalizePath", () => {
  it("makes workspace-absolute paths repo-relative", () => {
    expect(normalizePath("/repo/src/a.ts", CWD)).toBe("src/a.ts");
    expect(normalizePath("./src/a.ts", CWD)).toBe("src/a.ts");
  });

  it("drops anything outside the workspace — another machine's path is noise", () => {
    expect(normalizePath("/elsewhere/b.ts", CWD)).toBeNull();
  });

  it("drops Baya's own artifacts and vendored trees", () => {
    expect(normalizePath(".baya/runs/x/state.json", CWD)).toBeNull();
    expect(normalizePath("node_modules/zod/index.js", CWD)).toBeNull();
  });
});

function observed(entries: TaskObservations[]): TaskObservations[] {
  return entries;
}

describe("deriveMemory", () => {
  it("reports a capability command that only ever failed as a dead end", () => {
    const entries = deriveMemory(
      observed([
        {
          taskId: "t1",
          observations: [{ kind: "command", command: "npm test", ok: false }],
        },
      ]),
      { cwd: CWD },
    );
    expect(entries).toContainEqual({
      kind: "command.deadend",
      key: "command:npm test",
      value: "npm test",
      sources: ["t1"],
    });
  });

  it("does NOT call it a dead end once some task got it working", () => {
    const entries = deriveMemory(
      observed([
        {
          taskId: "t1",
          observations: [{ kind: "command", command: "npm test", ok: false }],
        },
        {
          taskId: "t2",
          observations: [{ kind: "command", command: "npm test", ok: true }],
        },
      ]),
      { cwd: CWD },
    );
    expect(entries.filter((entry) => entry.kind === "command.deadend")).toEqual([]);
    expect(entries.map((entry) => entry.kind)).toContain("command.verified");
  });

  it("dedupes the same command seen through both providers' spellings", () => {
    const entries = deriveMemory(
      observed([
        {
          taskId: "t1",
          observations: [
            { kind: "command", command: `/bin/zsh -lc 'npm run lint'`, ok: true },
          ],
        },
        {
          taskId: "t2",
          observations: [{ kind: "command", command: "npm run lint", ok: true }],
        },
      ]),
      { cwd: CWD },
    );
    const verified = entries.filter((entry) => entry.kind === "command.verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]?.sources.sort()).toEqual(["t1", "t2"]);
  });

  it("keeps a file read by several tasks and ignores one read by a single task", () => {
    const entries = deriveMemory(
      observed([
        { taskId: "t1", observations: [{ kind: "read", path: "/repo/docs/index.md" }] },
        { taskId: "t2", observations: [{ kind: "read", path: "docs/index.md" }] },
        { taskId: "t3", observations: [{ kind: "read", path: "docs/lonely.md" }] },
      ]),
      { cwd: CWD },
    );
    const hot = entries.filter((entry) => entry.kind === "file.hot").map((e) => e.value);
    expect(hot).toEqual(["docs/index.md"]);
  });

  it("reports a modified file as changed rather than merely popular", () => {
    const entries = deriveMemory(
      observed([
        { taskId: "t1", observations: [{ kind: "read", path: "src/a.ts" }] },
        { taskId: "t2", observations: [{ kind: "read", path: "src/a.ts" }] },
        { taskId: "t3", observations: [{ kind: "write", path: "src/a.ts" }] },
      ]),
      { cwd: CWD },
    );
    const kinds = entries.filter((e) => e.value === "src/a.ts").map((e) => e.kind);
    expect(kinds).toEqual(["file.changed"]);
  });

  it("mines read paths out of exploration commands", () => {
    const entries = deriveMemory(
      observed([
        {
          taskId: "t1",
          observations: [
            {
              kind: "command",
              command: `/bin/zsh -lc 'sed -n '1,20p' docs/a.md'`,
              ok: true,
            },
          ],
        },
        {
          taskId: "t2",
          observations: [{ kind: "command", command: "cat docs/a.md", ok: true }],
        },
      ]),
      { cwd: CWD },
    );
    expect(entries.filter((e) => e.kind === "file.hot").map((e) => e.value)).toEqual([
      "docs/a.md",
    ]);
  });
});
