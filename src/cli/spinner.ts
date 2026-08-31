import { formatElapsed, type Progress } from '../ui/index.js';
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
