import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Observation } from "./types.js";

/**
 * Claude Code's own session transcript, read as an observation source.
 *
 * `claude --output-format json` prints a single object, so `parseEvents` can
 * never produce `tool` events — under that surface a claude task would consume
 * memory and contribute nothing to it. The transcript is the way back in, and
 * it is a strictly better source than codex's event stream: `Read` carries an
 * explicit `file_path`, where codex leaves the path to be dug out of a
 * `sed -n '1,220p' …` string.
 *
 * Chosen over `--output-format stream-json --verbose` deliberately: this is
 * additive, and leaves the working `extractResult` ladder untouched.
 */

/**
 * Transcripts live at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`.
 *
 * The slug's escaping rules are undocumented, so they are not reproduced here
 * — Baya pre-assigns the session id (`--session-id`), so the file can be found
 * by that instead. Scanning the project directories costs one `readdir` and
 * cannot drift the way a slug rule would.
 */
export function findClaudeTranscript(
  sessionId: string,
  home: string = homedir(),
): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const projects = join(home, ".claude", "projects");
  let entries: string[];
  try {
    entries = readdirSync(projects);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(projects, entry, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The editing tools, whose `file_path` is a write rather than a read. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "NotebookRead"]);

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Only `assistant` and `user` records carry `message.content[]`; the rest of
 * the file is bookkeeping (`attachment`, `ai-title`, `queue-operation`,
 * `atis-latch`, `last-prompt`) and is skipped rather than guessed at.
 *
 * A malformed line is skipped, never thrown on: memory is an optimization, and
 * failing a task because its transcript was odd would trade a large benefit
 * for a small one.
 */
export function parseClaudeTranscript(contents: string): Observation[] {
  const uses = new Map<string, ToolUse>();
  const observations: Observation[] = [];
  // Commands are held until their result arrives, because `ok` is the fact
  // worth keeping and it lives on the `tool_result`, not the `tool_use`.
  const pendingCommands = new Map<string, string>();

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) continue;
    if (record["type"] !== "assistant" && record["type"] !== "user") continue;
    const message = asRecord(record["message"]);
    const content = message?.["content"];
    if (!Array.isArray(content)) continue;

    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;

      if (block["type"] === "tool_use") {
        const id = block["id"];
        const name = block["name"];
        const input = asRecord(block["input"]) ?? {};
        if (typeof id !== "string" || typeof name !== "string") continue;
        uses.set(id, { name, input });
        if (name === "Bash" && typeof input["command"] === "string") {
          pendingCommands.set(id, input["command"]);
          continue;
        }
        const path = input["file_path"] ?? input["path"] ?? input["notebook_path"];
        if (typeof path !== "string") continue;
        if (WRITE_TOOLS.has(name)) observations.push({ kind: "write", path });
        else if (READ_TOOLS.has(name)) observations.push({ kind: "read", path });
        continue;
      }

      if (block["type"] === "tool_result") {
        const id = block["tool_use_id"];
        if (typeof id !== "string") continue;
        const command = pendingCommands.get(id);
        if (command === undefined) continue;
        pendingCommands.delete(id);
        observations.push({
          kind: "command",
          command,
          ok: block["is_error"] !== true,
        });
      }
    }
  }

  // Commands whose result never arrived (an interrupted turn) are dropped.
  // Their exit status is the fact, and inventing one in either direction is
  // exactly the kind of guess this whole design exists to avoid.
  return observations;
}
