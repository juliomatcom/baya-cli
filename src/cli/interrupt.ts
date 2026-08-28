import type { Logger } from "../log/index.js";
import type { Progress } from "../ui/index.js";

/**
 * SIGINT teardown for M1. Extracted so it is testable without a subprocess —
 * an in-process test cannot send itself a real signal without taking the test
 * runner down with it.
 *
 * M2.4 owns the full contract (grace window, SIGTERM → SIGKILL escalation,
 * double-Ctrl-C, `uncaughtException`). What has to be right *already* is the
 * cursor: ora hides it, and an exit that skips this leaves the user's terminal
 * with no visible cursor long after Baya is gone (conventions.md #15).
 */
export interface InterruptDeps {
  progress: Progress;
  logger: Logger;
  /** Live process-group leaders to signal. */
  activePids: () => Iterable<number>;
  killGroup: (pid: number, signal: NodeJS.Signals) => boolean;
  checkpointInterrupted: () => void;
  releaseLock: () => void;
  exit: (code: number) => void;
}

export const SIGINT_EXIT_CODE = 130;

export function createInterruptHandler(deps: InterruptDeps): () => void {
  let firing = false;
  return () => {
    // A second Ctrl+C while teardown is in flight must not re-enter it.
    if (firing) return;
    firing = true;

    // Log before acting, so a crash mid-teardown still leaves evidence.
    deps.logger.warn("signal.received", { signal: "SIGINT" });
    for (const pid of deps.activePids()) {
      deps.logger.warn("process.killed", { pgid: pid, signal: "SIGTERM" });
      deps.killGroup(pid, "SIGTERM");
    }
    deps.checkpointInterrupted();
    deps.logger.warn("run.interrupted", {});
    deps.progress.dispose();
    deps.releaseLock();
    deps.exit(SIGINT_EXIT_CODE);
  };
}
