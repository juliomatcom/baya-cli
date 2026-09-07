import { z } from 'zod';

/**
 * The wire format (protocol.md). Every orchestrator<->provider exchange is
 * JSON validated against one of these; prose is never the interface.
 *
 * `z.infer` is the only source of these types — conventions.md forbids
 * hand-writing a type a schema already implies.
 */

/** Closed enum. The planner may name a provider; it may never name a binary. */
export const PROVIDER_IDS = ['codex', 'claude', 'copilot', 'opencode'] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const PROTOCOL_VERSION = '1';
export const MANIFEST_VERSION = 1;

/** Cap from protocol.md §3. Applied to `summary` on the way in. */
export const SUMMARY_MAX_CHARS = 2000;

// ---------------------------------------------------------------- manifest

export const ACCESS_LEVELS = ['read-only', 'read-write'] as const;
export const AccessSchema = z.enum(ACCESS_LEVELS);
export type Access = z.infer<typeof AccessSchema>;

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
    /**
     * What the task needs permission to **do**, not what it edits. A task that
     * runs the suite and reports back changes no source and is still
     * `read-write`: jest drops a cache, and a provider that cannot act cannot
     * verify anything. Named for the permission because the old boolean —
     * `writes` — was read as "this modifies my code" and alarmed people about
     * tasks that only ran a test.
     */
    access: AccessSchema.default('read-only'),
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
    kind: z.literal('task_request'),
    run_id: z.string(),
    task: z
      .object({ id: z.string(), title: z.string(), instruction: z.string() })
      .strict(),
    workspace: z
      .object({
        cwd: z.string(),
        access: AccessSchema,
        isolation: z.enum(['shared', 'worktree']),
      })
      .strict(),
    context: z.array(ContextEntrySchema),
    response_contract: z.object({ schema_path: z.string() }).strict(),
    constraints: z.object({ max_runtime_s: z.number().int().positive() }).strict(),
  })
  .strict();
export type TaskRequest = z.infer<typeof TaskRequestSchema>;

// ------------------------------------------------------------- task_result

export const NOTE_SEVERITIES = ['info', 'warn', 'action_required'] as const;
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
    kind: z.string().default('file'),
    description: z.string().nullable().default(null),
  })
  .strict();

export const TASK_STATUSES = ['ok', 'needs_input', 'failed'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskResultSchema = z
  .object({
    baya: z.literal(PROTOCOL_VERSION),
    kind: z.literal('task_result'),
    task_id: z.string(),
    status: TaskStatusSchema,
    summary: z.string().max(SUMMARY_MAX_CHARS).default(''),
    output: z.string().default(''),
    /** Valid on every status. Empty array when there is nothing to raise; never null. */
    notes: z.array(NoteSchema).default([]),
    question: QuestionSchema.nullable().default(null),
    error: ResultErrorSchema.nullable().default(null),
    artifacts: z.array(ArtifactSchema).default([]),
    files_changed: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'ok' && value.summary.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: "status 'ok' requires a non-empty summary",
      });
    }
    if (value.status === 'needs_input' && value.question === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['question'],
        message: "status 'needs_input' requires question.text",
      });
    }
    if (value.status === 'failed' && value.error === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: "status 'failed' requires error.message and error.retryable",
      });
    }
  });
export type TaskResult = z.infer<typeof TaskResultSchema>;

/**
 * A task group's response document (protocol.md §3b). One provider process
 * serves several tasks (execution.md §Grouping) and a process returns exactly
 * one document, so the document carries one `task_result` per task.
 *
 * Only ever asked for when a group holds two or more tasks. A process running
 * one task answers with the plain `task_result` above — the single-task wire
 * format is unchanged, which is what makes `--group-size 1` a true bypass.
 */
export const TaskResultBatchSchema = z
  .object({
    baya: z.literal(PROTOCOL_VERSION),
    kind: z.literal('task_result_batch'),
    results: z.array(TaskResultSchema).min(1),
  })
  .strict();
export type TaskResultBatch = z.infer<typeof TaskResultBatchSchema>;

// ---------------------------------------------------------- ProviderEvent

export const ProviderEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('session'), id: z.string() }).strict(),
  z.object({ t: z.literal('text'), text: z.string() }).strict(),
  z.object({ t: z.literal('tool'), name: z.string(), input: z.unknown().optional() }),
  z.object({ t: z.literal('final'), raw: z.string() }).strict(),
  z
    .object({
      t: z.literal('error'),
      kind: z.enum(['rate_limit', 'auth', 'other']),
      message: z.string(),
    })
    .strict(),
  /** Unrecognized transport lines are kept, never dropped — silent drops make drift invisible. */
  z.object({ t: z.literal('unknown'), raw: z.string() }).strict(),
]);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

// -------------------------------------------------------------- consensus

/** `baya consensus` wire format (specs/002-ai-consensus/spec.md §4). */

/**
 * ⚠️ `question` and `prompt` are the same text read two ways, and the
 * difference is the whole output. A question is **answered**; a prompt is
 * **rewritten**. A bare interrogative is a question — workshopping someone's
 * wording when they asked a question is not what they came for.
 */
export const ARTIFACT_KINDS = [
  'question',
  'plan',
  'spec',
  'review',
  'idea',
  'prompt',
] as const;
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** Severities that keep a debate open (§6). */
export const BLOCKING_SEVERITIES: readonly FindingSeverity[] = ['blocker', 'major'];

export const POSITION_MAX_CHARS = 1500;

export const CriterionSchema = z
  .object({ id: z.string().min(1), question: z.string().min(1) })
  .strict();
export type Criterion = z.infer<typeof CriterionSchema>;

export const ConsensusCriteriaSchema = z
  .object({
    baya: z.literal(PROTOCOL_VERSION),
    kind: z.literal('consensus_criteria'),
    artifact_kind: ArtifactKindSchema,
    /**
     * Decides the access posture for every reviewer in the run (§7). Absent or
     * unparseable resolves to `true` at the call site: a wrong `false` costs
     * the debate its evidence silently, a wrong `true` costs tokens.
     */
    needs_workspace: z.boolean(),
    /**
     * Whether the deliverable has to be written before there is anything to
     * review (§3.1). True when the artifact only *asks* for it.
     */
    needs_draft: z.boolean().default(false),
    /**
     * ⚠️ Empty for a question. There is nothing to judge against, because the
     * job is not judging — see specs/002-ai-consensus §3.6.
     */
    criteria: z.array(CriterionSchema).default([]),
  })
  .strict();
export type ConsensusCriteria = z.infer<typeof ConsensusCriteriaSchema>;

/**
 * One reviewer's own answer, written blind in round 1 when the artifact only
 * asks for something. Not a draft to be edited — the whole of what that model
 * had to say before it saw anyone else's.
 */
export const ProposalResultSchema = z
  .object({
    baya: z.literal(PROTOCOL_VERSION),
    kind: z.literal('proposal_result'),
    document: z.string().min(1),
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type ProposalResult = z.infer<typeof ProposalResultSchema>;

/**
 * ⚠️ The moderator's entire output when the job is to produce something: are
 * these answers saying the same thing, and if not, where do they differ.
 *
 * There is no `document`, no ranking and no count, and that is the point. It
 * does not know the answer to the job, it is not its job to know, and every
 * field that could hold one is absent by design — §3.6.
 */
export const AgreementResultSchema = z
  .object({
    baya: z.literal(PROTOCOL_VERSION),
    kind: z.literal('agreement_result'),
    round: z.number().int().positive(),
    agreed: z.boolean(),
    /** One line per point they do not agree on. Empty when `agreed`. */
    differences: z.array(z.string()).default([]),
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type AgreementResult = z.infer<typeof AgreementResultSchema>;

export const FindingSchema = z
  .object({
    id: z.string().min(1),
    severity: FindingSeveritySchema,
    claim: z.string().min(1),
    evidence: z.string(),
    suggestion: z.string().default(''),
    location: z.string().nullable().default(null),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export const CritiqueResultSchema = z
  .object({
    baya: z.literal(PROTOCOL_VERSION),
    kind: z.literal('critique_result'),
    round: z.number().int().positive(),
    /** The one self-reported field, exempted as `summary`/`notes` are (§4). */
    position: z.string().max(POSITION_MAX_CHARS).default(''),
    findings: z.array(FindingSchema).default([]),
    notes: z.array(NoteSchema).default([]),
  })
  .strict();
export type CritiqueResult = z.infer<typeof CritiqueResultSchema>;

export const CHANGE_ACTIONS = ['accepted', 'rejected', 'deferred'] as const;
export const ChangeActionSchema = z.enum(CHANGE_ACTIONS);
export type ChangeAction = z.infer<typeof ChangeActionSchema>;

/**
 * A change is also the agreement cluster: distinct providers among
 * `finding_ids` are the reviewers that raised the same point (§4). No
 * clustering code exists anywhere else.
 */
export const ChangeSchema = z
  .object({
    finding_ids: z.array(z.string()).default([]),
    /**
     * Which criterion this serves. The moderator's declaration, not the
     * reviewer's: the criteria are the moderator's yardstick and never reach a
     * reviewer. Baya rejects a change naming a criterion the run does not have.
     */
    criterion_id: z.string().default(''),
    action: ChangeActionSchema,
    rationale: z.string().min(1),
  })
  .strict();
export type Change = z.infer<typeof ChangeSchema>;

export const UnresolvedSchema = z
  .object({
    claim: z.string().min(1),
    providers: z.array(z.string()).default([]),
    rationale: z.string().default(''),
  })
  .strict();
export type Unresolved = z.infer<typeof UnresolvedSchema>;

export const ReconcileResultSchema = z
  .object({
    baya: z.literal(PROTOCOL_VERSION),
    kind: z.literal('reconcile_result'),
    round: z.number().int().positive(),
    document: z.string().min(1),
    changes: z.array(ChangeSchema).default([]),
    unresolved: z.array(UnresolvedSchema).default([]),
    /** Advisory only. §6's gate is Baya's, never the model's. */
    converged: z.boolean().default(false),
  })
  .strict();
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;
