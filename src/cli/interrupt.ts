import type { Logger } from '../log/index.js';
import type { Progress } from '../ui/index.js';

/**
 * Ctrl+C teardown (execution.md §Interrupts). Extracted so it is testable
 * without a subprocess — an in-process test cannot send itself a real signal
 * without taking the test runner down with it.
 *
 * Contract: log the signal, checkpoint the run `interrupted`, SIGTERM every
 * live process group, wait out a grace window, then SIGKILL whatever the
 * scheduler still lists as live, restore the terminal, release the lock, exit.
 * A second Ctrl+C during the grace window skips the wait and escalates at once.
 * SIGTERM/SIGHUP/`uncaughtException` share this path from the CLI (run.ts,
 * resume.ts), each keeping its own exit code.
 */
export interface InterruptDeps {
  progress: Progress;
  logger: Logger;
  /**
   * Live process-group leaders to signal. Re-read after the grace window, not
   * snapshotted — a provider that exited on SIGTERM has been dropped by the
   * scheduler's `onProcessExit` and must not be SIGKILLed by pid reuse.
   */
  activePids: () => Iterable<number>;
  killGroup: (pid: number, signal: NodeJS.Signals) => boolean;
  checkpointInterrupted: () => void;
  releaseLock: () => void;
  exit: (code: number) => void;
  /** ms-since-epoch clock, injected so the grace window is deterministic under test. */
  clock?: () => number;
  /** Schedules the SIGKILL escalation, injected so tests fire it by hand. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** SIGTERM→SIGKILL grace. Default matches the timeout escalation in src/executor/spawn.ts. */
  graceMs?: number;
}

/** 128 + signal number — the shell convention. `uncaughtException` keeps Node's own 1. */
export const SIGINT_EXIT_CODE = 130;
export const SIGTERM_EXIT_CODE = 143;
export const SIGHUP_EXIT_CODE = 129;
export const UNCAUGHT_EXIT_CODE = 1;

/** Matches `DEFAULT_KILL_GRACE_MS` in src/executor/spawn.ts and execution.md §Interrupts. */
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;

const REAL_SET_TIMER = (fn: () => void, ms: number): unknown => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return handle;
};

export function createInterruptHandler(deps: InterruptDeps): (code?: number) => void {
  const graceMs = deps.graceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
  const clock = deps.clock ?? Date.now;
  const setTimer = deps.setTimer ?? REAL_SET_TIMER;
  const clearTimer =
    deps.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let phase: 'idle' | 'grace' | 'done' = 'idle';
  let graceTimer: unknown;
  let termAt = 0;
  let exitCode = SIGINT_EXIT_CODE;

  const escalate = (): void => {
    if (phase === 'done') return;
    phase = 'done';
    if (graceTimer !== undefined) clearTimer(graceTimer);
    for (const pid of deps.activePids()) {
      deps.logger.warn('process.killed', { pgid: pid, signal: 'SIGKILL' });
      deps.killGroup(pid, 'SIGKILL');
    }
    deps.logger.warn('run.interrupted', { grace_ms: clock() - termAt });
    deps.progress.dispose();
    deps.releaseLock();
    deps.exit(exitCode);
  };

  return (code?: number) => {
    if (phase === 'grace') {
      // A second Ctrl+C while the grace window is open — the user is done
      // waiting, so escalate instead of returning early. The first signal's
      // exit code stands; escalating faster does not change what happened.
      deps.logger.warn('signal.received', { signal: 'SIGINT', escalated: true });
      escalate();
      return;
    }
    if (phase !== 'idle') return;
    phase = 'grace';
    termAt = clock();
    if (code !== undefined) exitCode = code;

    // Log and checkpoint before acting, so a crash mid-teardown still leaves
    // evidence and a resumable run.
    deps.logger.warn('signal.received', { signal: 'SIGINT' });
    deps.checkpointInterrupted();

    let live = 0;
    for (const pid of deps.activePids()) {
      live += 1;
      deps.logger.warn('process.killed', { pgid: pid, signal: 'SIGTERM' });
      deps.killGroup(pid, 'SIGTERM');
    }

    // Nothing in flight — no reason to sit through the grace window.
    if (live === 0) {
      escalate();
      return;
    }
    graceTimer = setTimer(escalate, graceMs);
  };
}

/**
 * Registers SIGINT, SIGTERM, SIGHUP and `uncaughtException` on one teardown
 * handler and returns the function that unregisters all four. Every route runs
 * the same grace-window teardown — SIGTERM the groups, wait, SIGKILL survivors,
 * checkpoint, restore the cursor via `progress.dispose()`, release the lock —
 * and only the exit code differs. An otherwise-fatal crash still reaps its
 * child process groups instead of orphaning them.
 */
export function installInterruptHandlers(deps: InterruptDeps): () => void {
  const teardown = createInterruptHandler(deps);
  const onSigint = (): void => teardown(SIGINT_EXIT_CODE);
  const onSigterm = (): void => teardown(SIGTERM_EXIT_CODE);
  const onSighup = (): void => teardown(SIGHUP_EXIT_CODE);
  const onUncaught = (err: unknown): void => {
    deps.logger.error('run.crashed', {
      message: err instanceof Error ? err.message : String(err),
    });
    teardown(UNCAUGHT_EXIT_CODE);
  };

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  process.on('uncaughtException', onUncaught);

  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('uncaughtException', onUncaught);
  };
}
