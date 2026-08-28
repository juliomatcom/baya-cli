import { type ProviderEvent, type TaskResult } from "../manifest/index.js";
import { stripAnsi } from "../log/index.js";
import { parseResultJson, synthesizeFailure } from "./result.js";
import type {
  BuildRunInput,
  ExtractContext,
  ProviderAdapter,
  ProviderUsage,
  SpawnPlan,
} from "./types.js";

/**
 * codex adapter (providers.md §codex, verified live 2026-08-28).
 *
 * The strongest surface in the set and therefore the one the engine is built
 * against: file-in / file-out schema enforcement means the result never has to
 * be parsed out of prose, so M1 exercises the clean path end to end.
 *
 * ⚠️ `-p` is `--profile`, NOT the prompt. The prompt is positional, `-`, or
 * stdin — we use `-` plus stdin. The argv snapshot test is what keeps this
 * from silently regressing when the CLI drifts.
 */

function sandboxFor(input: BuildRunInput): string {
  if (input.dangerouslyAllowAll) return "danger-full-access";
  return input.task.writes ? "workspace-write" : "read-only";
}

/** Flags shared by `exec` and `exec resume`, in a fixed order for the snapshot. */
function commonFlags(input: BuildRunInput): string[] {
  const argv = [
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "-C",
    input.cwd,
    "-s",
    sandboxFor(input),
    "--output-schema",
    input.schemaPath,
    "-o",
    input.resultFile,
  ];
  if (input.model !== null) argv.push("-m", input.model);
  return argv;
}

function toolNameFor(itemType: string, item: Record<string, unknown>): string {
  switch (itemType) {
    case "command_execution":
      return `Shell(${String(item["command"] ?? "")})`;
    case "file_change":
      return `Edit(${String(item["path"] ?? "")})`;
    case "mcp_tool_call":
      return `${String(item["server"] ?? "mcp")}.${String(item["tool"] ?? "")}`;
    case "web_search":
      return `Search(${String(item["query"] ?? "")})`;
    default:
      return itemType;
  }
}

function eventForLine(line: string): ProviderEvent {
  const trimmed = stripAnsi(line).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { t: "unknown", raw: trimmed };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { t: "unknown", raw: trimmed };
  }
  const obj = parsed as Record<string, unknown>;

  switch (obj["type"]) {
    case "thread.started": {
      const id = obj["thread_id"];
      // The session id is the whole reason this event matters; without it the
      // line is just noise, and `unknown` is where noise belongs.
      if (typeof id === "string") return { t: "session", id };
      return { t: "unknown", raw: trimmed };
    }
    case "item.completed": {
      const item = obj["item"];
      if (item === null || typeof item !== "object") {
        return { t: "unknown", raw: trimmed };
      }
      const record = item as Record<string, unknown>;
      const itemType = String(record["type"] ?? "");
      if (itemType === "agent_message") {
        return { t: "text", text: String(record["text"] ?? "") };
      }
      return { t: "tool", name: toolNameFor(itemType, record), input: record };
    }
    case "error": {
      const message = String(obj["message"] ?? trimmed);
      return { t: "error", kind: classifyErrorText(message), message };
    }
    default:
      // turn.started / turn.completed and anything codex adds next. Kept, not
      // dropped: `turn.completed` carries usage, and silent drops make drift invisible.
      return { t: "unknown", raw: trimmed };
  }
}

function classifyErrorText(message: string): "rate_limit" | "auth" | "other" {
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (lower.includes("unauthorized") || lower.includes("401")) return "auth";
  return "other";
}

export const codexAdapter: ProviderAdapter = {
  id: "codex",

  capabilities: {
    promptDelivery: ["stdin", "argv"],
    structuredOutput: "schema-file",
    events: "jsonl",
    sessionId: "capture",
    resume: "session",
    cwdFlag: true,
    modelFlag: true,
    maxConcurrency: 2,
  },

  installHint: "npm i -g @openai/codex",

  buildRun(input: BuildRunInput): SpawnPlan {
    return {
      argv: [input.bin, "exec", ...commonFlags(input), "-"],
      cwd: input.cwd,
      stdin: "pipe",
      stdinData: input.prompt,
    };
  },

  /**
   * `codex exec resume <thread_id>` — the id captured from `thread.started`.
   * ⚠️ UNVERIFIED that `thread_id` is the identifier `resume` accepts; the
   * contract tier (M3.7) is where that gets settled against the real binary.
   */
  buildResume(sessionId: string, answer: string, input: BuildRunInput): SpawnPlan {
    return {
      argv: [input.bin, "exec", "resume", sessionId, ...commonFlags(input), "-"],
      cwd: input.cwd,
      stdin: "pipe",
      stdinData: answer,
    };
  },

  parseEvents(chunk: string): ProviderEvent[] {
    return chunk
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(eventForLine);
  },

  /**
   * Rung 1 of the degradation ladder and, for codex, the only rung that should
   * ever fire: `--output-schema` + `-o` means the file holds exactly the
   * conforming JSON. Anything else is a failure to report, not prose to mine.
   */
  extractResult(ctx: ExtractContext): TaskResult {
    if (ctx.resultFileContents !== null && ctx.resultFileContents.trim() !== "") {
      const parsed = parseResultJson(ctx.taskId, ctx.resultFileContents);
      if (parsed) return parsed;
      return synthesizeFailure(
        ctx.taskId,
        "codex wrote a result file that does not match task_result",
        { retryable: true },
      );
    }

    const errorEvent = ctx.events.find((event) => event.t === "error");
    if (errorEvent && errorEvent.t === "error") {
      return synthesizeFailure(ctx.taskId, errorEvent.message, {
        retryable: errorEvent.kind !== "auth",
      });
    }

    const detail = stripAnsi(ctx.stderr).trim().split("\n").slice(-3).join(" ").trim();
    return synthesizeFailure(
      ctx.taskId,
      `codex produced no result file (exit ${String(ctx.exitCode)})${detail ? `: ${detail}` : ""}`,
    );
  },

  extractUsage(events: ProviderEvent[]): ProviderUsage {
    // `turn.completed` lands in `unknown`; usage is read back out here rather
    // than widening the ProviderEvent union for one provider's accounting.
    for (const event of events) {
      if (event.t !== "unknown") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.raw);
      } catch {
        continue;
      }
      const obj = parsed as Record<string, unknown> | null;
      if (!obj || obj["type"] !== "turn.completed") continue;
      const usage = obj["usage"];
      if (!usage || typeof usage !== "object") continue;
      const u = usage as Record<string, unknown>;
      const out: ProviderUsage = {};
      if (typeof u["input_tokens"] === "number") out.input_tokens = u["input_tokens"];
      if (typeof u["output_tokens"] === "number") out.output_tokens = u["output_tokens"];
      if (typeof u["cost_usd"] === "number") out.cost_usd = u["cost_usd"];
      return out;
    }
    return {};
  },
};
