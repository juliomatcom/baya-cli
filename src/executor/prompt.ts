import type { TaskRequest } from "../manifest/index.js";

/**
 * Renders the prompt an agent CLI actually receives. The `task_request` JSON
 * is the contract and is always written to disk; this is its human-readable
 * envelope, because these CLIs take a prompt, not an API payload.
 *
 * Untrusted task text reaches here (architecture.md trust boundaries) but never
 * argv — it travels by stdin or file, so nothing in it can become a flag.
 */
export function renderPrompt(request: TaskRequest): string {
  const lines: string[] = [
    `You are executing one task in a Baya run (task id: ${request.task.id}).`,
    "",
    `# Task: ${request.task.title}`,
    "",
    request.task.instruction,
    "",
  ];

  if (request.context.length > 0) {
    lines.push("# Upstream results", "");
    for (const entry of request.context) {
      lines.push(`## ${entry.task_id} — ${entry.title} (${entry.status})`);
      lines.push(entry.summary);
      lines.push(`Full result: ${entry.result_path}`);
      lines.push(`Full output: ${entry.output_path}`);
      if (entry.inline !== null) {
        lines.push("", "<upstream_output>", entry.inline, "</upstream_output>");
      } else {
        lines.push("(Output not inlined — read the file above if you need the detail.)");
      }
      lines.push("");
    }
  }

  lines.push(
    "# Workspace",
    "",
    `Working directory: ${request.workspace.cwd}`,
    request.workspace.writable
      ? "You may create and modify files in this directory."
      : "This task is read-only. Do not modify any file.",
    "",
    "# Response contract",
    "",
    `Respond with a single JSON object matching the schema at ${request.response_contract.schema_path}.`,
    "Field notes:",
    "- `summary`: one or two sentences. Its first line is what the user sees in the terminal.",
    "- `output`: the full result as Markdown. Downstream tasks read this.",
    "- `notes`: anything a human should know that is neither a failure nor a blocking",
    "  question — caveats, risks, assumptions you had to make, follow-up work you noticed.",
    "  Use `warn` for something likely wrong or risky, `action_required` for something only",
    "  a human can do, `info` otherwise. Empty array if there is nothing to raise.",
    "- If you cannot proceed without a human decision, set `status` to `needs_input` and",
    "  fill `question.text` rather than guessing.",
    "- On failure, set `status` to `failed` and fill `error.message` and `error.retryable`.",
    "",
    `Deadline: ${request.constraints.max_runtime_s} seconds.`,
  );

  return lines.join("\n");
}
