import {
  DEFAULT_STALE_AFTER_MS,
  classifyLock,
  isLockInfo,
  type LockInfo,
} from '../../../src/lock/classify.js';

const STALE_AFTER = 1_000;

function info(overrides: Partial<LockInfo> = {}): LockInfo {
  return {
    token: 'tok-1',
    pid: 4242,
    host: 'host-a',
    owner: 'workspace',
    acquiredAt: 0,
    heartbeatAt: 0,
    ...overrides,
  };
}

describe('classifyLock', () => {
  it('treats a fresh heartbeat as live without consulting the pid', () => {
    let asked = 0;
    const verdict = classifyLock(
      info({ heartbeatAt: 900 }),
      {
        now: 1_000,
        isAlive: () => {
          asked += 1;
          return false;
        },
      },
      STALE_AFTER,
    );

    expect(verdict).toBe('live');
    // A fresh heartbeat alone proves liveness; asking is unnecessary work.
    expect(asked).toBe(0);
  });

  it('keeps an aged lock live while its pid still exists', () => {
    expect(classifyLock(info(), { now: 2_000, isAlive: () => true }, STALE_AFTER)).toBe(
      'live',
    );
  });

  it('marks an aged lock stale once its pid is gone', () => {
    expect(classifyLock(info(), { now: 2_000, isAlive: () => false }, STALE_AFTER)).toBe(
      'stale',
    );
  });

  it('treats a future heartbeat as live rather than guessing at clock skew', () => {
    expect(
      classifyLock(
        info({ heartbeatAt: 5_000 }),
        { now: 1_000, isAlive: () => false },
        STALE_AFTER,
      ),
    ).toBe('live');
  });

  it('is exactly inclusive at the threshold boundary', () => {
    expect(classifyLock(info(), { now: 999, isAlive: () => false }, STALE_AFTER)).toBe(
      'live',
    );
    expect(classifyLock(info(), { now: 1_000, isAlive: () => false }, STALE_AFTER)).toBe(
      'stale',
    );
  });

  it('ships a conservative default threshold', () => {
    expect(DEFAULT_STALE_AFTER_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('isLockInfo', () => {
  it('accepts a well-formed record', () => {
    expect(isLockInfo(info())).toBe(true);
  });

  it('rejects malformed shapes rather than trusting them', () => {
    expect(isLockInfo(null)).toBe(false);
    expect(isLockInfo('nope')).toBe(false);
    expect(isLockInfo({})).toBe(false);
    expect(isLockInfo({ ...info(), pid: '4242' })).toBe(false);
    const { token: _token, ...missingToken } = info();
    expect(isLockInfo(missingToken)).toBe(false);
  });
});
