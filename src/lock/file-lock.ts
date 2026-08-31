import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import {
  DEFAULT_STALE_AFTER_MS,
  classifyLock,
  isLockInfo,
  type LockInfo,
  type LockVerdict,
} from './classify.js';

export interface LockLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
}

export interface FileLockOptions {
  /** Label recorded in the lock file, e.g. a runId or `"workspace"`. */
  owner: string;
  staleAfterMs?: number;
  /** Must be comfortably below `staleAfterMs`. */
  heartbeatIntervalMs?: number;
  logger?: LockLogger;
  /** Injectable for tests. */
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

export type AcquireResult =
  | { ok: true; token: string }
  | { ok: false; holder: LockInfo | null; verdict: LockVerdict | 'unreadable' };

export type InspectResult =
  | { state: 'free' }
  | { state: 'held'; verdict: LockVerdict; info: LockInfo }
  | { state: 'unreadable' };

const DEFAULT_HEARTBEAT_MS = 5_000;

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

function readInfo(path: string): LockInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isLockInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The advisory lock behind "one Baya per directory" (recovery.md). Taken once
 * at startup against `.baya/baya.lock` and held for the process lifetime, so a
 * second Baya in the same working tree is refused rather than left to fight
 * over the same files.
 *
 * It lives in the filesystem because the processes it coordinates are separate
 * — an in-memory mutex would not see them. Writer serialization *within* one
 * run needs no file at all; that is a scheduler concern.
 *
 * Mutual exclusion rests on `open(O_CREAT|O_EXCL)`, which the kernel makes
 * atomic: exactly one racing process creates the file, the rest get EEXIST.
 * Reclaiming a crashed holder's lock is layered on that same primitive rather
 * than replacing it.
 *
 * `acquire` never waits — a conflicting Baya is an error to report, not a
 * queue to join.
 */
export class FileLock {
  private readonly path: string;
  private readonly owner: string;
  private readonly staleAfterMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly logger: LockLogger | undefined;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;

  private timer: NodeJS.Timeout | undefined;
  private held: LockInfo | undefined;
  private exitHook: (() => void) | undefined;

  constructor(path: string, options: FileLockOptions) {
    this.path = path;
    this.owner = options.owner;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? defaultIsAlive;

    if (this.heartbeatIntervalMs >= this.staleAfterMs) {
      throw new RangeError(
        `heartbeatIntervalMs (${this.heartbeatIntervalMs}) must be below staleAfterMs (${this.staleAfterMs}), or a healthy holder would be judged stale`,
      );
    }
  }

  /** Create the lock iff it does not exist. Null on EEXIST. */
  private tryCreate(): LockInfo | null {
    const ts = this.now();
    const info: LockInfo = {
      token: randomUUID(),
      pid: process.pid,
      host: hostname(),
      owner: this.owner,
      acquiredAt: ts,
      heartbeatAt: ts,
    };

    mkdirSync(dirname(this.path), { recursive: true });
    let fd: number;
    try {
      fd = openSync(this.path, 'wx');
    } catch (err) {
      if (isErrno(err, 'EEXIST')) return null;
      throw err;
    }
    try {
      writeSync(fd, `${JSON.stringify(info)}\n`);
    } finally {
      closeSync(fd);
    }
    return info;
  }

  /**
   * Clear a lock judged dead, then let `tryCreate` arbitrate.
   *
   * We re-read immediately before unlinking and require the token to be
   * unchanged, so we never delete a lock other than the one we judged. The
   * remaining window is microseconds wide and losing it is harmless — the
   * O_EXCL create is still the arbiter, so a racing reclaimer gets EEXIST and
   * re-evaluates. What this rules out is the damaging case: unlinking a fresh
   * lock someone else took while we deliberated.
   */
  private tryReclaim(judged: LockInfo): boolean {
    const current = readInfo(this.path);
    if (current === null || current.token !== judged.token) return false;

    this.logger?.warn('lock.reclaimed', {
      path: this.path,
      stale_pid: judged.pid,
      stale_owner: judged.owner,
      heartbeat_age_ms: this.now() - judged.heartbeatAt,
    });

    try {
      unlinkSync(this.path);
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err;
    }
    return true;
  }

  /** One attempt. Never blocks; callers retry on their own schedule. */
  acquire(): AcquireResult {
    if (this.held) {
      throw new Error(`lock already held by this instance: ${this.path}`);
    }

    const created = this.tryCreate();
    if (created) {
      this.onAcquired(created);
      return { ok: true, token: created.token };
    }

    const info = readInfo(this.path);
    // An unparseable lock is never removed automatically — we cannot tell
    // whether its holder is alive. `baya doctor` reports the path to delete.
    if (info === null) return { ok: false, holder: null, verdict: 'unreadable' };

    const verdict = classifyLock(
      info,
      { now: this.now(), isAlive: this.isAlive },
      this.staleAfterMs,
    );
    if (verdict === 'live') return { ok: false, holder: info, verdict };

    if (!this.tryReclaim(info)) return { ok: false, holder: info, verdict };

    const retaken = this.tryCreate();
    if (!retaken) {
      // Another reclaimer won the race; theirs is the live lock now.
      return { ok: false, holder: readInfo(this.path), verdict: 'live' };
    }
    this.onAcquired(retaken);
    return { ok: true, token: retaken.token };
  }

  private onAcquired(info: LockInfo): void {
    this.held = info;

    this.timer = setInterval(() => this.beat(), this.heartbeatIntervalMs);
    // Never let the heartbeat hold the event loop open.
    this.timer.unref();

    // Best-effort release on a clean exit. Signal teardown is M2.4's job.
    this.exitHook = () => this.release();
    process.once('exit', this.exitHook);
  }

  private beat(): void {
    if (!this.held) return;
    const next: LockInfo = { ...this.held, heartbeatAt: this.now() };
    try {
      // Atomic content swap, so a concurrent reader never sees a partial write.
      const tmp = `${this.path}.${next.token}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf8');
      renameSync(tmp, this.path);
      this.held = next;
    } catch (err) {
      // Not fatal: the lock ages toward stale and the next beat may succeed.
      this.logger?.debug('lock.heartbeat_failed', {
        path: this.path,
        error: (err as Error).message,
      });
    }
  }

  /** Idempotent. Never removes a lock file that is no longer ours. */
  release(): void {
    const mine = this.held;
    if (!mine) return;
    this.held = undefined;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook);
      this.exitHook = undefined;
    }

    const current = readInfo(this.path);
    if (current !== null && current.token !== mine.token) {
      // Someone reclaimed us — deleting now would destroy their lock.
      this.logger?.warn('lock.release_skipped', {
        path: this.path,
        reason: 'token_mismatch',
      });
      return;
    }

    try {
      unlinkSync(this.path);
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err;
    }
  }

  isHeld(): boolean {
    return this.held !== undefined;
  }
}

/**
 * Read-only view for `baya doctor`, which must distinguish a crashed run's
 * leftovers from a concurrently running Baya. Never mutates.
 */
export function inspectLock(
  path: string,
  options: {
    staleAfterMs?: number;
    now?: () => number;
    isAlive?: (pid: number) => boolean;
  } = {},
): InspectResult {
  const now = options.now ?? Date.now;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { state: 'free' };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unreadable' };
  }
  if (!isLockInfo(parsed)) return { state: 'unreadable' };

  return {
    state: 'held',
    verdict: classifyLock(
      parsed,
      { now: now(), isAlive: options.isAlive ?? defaultIsAlive },
      options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    ),
    info: parsed,
  };
}
