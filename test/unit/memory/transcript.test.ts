import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findClaudeTranscript,
  parseClaudeTranscript,
} from "../../../src/memory/index.js";

/**
 * Shapes taken from a real Claude Code transcript written by a Baya run
 * (`~/.claude/projects/<slug>/<session-id>.jsonl`), not from documentation.
 */
const LINES = [
  { type: "queue-operation", operation: "enqueue" },
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "u1",
          name: "Bash",
          input: { command: "npm test", description: "Run the suite" },
        },
      ],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: true }] },
  },
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "u2",
          name: "Bash",
          input: { command: "npm test -- --runInBand" },
        },
      ],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "u2", is_error: false }] },
  },
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "u3",
          name: "Read",
          input: { file_path: "/repo/src/a.ts" },
        },
        {
          type: "tool_use",
          id: "u4",
          name: "Edit",
          input: { file_path: "/repo/src/b.ts" },
        },
      ],
    },
  },
  { type: "attachment", content: "ignored" },
  { type: "ai-title", title: "ignored" },
];

const TRANSCRIPT = LINES.map((line) => JSON.stringify(line)).join("\n");

describe("parseClaudeTranscript", () => {
  it("recovers commands with the exit status that makes them a fact", () => {
    expect(parseClaudeTranscript(TRANSCRIPT)).toEqual(
      expect.arrayContaining([
        { kind: "command", command: "npm test", ok: false },
        { kind: "command", command: "npm test -- --runInBand", ok: true },
      ]),
    );
  });

  it("reads file paths outright — the thing codex forces us to regex for", () => {
    const observations = parseClaudeTranscript(TRANSCRIPT);
    expect(observations).toEqual(
      expect.arrayContaining([
        { kind: "read", path: "/repo/src/a.ts" },
        { kind: "write", path: "/repo/src/b.ts" },
      ]),
    );
  });

  it("skips the bookkeeping records that are most of the file", () => {
    expect(parseClaudeTranscript(TRANSCRIPT)).toHaveLength(4);
  });

  it("drops a command whose result never arrived rather than guessing its status", () => {
    const orphan = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "x",
            name: "Bash",
            input: { command: "npm run build" },
          },
        ],
      },
    });
    expect(parseClaudeTranscript(orphan)).toEqual([]);
  });

  it("survives a malformed line instead of failing the task", () => {
    expect(parseClaudeTranscript("not json\n{}\n")).toEqual([]);
    expect(parseClaudeTranscript("")).toEqual([]);
  });
});

describe("findClaudeTranscript", () => {
  it("finds the file by session id, without reproducing the cwd-slug rules", () => {
    const home = mkdtempSync(join(tmpdir(), "baya-home-"));
    const project = join(home, ".claude", "projects", "-Users-someone-apps-baya");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "abc-123.jsonl"), "{}\n", "utf8");

    expect(findClaudeTranscript("abc-123", home)).toBe(join(project, "abc-123.jsonl"));
  });

  it("returns null when there is no transcript — never an error", () => {
    const home = mkdtempSync(join(tmpdir(), "baya-home-"));
    expect(findClaudeTranscript("missing", home)).toBeNull();
    expect(findClaudeTranscript("any", join(home, "nope"))).toBeNull();
  });

  it("refuses a session id that could escape the projects directory", () => {
    const home = mkdtempSync(join(tmpdir(), "baya-home-"));
    expect(findClaudeTranscript("../../etc/passwd", home)).toBeNull();
  });
});
