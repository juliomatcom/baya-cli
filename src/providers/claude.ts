import { type ProviderEvent, type TaskResult } from "../manifest/index.js";
import { stripAnsi } from "../log/index.js";
import { extractResultFromText, parseResultJson, synthesizeFailure } from "./result.js";
import type {
  BuildRunInput,
  ExtractContext,
  ProviderAdapter,
  ProviderUsage,
  SpawnPlan,
} from "./types.js";

/**
 * claude adapter (providers.md §claude, flags verified live 2026-08-28, v2.1.251).
 *
 * Second provider after codex, and the one that proves the abstraction against
 * a different schema-enforcement shape: codex is file-in/file-out, claude is
 * **inline** — `--json-schema` rejects a file path, and the conforming object
 * comes back on `.structured_output` inside a single JSON blob rather than in a
 * file of its own.
 *
 * ⚠️ No working-directory flag exists — `--add-dir` only *widens* access. The
 * working directory is the spawn `cwd` and nothing else.
 * ⚠️ The `--permission-mode` map below is UNVERIFIED pending the contract tier
 * (M3.7). Flags are real; which mode yields the cleanest non-interactive run is
 * not yet measured.
 */

/** Drop the `$schema` meta-pointer claude's validator cannot resolve; keep the rest. */
function withoutSchemaKey(schemaContents: string): Record<string, unknown> {
  const parsed = JSON.parse(schemaContents) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = parsed;
  void _drop;
  return rest;
}

/** Non-interactive `-p` cannot prompt, so the mode has to pre-decide everything. */
function permissionModeFor(input: BuildRunInput): string {
  if (input.dangerouslyAllowAll) return "bypassPermissions";
  // `plan` is the only mode that actually prevents file writes; a read-only
  // task gets it so a misclassified `writes:false` fails safe instead of
  // silently modifying the tree the way codex's `read-only` sandbox blocks.
  return input.task.writes ? "acceptEdits" : "plan";
}

/** Flags shared by `-p` and `--resume`, in a fixed order for the snapshot. */
function commonFlags(input: BuildRunInput): string[] {
  const argv = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    // Inline JSON only — a file path is rejected. And no `$schema` meta-pointer:
    // claude's validator has no 2020-12 meta-schema loaded and fails with
    // "no schema with key or ref https://json-schema.org/draft/2020-12/schema".
    // It validates structurally without a declared dialect.
    JSON.stringify(withoutSchemaKey(input.schemaContents)),
    "--permission-mode",
    permissionModeFor(input),
  ];
  if (input.model !== null) argv.push("--model", input.model);
  // `--session-id` pre-assigns the id so resume needs no event parsing (M4.1).
  if (input.sessionId !== undefined) argv.push("--session-id", input.sessionId);
  return argv;
}

function classify(text: string): "rate_limit" | "auth" | "other" {
  const lower = text.toLowerCase();
  if (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("overloaded")
  )
    return "rate_limit";
  if (
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("authentication") ||
    lower.includes("api key")
  )
    return "auth";
  return "other";
}

/** The one JSON object `--output-format json` prints, parsed. */
interface ClaudeResult {
  session_id?: unknown;
  result?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  permission_denials?: unknown;
  total_cost_usd?: unknown;
  structured_output?: unknown;
  usage?: unknown;
}

function parseObject(raw: string): ClaudeResult | null {
  let value: unknown;
  try {
    value = JSON.parse(stripAnsi(raw).trim());
  } catch {
    return null;
  }
  return value !== null && typeof value === "object" ? (value as ClaudeResult) : null;
}

function lastFinalObject(events: ProviderEvent[]): ClaudeResult | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && event.t === "final") {
      const parsed = parseObject(event.raw);
      if (parsed) return parsed;
    }
  }
  return null;
}

function deniedTools(obj: ClaudeResult): string[] {
  if (!Array.isArray(obj.permission_denials)) return [];
  return obj.permission_denials.map((entry) => {
    if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      return String(record["tool_name"] ?? record["tool"] ?? JSON.stringify(entry));
    }
    return String(entry);
  });
}

export const claudeAdapter: ProviderAdapter = {
  id: "claude",

  capabilities: {
    promptDelivery: ["stdin", "argv"],
    structuredOutput: "schema-inline",
    events: "json",
    sessionId: "preassign",
    resume: "session",
    cwdFlag: false,
    modelFlag: true,
    // Subscription-throttled until measured under load (risk register).
    maxConcurrency: 1,
  },

  installHint: "npm i -g @anthropic-ai/claude-code",

  buildRun(input: BuildRunInput): SpawnPlan {
    return {
      argv: [input.bin, ...commonFlags(input)],
      cwd: input.cwd,
      stdin: "pipe",
      stdinData: input.prompt,
    };
  },

  /**
   * `claude --resume <session_id>` with the answer on stdin. The id is the one
   * `--session-id` pre-assigned, or the `.session_id` captured from the result.
   */
  buildResume(sessionId: string, answer: string, input: BuildRunInput): SpawnPlan {
    return {
      argv: [input.bin, "--resume", sessionId, ...commonFlags(input)],
      cwd: input.cwd,
      stdin: "pipe",
      stdinData: answer,
    };
  },

  /**
   * `--output-format json` is a single object, not a stream — one line, parsed
   * once. `stream-json` would give incremental `text` events but needs
   * `--verbose` and a less certain shape; M3 takes the stable path.
   */
  parseEvents(chunk: string): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    for (const line of chunk.split("\n")) {
      const trimmed = stripAnsi(line).trim();
      if (trimmed === "") continue;
      const obj = parseObject(trimmed);
      if (!obj) {
        out.push({ t: "unknown", raw: trimmed });
        continue;
      }
      if (typeof obj.session_id === "string") {
        out.push({ t: "session", id: obj.session_id });
      }
      if (obj.is_error === true) {
        const message =
          typeof obj.result === "string" && obj.result.trim() !== ""
            ? obj.result
            : String(obj.subtype ?? "claude reported an error");
        out.push({ t: "error", kind: classify(message), message });
      } else if (typeof obj.result === "string" && obj.result.trim() !== "") {
        out.push({ t: "text", text: obj.result });
      }
      out.push({ t: "final", raw: trimmed });
    }
    return out;
  },

  extractResult(ctx: ExtractContext): TaskResult {
    const obj = lastFinalObject(ctx.events);

    if (obj) {
      // Rung 1: the schema-enforced object claude parsed for us.
      if (obj.structured_output !== null && typeof obj.structured_output === "object") {
        const parsed = parseResultJson(ctx.taskId, JSON.stringify(obj.structured_output));
        if (parsed) return parsed;
      }
      // Rungs 2–3: `.result` is the same payload as a string — often clean
      // JSON, sometimes prose around a fenced block.
      if (typeof obj.result === "string") {
        const fromText = extractResultFromText(ctx.taskId, obj.result);
        if (fromText) return fromText.result;
      }
      const denied = deniedTools(obj);
      if (denied.length > 0) {
        return synthesizeFailure(
          ctx.taskId,
          `claude was denied permission for: ${denied.join(", ")}. Raise --permission-mode or pass --dangerously-allow-all.`,
          { retryable: false },
        );
      }
      if (obj.is_error === true) {
        const message =
          typeof obj.result === "string" && obj.result.trim() !== ""
            ? obj.result
            : `claude error (${String(obj.subtype ?? "unknown")})`;
        return synthesizeFailure(ctx.taskId, message, {
          retryable: classify(message) !== "auth",
        });
      }
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
      `claude produced no parseable result (exit ${String(ctx.exitCode)})${detail ? `: ${detail}` : ""}`,
    );
  },

  extractUsage(events: ProviderEvent[]): ProviderUsage {
    const obj = lastFinalObject(events);
    if (!obj) return {};
    const out: ProviderUsage = {};
    if (typeof obj.total_cost_usd === "number") out.cost_usd = obj.total_cost_usd;
    if (obj.usage !== null && typeof obj.usage === "object") {
      const usage = obj.usage as Record<string, unknown>;
      const num = (key: string): number =>
        typeof usage[key] === "number" ? (usage[key] as number) : 0;
      const input =
        num("input_tokens") +
        num("cache_creation_input_tokens") +
        num("cache_read_input_tokens");
      const output = num("output_tokens");
      if (input > 0) out.input_tokens = input;
      if (output > 0) out.output_tokens = output;
    }
    return out;
  },
};
