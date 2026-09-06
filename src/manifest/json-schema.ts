import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ACCESS_LEVELS,
  ARTIFACT_KINDS,
  CHANGE_ACTIONS,
  FINDING_SEVERITIES,
  NOTE_SEVERITIES,
  PROTOCOL_VERSION,
  PROVIDER_IDS,
  TASK_ID_PATTERN,
  TASK_STATUSES,
} from './schemas.js';

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
export const TASK_RESULT_SCHEMA_FILENAME = 'task_result.schema.json';
export const TASK_RESULT_BATCH_SCHEMA_FILENAME = 'task_result_batch.schema.json';
export const PLAN_DRAFT_SCHEMA_FILENAME = 'plan_draft.schema.json';

export function taskResultJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'baya task_result',
    type: 'object',
    additionalProperties: false,
    required: [
      'baya',
      'kind',
      'task_id',
      'status',
      'summary',
      'output',
      'notes',
      'question',
      'error',
      'artifacts',
      'files_changed',
    ],
    properties: {
      baya: { type: 'string', const: PROTOCOL_VERSION },
      kind: { type: 'string', const: 'task_result' },
      task_id: { type: 'string' },
      status: { type: 'string', enum: [...TASK_STATUSES] },
      summary: {
        type: 'string',
        description:
          'One or two sentences on what was done. Shown in the terminal; keep the first line under 120 characters.',
      },
      output: {
        type: 'string',
        description: 'The full result as Markdown. Downstream tasks read this.',
      },
      notes: {
        type: 'array',
        description:
          'Anything a human should know that is neither a failure nor a blocking question: caveats, risks, assumptions you had to make, follow-up work you noticed. Empty array when there is nothing to raise.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'message'],
          properties: {
            severity: { type: 'string', enum: [...NOTE_SEVERITIES] },
            message: { type: 'string' },
          },
        },
      },
      question: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['text', 'options', 'default'],
        properties: {
          text: { type: 'string' },
          options: { type: ['array', 'null'], items: { type: 'string' } },
          default: { type: ['string', 'null'] },
        },
      },
      error: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['message', 'retryable'],
        properties: {
          message: { type: 'string' },
          retryable: { type: 'boolean' },
        },
      },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'kind', 'description'],
          properties: {
            path: { type: 'string' },
            kind: { type: 'string' },
            description: { type: ['string', 'null'] },
          },
        },
      },
      files_changed: { type: 'array', items: { type: 'string' } },
    },
  };
}

/**
 * The `task_result_batch` contract, for a process serving a **group** of tasks
 * (execution.md §Grouping). Its `results` items are the `task_result` schema
 * above, unchanged — the wrapper is the only new shape, so a provider that
 * validates one validates the other.
 *
 * Deliberately no `minItems`/`maxItems`. The group size is prompt-level
 * information, and pinning it in the schema would make a provider reject a
 * partial answer outright — losing the tasks that *were* done. A short
 * `results` array is handled where it can be handled well: `alignToTasks`
 * fails only the tasks actually missing.
 */
export function taskResultBatchJsonSchema(): Record<string, unknown> {
  const { $schema, title: _title, ...item } = taskResultJsonSchema();
  void _title;
  return {
    $schema,
    title: 'baya task_result_batch',
    type: 'object',
    additionalProperties: false,
    required: ['baya', 'kind', 'results'],
    properties: {
      baya: { type: 'string', const: PROTOCOL_VERSION },
      kind: { type: 'string', const: 'task_result_batch' },
      results: {
        type: 'array',
        description:
          "One object per task you were given, each with that task's own id in `task_id`. A task you did not complete still needs an entry, with status 'failed' or 'needs_input'.",
        items: item,
      },
    },
  };
}

/** Atomic write, as for the single-task schema. */
export function writeTaskResultBatchSchema(schemaDir: string): string {
  const target = join(schemaDir, TASK_RESULT_BATCH_SCHEMA_FILENAME);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(taskResultBatchJsonSchema(), null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
  return target;
}

/** Atomic write (conventions.md #8) so a concurrent reader never sees a torn file. */
export function writeTaskResultSchema(schemaDir: string): string {
  const target = join(schemaDir, TASK_RESULT_SCHEMA_FILENAME);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(taskResultJsonSchema(), null, 2)}\n`, 'utf8');
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
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'baya plan draft',
    type: 'object',
    additionalProperties: false,
    required: ['tasks'],
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'title',
            'instruction',
            'provider',
            'model',
            'depends_on',
            'access',
            'cwd',
          ],
          properties: {
            id: {
              type: 'string',
              pattern: TASK_ID_PATTERN.source,
              description: 'kebab-case, unique across the plan',
            },
            title: { type: 'string' },
            instruction: {
              type: 'string',
              description:
                'A full, self-contained prompt. Upstream results arrive separately as context; do not restate them here.',
            },
            provider: {
              type: ['string', 'null'],
              enum: [...PROVIDER_IDS, null],
              description: "null means use the run's default provider",
            },
            model: {
              type: ['string', 'null'],
              description: 'null means provider default',
            },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task ids that must succeed first. Must be acyclic.',
            },
            access: {
              type: 'string',
              enum: [...ACCESS_LEVELS],
              description:
                'read-write if the task modifies the workspace OR runs anything that writes as a side effect (a test suite, a build, a linter, an install). read-only only for pure reading.',
            },
            cwd: { type: ['string', 'null'] },
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
  writeFileSync(tmp, `${JSON.stringify(planDraftJsonSchema(), null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
  return target;
}

// -------------------------------------------------------------- consensus

export const CONSENSUS_CRITERIA_SCHEMA_FILENAME = 'consensus_criteria.schema.json';
export const CRITIQUE_RESULT_SCHEMA_FILENAME = 'critique_result.schema.json';
export const RECONCILE_RESULT_SCHEMA_FILENAME = 'reconcile_result.schema.json';
export const PROPOSAL_RESULT_SCHEMA_FILENAME = 'proposal_result.schema.json';
export const AGREEMENT_RESULT_SCHEMA_FILENAME = 'agreement_result.schema.json';

/** Atomic write, as for every other schema document here. */
function writeSchema(
  schemaDir: string,
  filename: string,
  document: Record<string, unknown>,
): string {
  const target = join(schemaDir, filename);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
  return target;
}

export function consensusCriteriaJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'baya consensus_criteria',
    type: 'object',
    additionalProperties: false,
    required: [
      'baya',
      'kind',
      'artifact_kind',
      'needs_workspace',
      'needs_draft',
      'criteria',
    ],
    properties: {
      baya: { type: 'string', const: PROTOCOL_VERSION },
      kind: { type: 'string', const: 'consensus_criteria' },
      artifact_kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
      needs_workspace: {
        type: 'boolean',
        description:
          'true if settling this question requires reading files, running commands, or reaching the network. When unsure answer true: reviewers that cannot check anything produce opinion instead of evidence.',
      },
      needs_draft: {
        type: 'boolean',
        description:
          'true if the artifact only asks for the deliverable and it does not exist yet — a question, a request, a task. false if the artifact IS the deliverable and the debate improves it in place.',
      },
      criteria: {
        type: 'array',
        description:
          'What reviewers should judge this artifact against. One question per entry, specific to this artifact, not generic review advice. Every criterion must be answerable with what the reviewers will actually have.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'question'],
          properties: {
            id: { type: 'string', description: 'kebab-case, unique' },
            question: { type: 'string' },
          },
        },
      },
    },
  };
}

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'severity', 'claim', 'evidence', 'suggestion', 'location'],
  properties: {
    id: { type: 'string', description: 'Unique within your own response. f1, f2, …' },
    severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
    claim: { type: 'string', description: 'What is wrong, in one sentence.' },
    evidence: {
      type: 'string',
      description:
        'Why you believe it: a quoted line, a file you read, a command you ran and its output. A claim with no evidence is an opinion.',
    },
    suggestion: { type: 'string', description: 'What to do instead. May be empty.' },
    location: {
      type: ['string', 'null'],
      description: 'File path, line, or section. null when none applies.',
    },
  },
} as const;

export function critiqueResultJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'baya critique_result',
    type: 'object',
    additionalProperties: false,
    required: ['baya', 'kind', 'round', 'position', 'findings', 'notes'],
    properties: {
      baya: { type: 'string', const: PROTOCOL_VERSION },
      kind: { type: 'string', const: 'critique_result' },
      round: { type: 'integer', minimum: 1 },
      position: {
        type: 'string',
        description:
          'Your overall stance in a few sentences — the read the individual findings do not carry. You will be shown this again next round.',
      },
      findings: {
        type: 'array',
        description:
          'Empty array when you have nothing to raise. Do not invent findings to fill it.',
        items: FINDING_SCHEMA,
      },
      notes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'message'],
          properties: {
            severity: { type: 'string', enum: [...NOTE_SEVERITIES] },
            message: { type: 'string' },
          },
        },
      },
    },
  };
}

export function reconcileResultJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'baya reconcile_result',
    type: 'object',
    additionalProperties: false,
    required: ['baya', 'kind', 'round', 'document', 'changes', 'unresolved', 'converged'],
    properties: {
      baya: { type: 'string', const: PROTOCOL_VERSION },
      kind: { type: 'string', const: 'reconcile_result' },
      round: { type: 'integer', minimum: 1 },
      document: {
        type: 'string',
        description:
          'The complete updated artifact in Markdown. Not a patch, not a summary of edits — the whole document as it now stands.',
      },
      changes: {
        type: 'array',
        description:
          'One entry per decision you made. Group findings that make the same point into one entry, whoever raised them.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['finding_ids', 'criterion_id', 'action', 'rationale'],
          properties: {
            finding_ids: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The finding ids this decision covers, exactly as given to you.',
            },
            criterion_id: {
              type: 'string',
              description:
                'Which of your criteria this decision serves, by id. The reviewers do not know your criteria, so this mapping is yours to make. A decision that serves none of them is not one you may accept.',
            },
            action: { type: 'string', enum: [...CHANGE_ACTIONS] },
            rationale: {
              type: 'string',
              description:
                'Why. The reviewer who raised it reads this next round, so a bare verdict is not enough.',
            },
          },
        },
      },
      unresolved: {
        type: 'array',
        description:
          'Disagreements you could not settle. Kept in the final output rather than dropped.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claim', 'providers', 'rationale'],
          properties: {
            claim: { type: 'string' },
            providers: { type: 'array', items: { type: 'string' } },
            rationale: { type: 'string' },
          },
        },
      },
      converged: {
        type: 'boolean',
        description: 'Your read on whether this is done. Advisory only.',
      },
    },
  };
}

export function proposalResultJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'baya proposal_result',
    type: 'object',
    additionalProperties: false,
    required: ['baya', 'kind', 'document', 'notes'],
    properties: {
      baya: { type: 'string', const: PROTOCOL_VERSION },
      kind: { type: 'string', const: 'proposal_result' },
      document: {
        type: 'string',
        description: 'Your answer, in full, as plain Markdown.',
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Anything you are unsure of or deliberately left open. May be empty.',
      },
    },
  };
}

export function agreementResultJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'baya agreement_result',
    type: 'object',
    additionalProperties: false,
    required: ['baya', 'kind', 'round', 'agreed', 'differences', 'notes'],
    properties: {
      baya: { type: 'string', const: PROTOCOL_VERSION },
      kind: { type: 'string', const: 'agreement_result' },
      round: { type: 'integer', minimum: 1 },
      agreed: {
        type: 'boolean',
        description:
          'true only if the answers say the same thing — someone acting on any one of them would end up in the same place. Different wording, ordering or detail is still agreement. A different conclusion is not.',
      },
      differences: {
        type: 'array',
        items: { type: 'string' },
        description:
          'One line per point they do not agree on, stating what the disagreement is. Not which side is right: you do not know, and it is not yours to decide. Empty when agreed is true.',
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Anything about the comparison worth recording. May be empty.',
      },
    },
  };
}

export function writeAgreementResultSchema(schemaDir: string): string {
  return writeSchema(
    schemaDir,
    AGREEMENT_RESULT_SCHEMA_FILENAME,
    agreementResultJsonSchema(),
  );
}

export function writeProposalResultSchema(schemaDir: string): string {
  return writeSchema(
    schemaDir,
    PROPOSAL_RESULT_SCHEMA_FILENAME,
    proposalResultJsonSchema(),
  );
}

export function writeConsensusCriteriaSchema(schemaDir: string): string {
  return writeSchema(
    schemaDir,
    CONSENSUS_CRITERIA_SCHEMA_FILENAME,
    consensusCriteriaJsonSchema(),
  );
}

export function writeCritiqueResultSchema(schemaDir: string): string {
  return writeSchema(
    schemaDir,
    CRITIQUE_RESULT_SCHEMA_FILENAME,
    critiqueResultJsonSchema(),
  );
}

export function writeReconcileResultSchema(schemaDir: string): string {
  return writeSchema(
    schemaDir,
    RECONCILE_RESULT_SCHEMA_FILENAME,
    reconcileResultJsonSchema(),
  );
}
