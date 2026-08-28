/**
 * Staleness classification for cross-process file locks (recovery.md).
 *
 * Kept pure and injectable so every branch is unit-testable without sleeping,
 * spawning, or touching the clock.
 */

/** What a lock file claims about its holder. */
export interface LockInfo {
  /** Unique per acquisition. Guards against deleting a lock we did not judge. */
  token: string;
  pid: number;
  host: string;
  /** Free-form owner label, e.g. a runId or `"workspace"`. */
  owner: string;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface ClassifyContext {
  now: number;
  isAlive: (pid: number) => boolean;
}

export type LockVerdict = "live" | "stale";

/** Heartbeat age past which we consult the holder's pid. */
export const DEFAULT_STALE_AFTER_MS = 30_000;

/**
 * Never break a live lock: a fresh heartbeat alone proves liveness, and only
 * once it has aged do we ask whether the holder's pid still exists.
 *
 * Known limitation, accepted for v1: if the holder crashes and the OS recycles
 * its pid onto an unrelated process, the lock looks live indefinitely and must
 * be removed by hand. `inspectLock` reports this so `baya doctor` can say so.
 * Erring toward a stuck lock is the right trade — the opposite error corrupts
 * a working tree.
 */
export function classifyLock(
  info: LockInfo,
  ctx: ClassifyContext,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): LockVerdict {
  const age = ctx.now - info.heartbeatAt;

  // A heartbeat from the future means clock skew. Treat it as live: waiting
  // costs time, whereas guessing wrong corrupts a working tree.
  if (age < 0) return "live";
  if (age < staleAfterMs) return "live";

  return ctx.isAlive(info.pid) ? "live" : "stale";
}

/** Structural validation of a parsed lock file. Unknown shapes are not trusted. */
export function isLockInfo(value: unknown): value is LockInfo {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["token"] === "string" &&
    typeof v["pid"] === "number" &&
    typeof v["host"] === "string" &&
    typeof v["owner"] === "string" &&
    typeof v["acquiredAt"] === "number" &&
    typeof v["heartbeatAt"] === "number"
  );
}
