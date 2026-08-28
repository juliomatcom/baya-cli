import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  NOTE_SEVERITIES,
  PROTOCOL_VERSION,
  PROVIDER_IDS,
  TASK_ID_PATTERN,
  TASK_STATUSES,
} from "./schemas.js";

/**
 * The `task_result` contract as JSON Schema, written to `.baya/schema/` at
 * runtime and handed to `codex --output-schema <FILE>` (providers.md §2).
 *
 * Hand-written rather than generated: providers that enforce a schema demand
 * the strict dialect — every property `required`, `additionalProperties:false`,
 * no `$ref` indirection — and a generator's output drifts from that quietly.
 * `json-schema.test.ts` asserts the property set matches the zod shape, so the
 * two cannot diverge unnoticed.
 */
export const TASK_RESULT_SCHEMA_FILENAME = "task_result.schema.json";
export const PLAN_DRAFT_SCHEMA_FILENAME = "plan_draft.schema.json";

export function taskResultJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "baya task_result",
    type: "object",
    additionalProperties: false,
    required: [
      "baya",
      "kind",
      "task_id",
      "status",
      "summary",
      "output",
      "notes",
      "question",
      "error",
      "artifacts",
      "files_changed",
    ],
    properties: {
      baya: { type: "string", const: PROTOCOL_VERSION },
      kind: { type: "string", const: "task_result" },
      task_id: { type: "string" },
      status: { type: "string", enum: [...TASK_STATUSES] },
      summary: {
        type: "string",
        description:
          "One or two sentences on what was done. Shown in the terminal; keep the first line under 120 characters.",
      },
      output: {
        type: "string",
        description: "The full result as Markdown. Downstream tasks read this.",
      },
      notes: {
        type: "array",
        description:
          "Anything a human should know that is neither a failure nor a blocking question: caveats, risks, assumptions you had to make, follow-up work you noticed. Empty array when there is nothing to raise.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "message"],
          properties: {
            severity: { type: "string", enum: [...NOTE_SEVERITIES] },
            message: { type: "string" },
          },
        },
      },
      question: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["text", "options", "default"],
        properties: {
          text: { type: "string" },
          options: { type: ["array", "null"], items: { type: "string" } },
          default: { type: ["string", "null"] },
        },
      },
      error: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["message", "retryable"],
        properties: {
          message: { type: "string" },
          retryable: { type: "boolean" },
        },
      },
      artifacts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "kind", "description"],
          properties: {
            path: { type: "string" },
            kind: { type: "string" },
            description: { type: ["string", "null"] },
          },
        },
      },
      files_changed: { type: "array", items: { type: "string" } },
    },
  };
}

/** Atomic write (conventions.md #8) so a concurrent reader never sees a torn file. */
export function writeTaskResultSchema(schemaDir: string): string {
  const target = join(schemaDir, TASK_RESULT_SCHEMA_FILENAME);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(taskResultJsonSchema(), null, 2)}\n`, "utf8");
  renameSync(tmp, target);
  return target;
}

/**
 * What the planner is asked to produce: `tasks[]` and nothing else.
 *
 * The planner never emits `version` or `source` — a sha256 it cannot compute
 * is a field it would have to invent, and inventing identity fields is exactly
 * how a stale plan gets mistaken for a fresh one. Baya wraps the draft.
 */
export function planDraftJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "baya plan draft",
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "title",
            "instruction",
            "provider",
            "model",
            "depends_on",
            "writes",
            "cwd",
          ],
          properties: {
            id: {
              type: "string",
              pattern: TASK_ID_PATTERN.source,
              description: "kebab-case, unique across the plan",
            },
            title: { type: "string" },
            instruction: {
              type: "string",
              description:
                "A full, self-contained prompt. Upstream results arrive separately as context; do not restate them here.",
            },
            provider: {
              type: ["string", "null"],
              enum: [...PROVIDER_IDS, null],
              description: "null means use the run's default provider",
            },
            model: {
              type: ["string", "null"],
              description: "null means provider default",
            },
            depends_on: {
              type: "array",
              items: { type: "string" },
              description: "Task ids that must succeed first. Must be acyclic.",
            },
            writes: {
              type: "boolean",
              description: "true if the task creates or modifies files",
            },
            cwd: { type: ["string", "null"] },
          },
        },
      },
    },
  };
}

/** Atomic write, as for the result schema. */
export function writePlanDraftSchema(schemaDir: string): string {
  const target = join(schemaDir, PLAN_DRAFT_SCHEMA_FILENAME);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(planDraftJsonSchema(), null, 2)}\n`, "utf8");
  renameSync(tmp, target);
  return target;
}
