import { PassThrough } from "node:stream";
import { SIGINT_EXIT_CODE, createInterruptHandler } from "../../../src/cli/interrupt.js";
import { createProgress } from "../../../src/ui/progress.js";
import { captureLogger } from "../../helpers/logger.js";

const SHOW_CURSOR = "\u001B[?25h";

function fakeTty(): { stream: NodeJS.WriteStream; written: () => string } {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  let buffer = "";
  (stream as unknown as PassThrough).on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });
  Object.assign(stream, {
    isTTY: true,
    columns: 80,
    cursorTo: () => true,
    moveCursor: () => true,
    clearLine: () => true,
  });
  return { stream, written: () => buffer };
}

function harness(pids: number[] = []) {
  const tty = fakeTty();
  const progress = createProgress({
    stream: tty.stream,
    env: {},
    installExitGuard: false,
  });
  const captured = captureLogger();
  const killed: Array<[number, string]> = [];
  const exits: number[] = [];
  let checkpointed = 0;
  let released = 0;

  const handler = createInterruptHandler({
    progress,
    logger: captured.logger,
    activePids: () => pids,
    killGroup: (pid, signal) => {
      killed.push([pid, signal]);
      return true;
    },
    checkpointInterrupted: () => {
      checkpointed += 1;
    },
    releaseLock: () => {
      released += 1;
    },
    exit: (code) => {
      exits.push(code);
    },
  });

  return {
    handler,
    progress,
    tty,
    killed,
    exits,
    events: () => captured.events,
    counts: () => ({ checkpointed, released }),
  };
}

describe("SIGINT teardown", () => {
  it("restores the cursor — ora hides it, and a hard exit would leave it hidden", () => {
    const h = harness();
    h.progress.start("working");
    h.handler();
    expect(h.tty.written()).toContain(SHOW_CURSOR);
  });

  it("signals every live process group, not just the direct child", () => {
    const h = harness([4242, 4243]);
    h.handler();
    expect(h.killed).toEqual([
      [4242, "SIGTERM"],
      [4243, "SIGTERM"],
    ]);
  });

  it("checkpoints the run as interrupted before exiting", () => {
    const h = harness();
    h.handler();
    expect(h.counts().checkpointed).toBe(1);
  });

  it("releases the directory lock so the next run is not wedged", () => {
    const h = harness();
    h.handler();
    expect(h.counts().released).toBe(1);
  });

  it("exits 130", () => {
    const h = harness();
    h.handler();
    expect(h.exits).toEqual([SIGINT_EXIT_CODE]);
  });

  it("logs the signal before acting on it, so a crash mid-teardown leaves evidence", () => {
    const h = harness([4242]);
    h.handler();
    const events = h.events();
    expect(events.indexOf("signal.received")).toBeLessThan(
      events.indexOf("process.killed"),
    );
    expect(events).toContain("run.interrupted");
  });

  it("ignores a second Ctrl+C that arrives while teardown is in flight", () => {
    const h = harness([4242]);
    h.handler();
    h.handler();
    expect(h.exits).toHaveLength(1);
    expect(h.killed).toHaveLength(1);
  });
});
