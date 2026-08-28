import type { Manifest, Note, NoteSeverity } from "../manifest/index.js";
import type { RunState } from "../executor/state.js";
import type { Theme } from "./theme.js";
import { formatCost, formatDuration, formatTokens, wrap } from "./text.js";

/**
 * End-of-run report (cli.md §End-of-run report).
 *
 * The **Flagged** section is the point of the whole `notes[]` design: an agent
 * that says "done, but this migration locks the table" must not have that die
 * unread in a `result.json`. It prints last because it is the thing most
 * likely to matter, and it is omitted entirely when there is nothing to say.
 *
 * `--json` carries the same data, so nothing terminal-only is lost to a pipe.
 */
export interface FlaggedNote extends Note {
  task_id: string;
}

export interface ReportTask {
  id: string;
  title: string;
  state: string;
  provider: string | null;
  duration_ms: number | null;
  summary: string;
  notes: Note[];
  files_changed: string[];
  failure: RunState["tasks"][string]["failure"];
  output_path: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface RunReport {
  run_id: string;
  status: RunState["status"];
  source: RunState["source"];
  started_at: string;
  ended_at: string;
  duration_ms: number;
  totals: RunState["totals"];
  tasks: ReportTask[];
  /** Every note across every task, `action_required` first. */
  flagged: FlaggedNote[];
  outputs_path: string;
  exit_code: number;
}

const SEVERITY_ORDER: Record<NoteSeverity, number> = {
  action_required: 0,
  warn: 1,
  info: 2,
};

export function buildReport(
  state: RunState,
  manifest: Manifest,
  options: { outputsPath: string; summaries?: ReadonlyMap<string, string> },
): RunReport {
  const titles = new Map(manifest.tasks.map((task) => [task.id, task.title]));

  const tasks: ReportTask[] = manifest.tasks.map((task) => {
    const entry = state.tasks[task.id];
    return {
      id: task.id,
      title: task.title,
      state: entry?.state ?? "pending",
      provider: entry?.provider ?? null,
      duration_ms: entry?.duration_ms ?? null,
      summary: options.summaries?.get(task.id) ?? "",
      notes: entry?.notes ?? [],
      files_changed: entry?.files_changed ?? [],
      failure: entry?.failure ?? null,
      output_path: entry?.artifacts["output"] ?? null,
      cost_usd: entry?.cost_usd ?? 0,
      input_tokens: entry?.input_tokens ?? 0,
      output_tokens: entry?.output_tokens ?? 0,
    };
  });

  const flagged: FlaggedNote[] = tasks
    .flatMap((task) => task.notes.map((note) => ({ ...note, task_id: task.id })))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const startedAt = Date.parse(state.started_at);
  const endedAt = Date.parse(state.updated_at);

  return {
    run_id: state.run_id,
    status: state.status,
    source: state.source,
    started_at: state.started_at,
    ended_at: state.updated_at,
    duration_ms:
      Number.isFinite(startedAt) && Number.isFinite(endedAt)
        ? Math.max(0, endedAt - startedAt)
        : 0,
    totals: state.totals,
    tasks: tasks.map((task) => ({ ...task, title: titles.get(task.id) ?? task.title })),
    flagged,
    outputs_path: options.outputsPath,
    exit_code: exitCodeFor(state),
  };
}

/** 0 all succeeded · 1 any failed · 130 interrupted (cli.md §Exit codes). */
export function exitCodeFor(state: RunState): number {
  if (state.status === "interrupted") return 130;
  if (state.totals.failed > 0) return 1;
  // A parked task means the run did not finish, so it cannot report success.
  if (state.totals.parked > 0 || state.totals.skipped > 0) return 1;
  return 0;
}

export function renderReport(report: RunReport, theme: Theme, width = 100): string {
  const lines: string[] = [""];
  const { totals } = report;

  const parts = [`${totals.succeeded} succeeded`];
  if (totals.failed > 0) parts.push(theme.fail(`${totals.failed} failed`));
  if (totals.skipped > 0) parts.push(theme.skip(`${totals.skipped} skipped`));
  if (totals.parked > 0) parts.push(theme.park(`${totals.parked} parked`));

  const headline = report.totals.failed > 0 ? "Run finished" : "Run complete";
  // codex and claude report tokens, not dollars — show what we actually have.
  // The `$` figure stays only when a provider gave us one (cli.md: no fabricated
  // cost). See spec §Non-goals — cost accounting is v1.1.
  const tokens = (totals.input_tokens ?? 0) + (totals.output_tokens ?? 0);
  const meter: string[] = [];
  if (tokens > 0) meter.push(`${formatTokens(tokens)} tokens`);
  if (totals.cost_usd > 0) meter.push(formatCost(totals.cost_usd));
  const meterTail = meter.length > 0 ? ` · ${meter.join(" · ")}` : "";
  lines.push(
    `  ${theme.taskId(headline)} · ${parts.join(" · ")} · ${formatDuration(report.duration_ms)}${meterTail}`,
  );

  if (report.flagged.length > 0) {
    lines.push("", `  ${theme.taskId("Flagged")}`);
    for (const note of report.flagged) {
      const glyph =
        note.severity === "action_required"
          ? theme.status("action")
          : note.severity === "warn"
            ? theme.status("warn")
            : theme.status("note");
      const rows = wrap(note.message, width - 24);
      lines.push(
        `    ${glyph} ${theme.taskId(note.task_id.padEnd(14))} ${rows[0] ?? ""}`,
      );
      for (const row of rows.slice(1)) lines.push(`      ${" ".repeat(15)} ${row}`);
    }
  }

  lines.push("", `  ${theme.note("Outputs")}   ${report.outputs_path}`, "");
  return lines.join("\n");
}
