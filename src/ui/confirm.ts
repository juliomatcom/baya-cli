import { confirm } from '@inquirer/prompts';

/**
 * The plan gate (cli.md §Flags, `--yes`). The last point at which a run costs
 * nothing, so it is worth a keystroke.
 *
 * **Never hangs.** `--yes` and a non-TTY both resolve without touching stdin;
 * a prompt that blocks a pipe is the worst failure mode in the system
 * (conventions.md #13).
 */
export interface ConfirmPlanOptions {
  yes: boolean;
  stdinIsTty: boolean;
  /** Stopped before prompting: a live spinner and a prompt corrupt each other. */
  beforePrompt?: () => void;
  message?: string;
}

export type ConfirmOutcome =
  | { decision: 'confirmed'; reason: 'flag' | 'answered' }
  | { decision: 'rejected' }
  | { decision: 'blocked'; message: string };

export async function confirmPlan(options: ConfirmPlanOptions): Promise<ConfirmOutcome> {
  if (options.yes) return { decision: 'confirmed', reason: 'flag' };
  if (!options.stdinIsTty) {
    return {
      decision: 'blocked',
      message:
        'stdin is not a TTY, so the plan gate cannot be answered. Pass --yes to run unattended, or --dry-run to just see the plan.',
    };
  }

  options.beforePrompt?.();
  const answer = await confirm({
    message: options.message ?? 'Run this plan?',
    default: true,
  });
  return answer
    ? { decision: 'confirmed', reason: 'answered' }
    : { decision: 'rejected' };
}
