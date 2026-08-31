import type { TaskRequest } from '../manifest/index.js';

/**
 * Renders the prompt an agent CLI actually receives. The `task_request` JSON
 * is the contract and is always written to disk — one file per task, group or
 * not; this is its human-readable envelope, because these CLIs take a prompt,
 * not an API payload.
 *
 * Untrusted task text reaches here (architecture.md trust boundaries) but never
 * argv — it travels by stdin or file, so nothing in it can become a flag.
 */
export interface RenderPromptOptions {
  /**
   * The rendered memory block (`src/memory/render.ts`), or `""` for none.
   * Placed with `# Workspace` rather than with the upstream results: memory is
   * edgeless workspace knowledge, and `# Upstream results` means edges.
   */
  memory?: string;
  /**
   * The schema document, for a provider that enforces **none**
   * (`opencode`, `copilot`). Absent means the CLI validates the response
   * itself (`codex --output-schema`, `claude --json-schema`) and the prompt
   * says so instead.
   *
   * ⚠️ Never name the schema by **path**. Measured 2026-08-30: the contract
   * read "matching the schema at <path>", so codex did the obvious thing and
   * ran `sed -n '1,240p' .baya/schema/task_result.schema.json` — to read a
   * schema the CLI was already enforcing through `--output-schema`. A tool
   * call is cheap; what follows it is not, because the whole conversation is
   * re-sent afterwards. That one line took a trivial task from 16.8k tokens
   * to 35.6k, nearly all of it the re-send.
   */
  schema?: string;
}

export function renderPrompt(
  request: TaskRequest,
  options: RenderPromptOptions = {},
): string {
  const lines: string[] = [];

  lines.push(
    `You are executing one task in a Baya run (task id: ${request.task.id}).`,
    '',
    `# Task: ${request.task.title}`,
    '',
    request.task.instruction,
    '',
  );

  if (request.context.length > 0) {
    lines.push('# Upstream results', '');
    lines.push(...contextLines(request, new Set()));
  }

  lines.push(...workspaceLines(request, options.memory, false));
  lines.push(...WORKING_STYLE);

  lines.push(
    '# Response contract',
    '',
    ...contractLines(options.schema, 'a single JSON object'),
    ...FIELD_NOTES,
    '',
    `Deadline: ${request.constraints.max_runtime_s} seconds.`,
  );

  return lines.join('\n');
}

/**
 * The prompt for a **group**: several tasks in one process (execution.md
 * §Grouping), worked through in the order given.
 *
 * Everything the tasks share — the workspace, the memory block — is stated
 * once, which is most of what grouping saves on the way in. What is not shared
 * is repeated per task, because a group is still N tasks with N contracts and
 * not one merged task: the single most likely failure here is a model quietly
 * treating them as one piece of work, so the boundaries are made explicit and
 * the response is one entry per task.
 *
 * A group of one is delegated to `renderPrompt`, so the single-task prompt is
 * byte for byte what it was before grouping existed.
 */
export function renderGroupPrompt(
  requests: readonly TaskRequest[],
  options: RenderPromptOptions = {},
): string {
  const only = requests[0];
  if (requests.length <= 1 && only !== undefined) return renderPrompt(only, options);

  const first = requests[0] as TaskRequest;
  const ids = requests.map((request) => request.task.id);
  // An upstream produced by another member of this same group is already in
  // the conversation above. Re-inlining it is the one cost grouping would
  // otherwise add back.
  const inGroup = new Set(ids);
  const count = String(requests.length);
  const lines: string[] = [];

  lines.push(
    `You are executing ${count} tasks in a Baya run, in the order given below.`,
    '',
    'Work through them one at a time and in order. They share this workspace and',
    'this conversation, so a later task can build directly on what an earlier one',
    'did rather than rediscovering it. They are still separate tasks: each has its',
    'own instruction and needs its own entry in the response.',
    '',
    'If one task fails, keep going with the rest unless they depended on it, and',
    "report the failure in that task's own entry.",
    '',
  );

  lines.push(...workspaceLines(first, options.memory, true));

  requests.forEach((request, index) => {
    lines.push(
      `# Task ${String(index + 1)} of ${count}: ${request.task.title}`,
      '',
      `Task id: ${request.task.id}`,
      '',
      request.task.instruction,
      '',
    );
    if (request.context.length > 0) {
      lines.push(`## Upstream results for ${request.task.id}`, '');
      lines.push(...contextLines(request, inGroup));
    }
  });

  lines.push(...WORKING_STYLE);

  lines.push(
    '# Response contract',
    '',
    ...contractLines(options.schema, 'a single JSON object'),
    `Its \`results\` array holds one object per task above — ${count} in total — each`,
    "carrying that task's own id in `task_id`:",
    ...ids.map((id) => `- ${id}`),
    '',
    'A task you could not finish still needs its entry, with `status` set to',
    '`failed` or `needs_input`. Omitting it is reported as a failure anyway, and',
    'without your account of why.',
    '',
    'Field notes, per entry:',
    ...FIELD_NOTES.slice(1),
    '',
    `Deadline: ${String(first.constraints.max_runtime_s)} seconds for all ${count} tasks.`,
  );

  return lines.join('\n');
}

/**
 * Narration is output tokens nobody reads. These CLIs stream their tool calls
 * already, so a running commentary on top of them is pure cost.
 *
 * ⚠️ Deliberately narrow, and the second paragraph is the load-bearing half.
 * A blunt "output only status or errors" reads as permission to thin the
 * response itself — and `notes[]` exists precisely so a caveat reaches a human
 * instead of dying in a result file. Suppressing that to save a few tokens
 * would trade the most valuable thing a task produces for the cheapest.
 *
 * Measured before writing it: across 17 recorded runs output was 1.3% of all
 * tokens (275k against 21.1M input). This is a small lever pulled because it
 * is free, not because it is where the money goes — that is input, and
 * grouping is what attacks it.
 */
const WORKING_STYLE = [
  '# Working style',
  '',
  'Work without narration: no progress updates, no restating the task or your',
  'plan, no account of what you just did. Your tool calls are already visible.',
  '',
  'This is about commentary, not about the response. `summary`, `output` and',
  '`notes` below are the deliverable — say everything that belongs in them.',
  '',
];

/**
 * How to state the contract without sending the model to go and find it.
 *
 * Enforced providers get told it is enforced, and told **not** to go looking:
 * an agent handed a schema path will read it, and the read costs a full
 * context re-send for information the runtime already guarantees.
 *
 * Providers that enforce nothing get the schema **inlined**. That is ~800
 * tokens once, against a re-send of the whole conversation — an order of
 * magnitude cheaper, and the only way those adapters learn the envelope at all.
 */
function contractLines(schema: string | undefined, shape: string): string[] {
  const trimmed = schema?.trim() ?? '';
  if (trimmed === '') {
    return [
      `Respond with ${shape} matching the \`task_result\` contract, which the CLI you`,
      'are running in already enforces. Do not open or search for a schema file —',
      'there is nothing in it that is not already being applied to your output.',
    ];
  }
  return [
    `Respond with ${shape} matching this schema. It is reproduced here in full, so`,
    'do not open or search for a schema file:',
    '',
    '<schema>',
    trimmed,
    '</schema>',
  ];
}

const FIELD_NOTES = [
  'Field notes:',
  '- `summary`: one or two sentences. Its first line is what the user sees in the terminal.',
  '- `output`: the full result as Markdown. Downstream tasks read this.',
  '- `notes`: anything a human should know that is neither a failure nor a blocking',
  '  question — caveats, risks, assumptions you had to make, follow-up work you noticed.',
  '  Use `warn` for something likely wrong or risky, `action_required` for something only',
  '  a human can do, `info` otherwise. Empty array if there is nothing to raise.',
  '- If you cannot proceed without a human decision, set `status` to `needs_input` and',
  '  fill `question.text` rather than guessing.',
  '- On failure, set `status` to `failed` and fill `error.message` and `error.retryable`.',
];

function contextLines(request: TaskRequest, inGroup: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  for (const entry of request.context) {
    lines.push(`## ${entry.task_id} — ${entry.title} (${entry.status})`);
    lines.push(entry.summary);
    lines.push(`Full result: ${entry.result_path}`);
    lines.push(`Full output: ${entry.output_path}`);
    if (inGroup.has(entry.task_id)) {
      lines.push('(You did this earlier in this same conversation — see above.)');
    } else if (entry.inline !== null) {
      lines.push('', '<upstream_output>', entry.inline, '</upstream_output>');
    } else {
      lines.push('(Output not inlined — read the file above if you need the detail.)');
    }
    lines.push('');
  }
  return lines;
}

function workspaceLines(
  request: TaskRequest,
  memory: string | undefined,
  plural: boolean,
): string[] {
  const lines = [
    '# Workspace',
    '',
    `Working directory: ${request.workspace.cwd}`,
    request.workspace.access === 'read-write'
      ? 'You may create and modify files in this directory.'
      : plural
        ? 'These tasks are read-only. Do not modify any file.'
        : 'This task is read-only. Do not modify any file.',
    '',
  ];
  const trimmed = memory?.trim() ?? '';
  if (trimmed !== '') lines.push(trimmed, '');
  return lines;
}
