import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { inspectLock } from "../../src/lock/index.js";
import { makeWorkspace, readLog, runCli, taskResult } from "../helpers/runCli.js";

/**
 * One Baya per directory (recovery.md). Two Bayas in one tree means two sets
 * of agents editing the same files — a state to prevent, not to coordinate.
 */
const scenario = {
  __planner__: {
    final: {
      tasks: [
        {
          id: "a",
          title: "A",
          instruction: "do a",
          provider: "codex",
          model: null,
          depends_on: [],
          writes: false,
          cwd: null,
        },
      ],
    },
  },
  a: { final: taskResult("ok", { task_id: "a", summary: "done" }) },
};

function writeLock(cwd: string, info: Record<string, unknown>): string {
  const path = join(cwd, ".baya", "baya.lock");
  mkdirSync(join(cwd, ".baya"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info)}\n`);
  return path;
}

describe("the directory lock", () => {
  it("takes the lock for the run and releases it afterwards", async () => {
    const result = await runCli(["./tasks.md", "--yes"], { scenario });
    expect(result.code).toBe(0);
    expect(existsSync(join(result.workspace.cwd, ".baya", "baya.lock"))).toBe(false);
  });

  it("refuses a second baya, naming the holder's pid, run, and age", async () => {
    const workspace = makeWorkspace({ scenario });
    // A live holder: this very process, with a fresh heartbeat.
    writeLock(workspace.cwd, {
      token: "tok-1",
      pid: process.pid,
      host: hostname(),
      owner: "20260828T215204Z-a1f4c9-999",
      acquiredAt: Date.now() - 180_000,
      heartbeatAt: Date.now(),
    });

    const result = await runCli(["./tasks.md", "--yes"], { workspace });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("another baya is already running");
    expect(result.stderr).toContain(String(process.pid));
    expect(result.stderr).toContain("20260828T215204Z-a1f4c9-999");
  });

  it("never breaks a live lock", async () => {
    const workspace = makeWorkspace({ scenario });
    const path = writeLock(workspace.cwd, {
      token: "tok-live",
      pid: process.pid,
      host: hostname(),
      owner: "other-run",
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
    });
    await runCli(["./tasks.md", "--yes"], { workspace });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ token: "tok-live" });
  });

  it("reclaims a stale lock left by a crashed baya, with a warning", async () => {
    const workspace = makeWorkspace({ scenario });
    writeLock(workspace.cwd, {
      token: "tok-dead",
      pid: 2 ** 22, // Far above any real pid on macOS/Linux.
      host: hostname(),
      owner: "crashed-run",
      acquiredAt: Date.now() - 600_000,
      heartbeatAt: Date.now() - 600_000,
    });

    const result = await runCli(["./tasks.md", "--yes"], { workspace });
    expect(result.code).toBe(0);
    expect(readLog(result.paths!).map((line) => line["event"])).toContain(
      "lock.reclaimed",
    );
  });

  it("refuses to guess at an unreadable lock and points at doctor", async () => {
    const workspace = makeWorkspace({ scenario });
    const path = join(workspace.cwd, ".baya", "baya.lock");
    writeFileSync(path, "this is not json");

    const result = await runCli(["./tasks.md", "--yes"], { workspace });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("baya doctor");
    // Never removed automatically: we cannot tell whether its holder is alive.
    expect(existsSync(path)).toBe(true);
    expect(inspectLock(path).state).toBe("unreadable");
  });

  it("takes the lock before planning, so a refused run spends nothing", async () => {
    const workspace = makeWorkspace({ scenario });
    writeLock(workspace.cwd, {
      token: "tok-1",
      pid: process.pid,
      host: hostname(),
      owner: "other-run",
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
    });
    const result = await runCli(["./tasks.md", "--yes"], { workspace });
    const events = readLog(result.paths!).map((line) => String(line["event"]));
    expect(events).toContain("lock.refused");
    expect(events).not.toContain("plan.requested");
  });
});
