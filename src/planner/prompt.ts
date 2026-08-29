import type { ProviderId, ValidationError } from "../manifest/index.js";

/**
 * The planning prompt. The Markdown is untrusted content (architecture.md
 * trust boundaries) — it is delimited, never interpolated into argv, and the
 * planner's only privilege is naming a provider from a closed enum.
 */
export interface PlannerPromptOptions {
  markdown: string;
  sourcePath: string;
  maxTasks: number;
  providers: readonly ProviderId[];
  defaultProvider: ProviderId;
  schemaPath: string;
}

export function plannerPrompt(options: PlannerPromptOptions): string {
  return [
    "You are Baya's planner. Turn the task list below into an execution DAG.",
    "",
    "Rules:",
    `- Emit at most ${options.maxTasks} tasks. Fewer is better; do not invent work.`,
    "- Each `id` is kebab-case, unique, and matches ^[a-z0-9][a-z0-9-]{0,63}$.",
    "- `instruction` must be a complete, self-contained prompt for a coding agent.",
    "  Upstream results are delivered separately as context — do not restate them.",
    "- `depends_on` lists task ids that must succeed first. The graph must be acyclic.",
    "- `writes` is true only if the task creates or modifies files.",
    `- \`provider\` is one of: ${options.providers.join(", ")}, or null for the run default (${options.defaultProvider}).`,
    '- `model`: if a task names or points at a specific model — "use sonnet",',
    '  "on gpt-5.6-luna", or a trailing "- luna" / "(terra)" naming one — put that',
    "  exact string in `model` and leave `provider` null; Baya resolves it. Different",
    "  tasks may name different models. Otherwise `model` is null. Never pair an",
    "  explicit `provider` with a model that belongs to a different provider.",
    "- Order matters only through `depends_on`. Independent work should stay independent",
    "  so it can run in parallel.",
    "",
    `Respond with a single JSON object matching the schema at ${options.schemaPath}.`,
    "",
    `<task_list path="${options.sourcePath}">`,
    options.markdown,
    "</task_list>",
  ].join("\n");
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
    "Your previous plan was rejected. Fix it and return the corrected JSON object.",
    "",
    "Errors:",
    ...errors.map((error) => `- ${error.message}`),
    "",
    "Your previous output:",
    previous.slice(0, 8000),
    "",
    "---",
    "",
    base,
  ].join("\n");
}
