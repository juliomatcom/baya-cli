import type { ProviderId, ValidationError } from '../manifest/index.js';
import type { DoneMarker } from './done.js';

/**
 * The planning prompt. The task text is untrusted content (architecture.md
 * trust boundaries) — it is delimited, never interpolated into argv, and the
 * planner's only privilege is naming a provider from a closed enum. The text
 * is any format the user wrote their tasks in: Markdown, plain `.txt`, YAML, …
 */
export interface PlannerPromptOptions {
  taskText: string;
  sourcePath: string;
  maxTasks: number;
  providers: readonly ProviderId[];
  defaultProvider: ProviderId;
  schemaPath: string;
  /**
   * The schema document, for a planner provider that enforces none. Absent
   * means the CLI validates the draft itself and the prompt says so — see the
   * `schema` note in `executor/prompt.ts` for why a **path** is never given.
   */
  schema?: string;
  /**
   * Lines the task list already marks as finished, found deterministically by
   * `detectDoneMarkers`. Named in the prompt rather than left for the model to
   * notice, because a missed marker re-runs and re-pays for landed work.
   */
  doneMarkers?: readonly DoneMarker[];
}

export function plannerPrompt(options: PlannerPromptOptions): string {
  return [
    "You are Baya's planner. Turn the task list below into an execution DAG.",
    'The task list is freeform text — Markdown, plain text, YAML, or similar.',
    'Read it for intent and extract the discrete units of work it describes.',
    '',
    'Rules:',
    `- Emit at most ${options.maxTasks} tasks. Fewer is better; do not invent work.`,
    '- Each `id` is kebab-case, unique, and matches ^[a-z0-9][a-z0-9-]{0,63}$.',
    '- `instruction` must be a complete, self-contained prompt for a coding agent.',
    '  Upstream results are delivered separately as context — do not restate them.',
    "  Never point a task at the task list, the plan, or Baya's own files: an agent",
    '  told its answer is "in the task list" will go and search the repository for',
    '  it. Whatever a task needs from the list must be written into `instruction`.',
    '- `depends_on` lists task ids that must succeed first. The graph must be acyclic.',
    '- `access` is what the task needs permission to **do**, not what it edits.',
    '  Use `"read-write"` if the task modifies the workspace **or runs anything that**',
    '  **writes as a side effect** — a test suite, a build, a linter, an install all',
    '  drop caches and temp files, and a task that cannot act cannot verify its own',
    '  work. Use `"read-only"` only for pure reading: reviewing code, summarizing,',
    '  answering a question about the repo.',
    `- \`provider\` is one of: ${options.providers.join(', ')}, or null for the run default (${options.defaultProvider}).`,
    '- `model`: if a task names or points at a specific model — "use sonnet",',
    '  "on gpt-5.6-luna", or a trailing "- luna" / "(terra)" naming one — put that',
    '  exact string in `model` and leave `provider` null; Baya resolves it. Different',
    '  tasks may name different models. Otherwise `model` is null. Never pair an',
    '  explicit `provider` with a model that belongs to a different provider.',
    '- Order matters only through `depends_on`. Independent work should stay independent',
    '  so it can run in parallel.',
    '- **Skip work the list marks as already done** — a ticked checkbox (`[x]`), a',
    '  `[done]` / `(complete)` tag, a trailing "— done" / "| done", or a ✅. Emit no',
    '  task for it. Other tasks may still depend on what it produced, so read it for',
    '  context and never re-derive it as new work. A line that says work is *not*',
    '  done is not a marker.',
    '',
    ...(options.doneMarkers && options.doneMarkers.length > 0
      ? [
          'These lines are already marked done. Emit no task for any of them:',
          ...options.doneMarkers.map((marker) => `  L${marker.line}: ${marker.text}`),
          '',
        ]
      : []),
    // Never the schema **path**: an agent told where a schema lives will go and
    // read it, and the tool call costs a full context re-send for something the
    // CLI is already enforcing (`--output-schema`). See executor/prompt.ts.
    ...(options.schema === undefined
      ? [
          'Respond with a single JSON object matching the plan-draft contract, which',
          'the CLI you are running in already enforces. Do not open or search for a',
          'schema file.',
        ]
      : [
          'Respond with a single JSON object matching this schema, reproduced here in',
          'full so you do not need to open a file:',
          '',
          '<schema>',
          options.schema.trim(),
          '</schema>',
        ]),
    '',
    `<task_list path="${options.sourcePath}">`,
    options.taskText,
    '</task_list>',
  ].join('\n');
}

/**
 * One repair round per failed attempt. The errors are quoted verbatim: a model
 * told "the graph has a cycle" guesses, whereas one told "cycle: a -> b -> a"
 * fixes the actual edge.
 */
export function repairPrompt(
  previous: string,
  errors: readonly ValidationError[],
  base: string,
): string {
  return [
    'Your previous plan was rejected. Fix it and return the corrected JSON object.',
    '',
    'Errors:',
    ...errors.map((error) => `- ${error.message}`),
    '',
    'Your previous output:',
    previous.slice(0, 8000),
    '',
    '---',
    '',
    base,
  ].join('\n');
}
