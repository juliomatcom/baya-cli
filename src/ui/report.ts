import { join } from 'node:path';
import type { Manifest, Note, NoteSeverity } from '../manifest/index.js';
import type { Failure, RunState } from '../executor/state.js';
import type { Theme } from './theme.js';
import { formatCost, formatDuration, formatTokens, wrap } from './text.js';

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
  failure: RunState['tasks'][string]['failure'];
  output_path: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface RunReport {
  run_id: string;
  status: RunState['status'];
  source: RunState['source'];
  started_at: string;
  ended_at: string;
  duration_ms: number;
  totals: RunState['totals'];
  /**
   * Provider processes actually spawned (execution.md §Grouping). Distinct
   * from the task count, and the number that tracks what a run cost to start:
   * grouping is only doing its job when this is below it.
   */
  processes: number;
  tasks: ReportTask[];
  /** Every note across every task, `action_required` first. */
  flagged: FlaggedNote[];
  /** Absolute run directory — where `state.json`, the log and `tasks/` live. */
  run_dir: string;
  /** Absolute `tasks/` directory. Every task's `output.md` sits one level in. */
  outputs_path: string;
  /** How to pick the run back up, or `null` when nothing is left to run. */
  next: NextStep | null;
  exit_code: number;
}

/**
 * The way back into an unfinished run.
 *
 * A run that stops on something the user has to fix — no network, a spent
 * allowance, a denied permission — leaves them holding a failure and no way
 * forward. `baya resume <runId>` has always existed; the report never said so,
 * so the obvious move was to re-run the whole task list and pay again for
 * every task that already succeeded.
 *
 * `cause` names what to fix, `command` is the line to paste once it is fixed,
 * and `scope` says what resuming will and will not re-run. `--json` carries the
 * same three, so a pipe is not left guessing either.
 */
export interface NextStep {
  cause: string;
  command: string;
  scope: string;
}

const SEVERITY_ORDER: Record<NoteSeverity, number> = {
  action_required: 0,
  warn: 1,
  info: 2,
};

/**
 * One line on what to fix, per `failure.kind` (recovery.md §Failure taxonomy).
 *
 * Support, not the headline: the command above it is what the reader needs,
 * and this says what to do before pasting it. Kept to a single line each, and
 * never naming a flag Baya does not have — a wrong flag costs more trust than
 * a vague sentence.
 */
const CAUSE_BY_KIND: Record<Failure['kind'], string> = {
  network:
    'The network was unreachable — check connectivity, a VPN or proxy, and that the registry or API the task needs is up.',
  quota:
    "The provider's allowance is spent — wait for the reset, or add `--provider <id>` to finish the rest elsewhere.",
  rate_limit:
    'The provider is rate-limiting — give it a few minutes, or add `--provider <id>` to finish elsewhere.',
  auth: 'The provider rejected the credentials — sign in again, or fix the API key.',
  permission:
    'A task was denied a permission it needed — widen its access, or re-run with `--dangerously-allow-all` if that is what you intend.',
  timeout: 'A task ran past its runtime limit — split it into smaller tasks.',
  schema:
    'A provider returned a result Baya could not read — nothing to fix on your side.',
  crash:
    'The provider CLI exited badly — its stderr log is under the run directory above.',
  interrupted: 'Nothing to fix: the run was interrupted.',
};

/** Highest-priority kind first: the ones a person must act on before a retry can work. */
const KIND_PRIORITY: readonly Failure['kind'][] = [
  'quota',
  'auth',
  'permission',
  'network',
  'timeout',
  'rate_limit',
  'schema',
  'crash',
  'interrupted',
];

/**
 * The dominant failure, not merely the first: one `quota` halts a whole run
 * and every other task's failure is downstream of it, so reporting whichever
 * task happened to be listed first would name a symptom as the cause.
 */
function dominantKind(state: RunState): Failure['kind'] | null {
  const kinds = new Set(
    Object.values(state.tasks)
      .map((entry) => entry.failure?.kind)
      .filter((kind): kind is Failure['kind'] => kind !== undefined && kind !== null),
  );
  return KIND_PRIORITY.find((kind) => kinds.has(kind)) ?? null;
}

/**
 * `null` when the run finished — a clean run must not end on a line about
 * recovering from something.
 */
export function nextStepFor(state: RunState): NextStep | null {
  const { totals } = state;
  // `pending`/`running` are zero at the end of a run that ran to completion —
  // but not after a Ctrl+C, which can leave tasks that never started. A resume
  // re-runs those too (recovery.md §Resume), so they count as unfinished here
  // or an interrupted run gets a block that promises to re-run nothing.
  const unfinished =
    totals.failed + totals.skipped + totals.parked + totals.pending + totals.running;
  if (unfinished === 0) return null;

  const kind = dominantKind(state);
  const cause =
    kind !== null
      ? CAUSE_BY_KIND[kind]
      : state.status === 'interrupted'
        ? CAUSE_BY_KIND.interrupted
        : // A parked task asked a question rather than failing; the answer is
          // the thing to supply, and the question is in the task's own output.
          'A task asked a question — its output above has it.';

  const rerun: string[] = [];
  if (totals.failed > 0) rerun.push(`${totals.failed} failed`);
  if (totals.skipped > 0) rerun.push(`${totals.skipped} skipped`);
  if (totals.parked > 0) rerun.push(`${totals.parked} parked`);
  const unstarted = totals.pending + totals.running;
  if (unstarted > 0) rerun.push(`${unstarted} unfinished`);
  const scope =
    totals.succeeded > 0
      ? `Picks up where this stopped: re-runs ${rerun.join(' and ')}, keeps the ${totals.succeeded} that succeeded.`
      : `Picks up where this stopped: re-runs ${rerun.join(' and ')}.`;

  return { cause, command: `baya resume ${state.run_id}`, scope };
}

export function buildReport(
  state: RunState,
  manifest: Manifest,
  options: { runDir: string; summaries?: ReadonlyMap<string, string> },
): RunReport {
  const titles = new Map(manifest.tasks.map((task) => [task.id, task.title]));

  const tasks: ReportTask[] = manifest.tasks.map((task) => {
    const entry = state.tasks[task.id];
    return {
      id: task.id,
      title: task.title,
      state: entry?.state ?? 'pending',
      provider: entry?.provider ?? null,
      duration_ms: entry?.duration_ms ?? null,
      summary: options.summaries?.get(task.id) ?? '',
      notes: entry?.notes ?? [],
      files_changed: entry?.files_changed ?? [],
      failure: entry?.failure ?? null,
      output_path: entry?.artifacts['output'] ?? null,
      cost_usd: entry?.cost_usd ?? 0,
      input_tokens: entry?.input_tokens ?? 0,
      output_tokens: entry?.output_tokens ?? 0,
    };
  });

  const flagged: FlaggedNote[] = tasks
    .flatMap((task) => task.notes.map((note) => ({ ...note, task_id: task.id })))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // A task only spawned if it reached `running`, which is what stamps
  // `started_at`. `skipped` tasks, and tasks whose provider could not be
  // resolved, never started a process and must not be counted as one.
  const processes = new Set(
    Object.entries(state.tasks)
      .filter(([, entry]) => entry.started_at !== null)
      .map(([id, entry]) => entry.group_id ?? id),
  ).size;

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
    processes,
    tasks: tasks.map((task) => ({ ...task, title: titles.get(task.id) ?? task.title })),
    flagged,
    run_dir: options.runDir,
    outputs_path: join(options.runDir, 'tasks'),
    next: nextStepFor(state),
    exit_code: exitCodeFor(state),
  };
}

/** 0 all succeeded · 1 any failed · 130 interrupted (cli.md §Exit codes). */
export function exitCodeFor(state: RunState): number {
  if (state.status === 'interrupted') return 130;
  if (state.totals.failed > 0) return 1;
  // A parked task means the run did not finish, so it cannot report success.
  if (state.totals.parked > 0 || state.totals.skipped > 0) return 1;
  return 0;
}

export function renderReport(report: RunReport, theme: Theme, width = 100): string {
  const lines: string[] = [''];
  const { totals } = report;

  // The outcome counts carry their own color; `succeeded` was the only one
  // left plain, so the line used to color bad news and nothing else.
  const parts = [
    totals.succeeded > 0
      ? theme.ok(`${totals.succeeded} succeeded`)
      : theme.note(`${totals.succeeded} succeeded`),
  ];
  if (totals.failed > 0) parts.push(theme.fail(`${totals.failed} failed`));
  if (totals.skipped > 0) parts.push(theme.skip(`${totals.skipped} skipped`));
  if (totals.parked > 0) parts.push(theme.park(`${totals.parked} parked`));

  // Graded on how much of the run actually landed, not on whether anything
  // threw: a run with nothing `failed` but half its tasks `skipped` or `parked`
  // did not complete, and a green badge over it would be the report lying about
  // the one thing a glance is for.
  //
  // `paused` is its own outcome and outranks the succeeded/total grade. A task
  // that asked a question did exactly what the protocol asks of it — reporting
  // that as a failure blames the agent for the one behavior escalation exists
  // to produce, and hides the real state: the run is waiting on a human.
  const total = report.tasks.length;
  const outcome: 'ok' | 'warn' | 'fail' | 'paused' =
    total === 0 || totals.succeeded === total
      ? 'ok'
      : totals.failed === 0 && totals.parked > 0
        ? 'paused'
        : totals.succeeded === 0
          ? 'fail'
          : 'warn';
  const headline =
    outcome === 'ok'
      ? 'Run complete'
      : outcome === 'paused'
        ? 'Run paused'
        : outcome === 'fail'
          ? 'Run failed'
          : 'Run finished';
  // A paused run is unfinished, not wrong: it wears the warn badge, with the
  // pause glyph rather than the warning one.
  const badgeToken = outcome === 'paused' ? 'warn' : outcome;
  const glyph = outcome === 'paused' ? theme.glyphs.park : theme.glyphs[outcome];
  // codex and claude report tokens, not dollars — show what we actually have.
  // The `$` figure stays only when a provider gave us one (cli.md: no fabricated
  // cost). See spec §Non-goals — cost accounting is v1.1.
  const tokens = (totals.input_tokens ?? 0) + (totals.output_tokens ?? 0);
  const meter: string[] = [];
  // Sits with the cost meters, not the task counts, because that is what it
  // is: every process re-pays a CLI's startup. Suppressed for a single task,
  // where "1 process" only restates the line already above it.
  if (report.tasks.length > 1 && report.processes > 0) {
    meter.push(`${report.processes} ${report.processes === 1 ? 'process' : 'processes'}`);
  }
  if (tokens > 0) meter.push(`${formatTokens(tokens)} tokens`);
  if (totals.cost_usd > 0) meter.push(formatCost(totals.cost_usd));
  // Hierarchy, loudest first: a filled badge for the outcome, colored counts
  // for what happened, and the meters dimmed — they are reference numbers, not
  // the news. Without the dimming the badge competes with a row of equals.
  const badge = theme.badge(badgeToken, ` ${glyph} ${headline} `);
  const meters = [formatDuration(report.duration_ms), ...meter];
  lines.push(`  ${badge} ${parts.join(' · ')} ${theme.note(`· ${meters.join(' · ')}`)}`);

  if (report.flagged.length > 0) {
    lines.push('', `  ${theme.taskId('Flagged')}`);
    for (const note of report.flagged) {
      const glyph =
        note.severity === 'action_required'
          ? theme.status('action')
          : note.severity === 'warn'
            ? theme.status('warn')
            : theme.status('note');
      const rows = wrap(note.message, width - 24);
      lines.push(
        `    ${glyph} ${theme.taskId(note.task_id.padEnd(14))} ${rows[0] ?? ''}`,
      );
      for (const row of rows.slice(1)) lines.push(`      ${' '.repeat(15)} ${row}`);
    }
  }

  // The path a reader can actually open. A `<id>` placeholder made them
  // reconstruct it by hand, so a single-task run names its one file outright
  // and a larger run names the directory that holds them all.
  const written = report.tasks.filter((task) => task.output_path !== null);
  const outputs =
    written.length === 1 && written[0] !== undefined
      ? join(report.run_dir, written[0].output_path as string)
      : report.outputs_path;
  lines.push('', `  ${theme.note('Outputs')}   ${outputs}`);

  // Last, because it is what the reader does next. A failed run that ends on a
  // path and nothing else leaves "so now what?" as an exercise.
  if (report.next !== null) {
    const indent = ' '.repeat(12);
    // The command comes first and undimmed — it is the whole point of the
    // block, and the one line here meant to be copied. Leading with the
    // diagnosis instead buried it, and a reader who already knows what broke
    // still has to hunt for the way back in. `taskId` is the theme's plain
    // bold, the same token the `Flagged` heading above uses.
    lines.push(
      '',
      `  ${theme.note('Next'.padEnd(7))}   ${theme.taskId(report.next.command)}`,
    );
    for (const row of wrap(report.next.scope, width - 14)) {
      lines.push(`${indent}${theme.note(row)}`);
    }
    for (const row of wrap(report.next.cause, width - 14)) {
      lines.push(`${indent}${theme.note(row)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
