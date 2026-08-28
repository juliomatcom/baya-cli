import { z } from "zod";

/**
 * The wire format (protocol.md). Every orchestrator<->provider exchange is
 * JSON validated against one of these; prose is never the interface.
 *
 * `z.infer` is the only source of these types — conventions.md forbids
 * hand-writing a type a schema already implies.
 */

/** Closed enum. The planner may name a provider; it may never name a binary. */
export const PROVIDER_IDS = ["codex", "claude", "copilot", "opencode"] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const PROTOCOL_VERSION = "1";
export const MANIFEST_VERSION = 1;

/** Cap from protocol.md §3. Applied to `summary` on the way in. */
export const SUMMARY_MAX_CHARS = 2000;

// ---------------------------------------------------------------- manifest

export const TaskSchema = z
  .object({
    id: z.string(),
    title: z.string().min(1),
    instruction: z.string().min(1),
    /** `null` => fall back to the configured default provider. */
    provider: ProviderIdSchema.nullable().default(null),
    /** `null` => the provider's own default. Never hard-code a model id. */
    model: z.string().min(1).nullable().default(null),
    depends_on: z.array(z.string()).default([]),
    writes: z.boolean().default(false),
    cwd: z.string().nullable().default(null),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

export const SourceSchema = z.object({ path: z.string(), sha256: z.string() }).strict();
export type Source = z.infer<typeof SourceSchema>;

export const ManifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    source: SourceSchema,
    tasks: z.array(TaskSchema),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;

// ------------------------------------------------------------ task_request

export const ContextEntrySchema = z
  .object({
    task_id: z.string(),
    title: z.string(),
    status: z.string(),
    summary: z.string(),
    result_path: z.string(),
    output_path: z.string(),
    /** Upstream text when it fits the per-edge budget, else null + read the path. */
    inline: z.string().nullable(),
  })
  .strict();
export type ContextEntry = z.infer<typeof ContextEntrySchema>;

export const TaskRequestSchema = z
  .object({
    baya: z.literal(PROTOCOL_VERSION),
    kind: z.literal("task_request"),
    run_id: z.string(),
    task: z
      .object({ id: z.string(), title: z.string(), instruction: z.string() })
      .strict(),
    workspace: z
      .object({
        cwd: z.string(),
        writable: z.boolean(),
        isolation: z.enum(["shared", "worktree"]),
      })
      .strict(),
    context: z.array(ContextEntrySchema),
    response_contract: z.object({ schema_path: z.string() }).strict(),
    constraints: z.object({ max_runtime_s: z.number().int().positive() }).strict(),
  })
  .strict();
export type TaskRequest = z.infer<typeof TaskRequestSchema>;

// ------------------------------------------------------------- task_result

export const NOTE_SEVERITIES = ["info", "warn", "action_required"] as const;
export const NoteSeveritySchema = z.enum(NOTE_SEVERITIES);
export type NoteSeverity = z.infer<typeof NoteSeveritySchema>;

/** "Done, but you should know…" — the channel that is neither failure nor question. */
export const NoteSchema = z
  .object({ severity: NoteSeveritySchema, message: z.string().min(1) })
  .strict();
export type Note = z.infer<typeof NoteSchema>;

export const QuestionSchema = z
  .object({
    text: z.string().min(1),
    options: z.array(z.string()).nullable().default(null),
    default: z.string().nullable().default(null),
  })
  .strict();

export const ResultErrorSchema = z
  .object({ message: z.string(), retryable: z.boolean() })
  .strict();

export const ArtifactSchema = z
  .object({
    path: z.string(),
    kind: z.string().default("file"),
    description: z.string().nullable().default(null),
  })
  .strict();

export const TASK_STATUSES = ["ok", "needs_input", "failed"] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskResultSchema = z
  .object({
    baya: z.literal(PROTOCOL_VERSION),
    kind: z.literal("task_result"),
    task_id: z.string(),
    status: TaskStatusSchema,
    summary: z.string().max(SUMMARY_MAX_CHARS).default(""),
    output: z.string().default(""),
    /** Valid on every status. Empty array when there is nothing to raise; never null. */
    notes: z.array(NoteSchema).default([]),
    question: QuestionSchema.nullable().default(null),
    error: ResultErrorSchema.nullable().default(null),
    artifacts: z.array(ArtifactSchema).default([]),
    files_changed: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "ok" && value.summary.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary"],
        message: "status 'ok' requires a non-empty summary",
      });
    }
    if (value.status === "needs_input" && value.question === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["question"],
        message: "status 'needs_input' requires question.text",
      });
    }
    if (value.status === "failed" && value.error === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "status 'failed' requires error.message and error.retryable",
      });
    }
  });
export type TaskResult = z.infer<typeof TaskResultSchema>;

// ---------------------------------------------------------- ProviderEvent

export const ProviderEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("session"), id: z.string() }).strict(),
  z.object({ t: z.literal("text"), text: z.string() }).strict(),
  z.object({ t: z.literal("tool"), name: z.string(), input: z.unknown().optional() }),
  z.object({ t: z.literal("final"), raw: z.string() }).strict(),
  z
    .object({
      t: z.literal("error"),
      kind: z.enum(["rate_limit", "auth", "other"]),
      message: z.string(),
    })
    .strict(),
  /** Unrecognized transport lines are kept, never dropped — silent drops make drift invisible. */
  z.object({ t: z.literal("unknown"), raw: z.string() }).strict(),
]);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;
