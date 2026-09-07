import { createBlock, formatElapsed, type Block, type Progress } from '../ui/index.js';
import type { Theme } from '../ui/theme.js';

/**
 * `<label> · 12s`, repainted once a second until the returned stop is called.
 *
 * Anything that makes the user wait on a provider goes through here. A spinner
 * alone leaves "how long has this been?" unanswered, and every provider call
 * baya makes is opaque until it returns — planning included, which is a single
 * provider call and the first thing a run does.
 *
 * The caller owns the stop, and must call it on the error path too: an
 * interval left running past a thrown error keeps repainting a line for a run
 * that is over.
 */
export function startElapsedLine(
  progress: Progress,
  theme: Theme,
  label: string,
): () => void {
  const startedAt = Date.now();
  progress.start(`${label} ${theme.note('· 0s')}`);
  const ticker = setInterval(() => {
    progress.update(
      `${label} ${theme.note(`· ${formatElapsed(Date.now() - startedAt)}`)}`,
    );
  }, 1000);
  // Never hold the event loop open on account of a cosmetic line.
  ticker.unref();
  return () => clearInterval(ticker);
}

/**
 * The live line for a group's process, shared by `run` and `resume`.
 *
 * A live line for the whole time a process is out. `claude --output-format
 * json` returns one object at the very end, so between the spawn and the
 * result there is structurally nothing to print and a slow task is
 * indistinguishable from a hung one. The elapsed count is the point.
 */
export interface GroupSpinner {
  onGroupStarted: (info: {
    taskIds: string[];
    provider: string;
    model: string | null;
  }) => void;
  /** Stops the repaint interval. Safe to call repeatedly and after the run. */
  dispose: () => void;
}

export function createGroupSpinner(deps: {
  progress: Progress;
  theme: Theme;
}): GroupSpinner {
  const { progress, theme } = deps;
  // Held out here so `dispose` can always stop it — an interval left running
  // past a thrown error keeps repainting a line for a run that is over.
  let stopLine: (() => void) | null = null;
  const dispose = (): void => {
    stopLine?.();
    stopLine = null;
  };

  return {
    dispose,
    onGroupStarted: (info) => {
      const lead = info.taskIds[0] ?? '';
      const more =
        info.taskIds.length > 1 ? theme.note(` +${info.taskIds.length - 1}`) : '';
      const who = `${theme.provider(info.provider)}${info.model ? theme.note(` ${info.model}`) : ''}`;
      dispose();
      stopLine = startElapsedLine(progress, theme, `${theme.taskId(lead)}${more} ${who}`);
    },
  };
}

/**
 * The live block for a consensus round: one row per in-flight provider process
 * (specs/002-ai-consensus §11). Reviewers run in parallel, so the unit is the
 * block, not a line.
 */
export interface RoundSpinner {
  started: (provider: string, model: string | null, round: number, kind: string) => void;
  /** Drops the row. The call is not over for the reader until `completed`. */
  finished: (provider: string) => void;
  /**
   * The line that stays. The block only ever holds what is still running, so
   * anything that finished has to be written out or it vanishes with its row.
   */
  completed: (provider: string, outcome: { ok: boolean; detail: string }) => void;
  dispose: () => void;
}

export function createRoundSpinner(deps: {
  progress: Progress;
  theme: Theme;
  /** The CLI's own stderr. Defaulting to `process.stderr` would write past a
   * caller that supplied its own stream — including every test. */
  stream: NodeJS.WritableStream;
  block?: Block;
}): RoundSpinner {
  const block =
    deps.block ??
    createBlock({
      theme: deps.theme,
      stream: deps.stream,
      disabled: !deps.progress.enabled,
    });

  // Elapsed has to outlive the row: the completion line is written after the
  // answer is parsed, by which time the row is already gone.
  const startedAt = new Map<string, number>();
  const models = new Map<string, string | null>();

  return {
    started: (provider, model, round, kind) => {
      block.header(round > 0 ? `round ${String(round)}` : 'reading the artifact');
      startedAt.set(provider, Date.now());
      models.set(provider, model);
      block.add({
        key: provider,
        provider,
        model,
        detail: kind === 'review' ? 'reviewing' : kind === 'draft' ? 'drafting' : kind,
      });
    },
    finished: (provider) => block.remove(provider),
    completed: (provider, outcome) => {
      const began = startedAt.get(provider);
      const elapsed = began === undefined ? '' : formatElapsed(Date.now() - began);
      const model = models.get(provider) ?? null;
      const glyph = deps.theme.status(outcome.ok ? 'ok' : 'fail');
      block.write(
        `  ${glyph} ${deps.theme.provider(provider.padEnd(9))}${deps.theme.note((model ?? '').padEnd(24))} ${elapsed.padStart(6)}  ${outcome.detail}`,
      );
    },
    dispose: () => block.dispose(),
  };
}
