import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FileLock,
  defaultIsAlive,
  type FileLockOptions,
} from '../../../src/lock/index.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/lock-holder.mjs', import.meta.url));

let dir: string;
let lockPath: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'baya-lock-xp-'));
  lockPath = join(dir, 'workspace.lock');
});

afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Spawns the holder and resolves once it reports the lock file exists. */
function startHolder(holdMs: number, heartbeatMs: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [FIXTURE, lockPath, String(holdMs), String(heartbeatMs)],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, LOCK_HOLDER_LEAVE_FILE: '1' },
      },
    );
    proc.stdout?.once('data', () => resolve(proc));
    proc.once('error', reject);
    proc.once('exit', (code) =>
      reject(new Error(`holder exited early: ${String(code)}`)),
    );
  });
}

function waitForExit(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
  });
}

function opts(overrides: Partial<FileLockOptions> = {}): FileLockOptions {
  return {
    owner: 'workspace',
    // Deliberately shorter than the holder's heartbeat interval, so the pid
    // check — not a fresh heartbeat — is what keeps the lock alive.
    staleAfterMs: 120,
    heartbeatIntervalMs: 50,
    ...overrides,
  };
}

describe('cross-process locking', () => {
  it('refuses to acquire a lock held by another live process', async () => {
    child = await startHolder(3_000, 300);

    const result = new FileLock(lockPath, opts()).acquire();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.verdict).toBe('live');
      expect(result.holder?.pid).toBe(child.pid);
      expect(result.holder?.owner).toBe('lock-holder-fixture');
    }
  });

  it('never breaks a live lock even while its heartbeat is aging', async () => {
    // Heartbeat every 300ms against a 120ms stale threshold: the lock is
    // regularly "aged" and the live pid is the only thing protecting it.
    child = await startHolder(2_000, 300);

    for (let i = 0; i < 12; i++) {
      expect(new FileLock(lockPath, opts()).acquire().ok).toBe(false);
      await new Promise((r) => setTimeout(r, 60));
    }
  });

  it('reclaims the lock once the holding process is gone', async () => {
    child = await startHolder(150, 50);
    const holderPid = child.pid ?? -1;

    await waitForExit(child);
    // The fixture leaves the file behind, mimicking a crash rather than a
    // clean release.
    expect(existsSync(lockPath)).toBe(true);
    expect(defaultIsAlive(holderPid)).toBe(false);

    await new Promise((r) => setTimeout(r, 150));

    const warnings: string[] = [];
    const lock = new FileLock(
      lockPath,
      opts({
        logger: { warn: (event) => warnings.push(event), debug: () => {} },
      }),
    );
    const result = lock.acquire();

    expect(result.ok).toBe(true);
    expect(warnings).toContain('lock.reclaimed');
    lock.release();
  });

  it('hands the lock to a second holder only after the first releases', () => {
    const a = new FileLock(lockPath, opts());
    const b = new FileLock(lockPath, opts());

    expect(a.acquire().ok).toBe(true);
    expect(b.acquire().ok).toBe(false);

    a.release();

    expect(b.acquire().ok).toBe(true);
    b.release();
  });
});
