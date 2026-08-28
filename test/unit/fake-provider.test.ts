import { spawnSync } from "node:child_process";
import { runFakeProvider, spawnFakeProvider } from "../helpers/fakeProvider.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Finds pids whose ppid matches, via `ps` (portable across BSD/GNU). */
function childPids(ppid: number): number[] {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid="]);
  const lines = result.stdout.toString("utf8").trim().split("\n");
  return lines
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parentPid]) => parentPid === ppid)
    .map(([pid]) => pid as number);
}

describe("fake-provider.mjs", () => {
  it("replays a scripted scenario: emitted lines in order, then the final line, then exit_code", async () => {
    const result = await runFakeProvider({
      emit: [
        { delay_ms: 5, line: '{"type":"session","id":"s-1"}' },
        { delay_ms: 5, line: '{"type":"text","text":"working"}' },
      ],
      final: { baya: "1", kind: "task_result", task_id: "t1", status: "ok" },
      exit_code: 0,
    });

    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ type: "session", id: "s-1" });
    expect(JSON.parse(lines[1]!)).toEqual({ type: "text", text: "working" });
    expect(JSON.parse(lines[2]!)).toMatchObject({ kind: "task_result", task_id: "t1" });
    expect(result.code).toBe(0);
  });

  it("replays exit_code and stderr for a failure scenario", async () => {
    const result = await runFakeProvider({
      stderr: "boom: something went wrong",
      exit_code: 1,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("boom: something went wrong");
  });

  it("writes a malformed/prose-wrapped final line verbatim", async () => {
    const result = await runFakeProvider({
      final: 'Sure! Here you go:\n```json\n{"status":"ok"}\n```',
      exit_code: 0,
    });

    expect(result.stdout).toContain("Sure! Here you go:");
  });

  describe("expect_stdin", () => {
    it("succeeds when the required substring is present on stdin", async () => {
      const result = await runFakeProvider(
        { expect_stdin: "secret-token", exit_code: 0 },
        { stdin: "prefix secret-token suffix" },
      );
      expect(result.code).toBe(0);
    });

    it("fails when stdin does not contain the required substring", async () => {
      const result = await runFakeProvider(
        { expect_stdin: "secret-token", exit_code: 0 },
        { stdin: "nothing relevant" },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("expect_stdin failed");
    });

    it("fails when stdin is required but empty", async () => {
      const result = await runFakeProvider({ expect_stdin: true, exit_code: 0 });
      expect(result.code).toBe(2);
    });

    it("does not wait on stdin when expect_stdin is not set", async () => {
      const result = await runFakeProvider({ final: { status: "ok" }, exit_code: 0 });
      expect(result.code).toBe(0);
    });
  });

  describe("on_signal", () => {
    it("'exit' mode exits promptly on SIGTERM", async () => {
      const child = spawnFakeProvider({ hang_ms: 5000, on_signal: "exit" });
      await sleep(100);

      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );
      child.kill("SIGTERM");
      const { code } = await closed;

      expect(code).toBe(130);
    });

    it("'ignore' mode survives SIGTERM until forcibly killed", async () => {
      const child = spawnFakeProvider({ hang_ms: 5000, on_signal: "ignore" });
      await sleep(100);

      child.kill("SIGTERM");
      await sleep(150);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();

      const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
      expect(child.signalCode).toBe("SIGKILL");
    });
  });

  it("spawn_child spawns a detached grandchild that outlives signal handling", async () => {
    const child = spawnFakeProvider({
      hang_ms: 5000,
      spawn_child: true,
      on_signal: "ignore",
    });
    await sleep(150);

    expect(child.pid).toBeDefined();
    const grandchildren = childPids(child.pid!);
    expect(grandchildren.length).toBeGreaterThan(0);

    for (const pid of grandchildren) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });
});
