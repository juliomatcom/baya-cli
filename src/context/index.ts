import type { ContextEntry } from '../manifest/index.js';

/**
 * Context bus v1 (execution.md §Context bus). Turns finished upstream results
 * into the `context[]` of a downstream `task_request`.
 *
 * Pure by design: budgeting is arithmetic over strings, and the cases that
 * break naive prepending — a fan-in of five 40 KB upstreams — are cheap to
 * test here and expensive to test anywhere else.
 */
export type ContextStrategy = 'link-only' | 'truncate';

export const DEFAULT_CONTEXT_BUDGET = 12_000;

export interface ContextBudget {
  /** Total inline chars across all edges. */
  total: number;
  /** Per-edge cap. Defaults to half the total. */
  perEdge: number;
}

export function budgetFrom(total = DEFAULT_CONTEXT_BUDGET): ContextBudget {
  return { total, perEdge: Math.floor(total / 2) };
}

export interface Upstream {
  taskId: string;
  title: string;
  status: string;
  summary: string;
  resultPath: string;
  outputPath: string;
  /** The upstream `output`, already on disk at `outputPath`. */
  output: string;
}

export interface AssembleOptions {
  strategy?: ContextStrategy;
  budget?: ContextBudget;
}

/**
 * Head + tail with an explicit elision marker. A middle-out cut keeps both the
 * shape of the document and its conclusions, which a plain head-truncation
 * loses exactly when it matters.
 */
export function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const marker = (elided: number): string =>
    `\n\n…[${elided} characters elided — full text at the output_path above]…\n\n`;

  // Size against the largest marker this text could produce. `elided` is never
  // above `text.length`, so `marker(elided)` is never longer than this one and
  // the result cannot exceed the limit.
  const widest = marker(text.length);
  if (widest.length >= limit) {
    // No room for even the marker. Say what happened, clipped — silently
    // returning a fragment that reads like a whole document is worse.
    return widest.slice(0, limit);
  }

  const room = limit - widest.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  const elided = text.length - head - tail;

  return [
    text.slice(0, head),
    marker(elided),
    tail === 0 ? '' : text.slice(text.length - tail),
  ].join('');
}

/**
 * Every entry always carries `summary` plus absolute paths; `inline` carries
 * the text only when it fits. These providers are agentic — they open files —
 * so a path is an unbounded, ~40-token reference, while inlining 40 KB costs
 * ~10k tokens and still truncates.
 */
export function assembleContext(
  upstreams: readonly Upstream[],
  options: AssembleOptions = {},
): ContextEntry[] {
  const strategy = options.strategy ?? 'link-only';
  const budget = options.budget ?? budgetFrom();
  let spent = 0;

  return upstreams.map((upstream) => {
    const base = {
      task_id: upstream.taskId,
      title: upstream.title,
      status: upstream.status,
      summary: upstream.summary,
      result_path: upstream.resultPath,
      output_path: upstream.outputPath,
    };

    const remaining = Math.max(0, budget.total - spent);
    const allowance = Math.min(budget.perEdge, remaining);

    if (allowance === 0 || upstream.output.length === 0) {
      return { ...base, inline: null };
    }

    // link-only inlines only what fits whole. Half a document with no marker
    // reads as a complete one, which is worse than a path.
    if (strategy === 'link-only') {
      if (upstream.output.length > allowance) return { ...base, inline: null };
      spent += upstream.output.length;
      return { ...base, inline: upstream.output };
    }

    const inline = truncateMiddle(upstream.output, allowance);
    spent += inline.length;
    return { ...base, inline };
  });
}
