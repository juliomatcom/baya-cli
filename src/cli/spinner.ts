import { formatElapsed, type Progress } from '../ui/index.js';
import type { Theme } from '../ui/theme.js';

/**
 * The live line for a group's process, shared by `run` and `resume`.
 *
 * A live line for the whole time a process is out. `claude --output-format
 * json` returns one object at the very end, so between the spawn and the
 * result there is structurally nothing to print and a slow task is
 * indistinguishable from a hung one. The elapsed count is the point — a
 * spinner alone still leaves "how long has this been?" unanswered.
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
  // Held out here so `dispose` can always clear it — an interval left running
  // past a thrown error keeps repainting a line for a run that is over.
  let ticker: NodeJS.Timeout | null = null;
  const dispose = (): void => {
    if (ticker === null) return;
    clearInterval(ticker);
    ticker = null;
  };

  return {
    dispose,
    onGroupStarted: (info) => {
      const lead = info.taskIds[0] ?? '';
      const more =
        info.taskIds.length > 1 ? theme.note(` +${info.taskIds.length - 1}`) : '';
      const who = `${theme.provider(info.provider)}${info.model ? theme.note(` ${info.model}`) : ''}`;
      const label = `${theme.taskId(lead)}${more} ${who}`;
      const startedAt = Date.now();
      const paint = (): void =>
        progress.update(
          `${label} ${theme.note(`· ${formatElapsed(Date.now() - startedAt)}`)}`,
        );
      dispose();
      progress.start(`${label} ${theme.note('· 0s')}`);
      ticker = setInterval(paint, 1000);
      // Never hold the event loop open on account of a cosmetic line.
      ticker.unref();
    },
  };
}
