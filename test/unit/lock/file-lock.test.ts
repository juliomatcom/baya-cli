import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileLock,
  inspectLock,
  type FileLockOptions,
  type LockLogger,
} from "../../../src/lock/index.js";
import type { LockInfo } from "../../../src/lock/classify.js";

const STALE_AFTER = 1_000;

let dir: string;
let lockPath: string;
let clock: number;
let warnings: Array<{ event: string; fields?: Record<string, unknown> }>;
let logger: LockLogger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "baya-lock-"));
  lockPath = join(dir, "workspace.lock");
  clock = 100_000;
  warnings = [];
  logger = {
    warn: (event, fields) => warnings.push(fields ? { event, fields } : { event }),
    debug: () => {},
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function opts(overrides: Partial<FileLockOptions> = {}): FileLockOptions {
  return {
    owner: "workspace",
    staleAfterMs: STALE_AFTER,
    heartbeatIntervalMs: 100,
    logger,
    now: () => clock,
    isAlive: () => true,
    ...overrides,
  };
}

function writeForeignLock(overrides: Partial<LockInfo> = {}): LockInfo {
  const info: LockInfo = {
    token: "foreign-token",
    pid: 999_999,
    host: hostname(),
    owner: "other-run",
    acquiredAt: clock,
    heartbeatAt: clock,
    ...overrides,
  };
  writeFileSync(lockPath, `${JSON.stringify(info)}\n`, "utf8");
  return info;
}

function read(): LockInfo {
  return JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
}

describe("acquire", () => {
  it("creates the lock file and records the holder", () => {
    const lock = new FileLock(lockPath, opts());
    expect(lock.acquire().ok).toBe(true);

    const written = read();
    expect(written.pid).toBe(process.pid);
    expect(written.owner).toBe("workspace");
    expect(written.host).toBe(hostname());
    lock.release();
  });

  it("refuses a second acquire while the first is live", () => {
    const first = new FileLock(lockPath, opts());
    first.acquire();

    const result = new FileLock(lockPath, opts()).acquire();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.verdict).toBe("live");
      expect(result.holder?.pid).toBe(process.pid);
    }
    first.release();
  });

  it("never breaks a live lock, however aged its heartbeat", () => {
    writeForeignLock();
    clock += 5_000; // well past staleAfterMs

    const result = new FileLock(lockPath, opts({ isAlive: () => true })).acquire();

    expect(result.ok).toBe(false);
    expect(warnings).toHaveLength(0);
    expect(read().token).toBe("foreign-token");
  });

  it("reclaims a stale lock and warns about it", () => {
    writeForeignLock();
    clock += 5_000;

    const lock = new FileLock(lockPath, opts({ isAlive: () => false }));
    const result = lock.acquire();

    expect(result.ok).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.event).toBe("lock.reclaimed");
    expect(warnings[0]?.fields?.["stale_pid"]).toBe(999_999);
    expect(read().pid).toBe(process.pid);
    lock.release();
  });

  it("refuses an unreadable lock instead of removing it", () => {
    // We cannot tell whether its holder is alive, so a human decides.
    writeFileSync(lockPath, "{not json", "utf8");

    const result = new FileLock(lockPath, opts()).acquire();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.verdict).toBe("unreadable");
    expect(readFileSync(lockPath, "utf8")).toBe("{not json");
  });

  it("succeeds once a previous holder releases", () => {
    const first = new FileLock(lockPath, opts());
    first.acquire();
    expect(new FileLock(lockPath, opts()).acquire().ok).toBe(false);

    first.release();

    const second = new FileLock(lockPath, opts());
    expect(second.acquire().ok).toBe(true);
    second.release();
  });

  it("rejects a heartbeat interval that would outrun staleness", () => {
    expect(() => new FileLock(lockPath, opts({ heartbeatIntervalMs: 5_000 }))).toThrow(
      RangeError,
    );
  });

  it("refuses to double-acquire from the same instance", () => {
    const lock = new FileLock(lockPath, opts());
    lock.acquire();
    expect(() => lock.acquire()).toThrow(/already held/);
    lock.release();
  });
});

describe("release", () => {
  it("removes the lock file and is idempotent", () => {
    const lock = new FileLock(lockPath, opts());
    lock.acquire();

    lock.release();
    lock.release();

    expect(inspectLock(lockPath).state).toBe("free");
    expect(lock.isHeld()).toBe(false);
  });

  it("does not delete a lock that was reclaimed from us", () => {
    const lock = new FileLock(lockPath, opts());
    lock.acquire();

    const usurper = writeForeignLock({ token: "usurper-token" });
    lock.release();

    expect(read().token).toBe(usurper.token);
    expect(warnings.some((w) => w.event === "lock.release_skipped")).toBe(true);
  });
});

describe("heartbeat", () => {
  it("refreshes the stored heartbeat while held", async () => {
    const lock = new FileLock(lockPath, opts({ heartbeatIntervalMs: 20 }));
    lock.acquire();
    const before = read().heartbeatAt;

    clock += 500;
    await new Promise((r) => setTimeout(r, 60));

    expect(read().heartbeatAt).toBeGreaterThan(before);
    lock.release();
  });
});

describe("inspectLock", () => {
  it("reports free when there is no lock file", () => {
    expect(inspectLock(lockPath).state).toBe("free");
  });

  it("reports a live holder without mutating anything", () => {
    writeForeignLock();
    const result = inspectLock(lockPath, {
      staleAfterMs: STALE_AFTER,
      now: () => clock,
      isAlive: () => true,
    });

    expect(result.state).toBe("held");
    if (result.state === "held") {
      expect(result.verdict).toBe("live");
      expect(result.info.owner).toBe("other-run");
    }
    expect(read().token).toBe("foreign-token");
  });

  it("reports a stale holder so doctor can tell a crash from a live run", () => {
    writeForeignLock();
    clock += 5_000;
    const result = inspectLock(lockPath, {
      staleAfterMs: STALE_AFTER,
      now: () => clock,
      isAlive: () => false,
    });

    if (result.state === "held") expect(result.verdict).toBe("stale");
    else throw new Error(`expected held, got ${result.state}`);
  });

  it("reports unreadable rather than throwing on a corrupt file", () => {
    writeFileSync(lockPath, "garbage", "utf8");
    expect(inspectLock(lockPath).state).toBe("unreadable");
  });
});
