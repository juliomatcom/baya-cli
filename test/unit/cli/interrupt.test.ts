import { PassThrough } from 'node:stream';
import { SIGINT_EXIT_CODE, createInterruptHandler } from '../../../src/cli/interrupt.js';
import { createProgress } from '../../../src/ui/progress.js';
import { captureLogger } from '../../helpers/logger.js';

/** `ESC [ ? 2 5 h` — the "show cursor" sequence `restoreCursor` writes. */
const SHOW_CURSOR = `${String.fromCharCode(0x1b)}[?25h`;

function fakeTty(): { stream: NodeJS.WriteStream; written: () => string } {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  let buffer = '';
  (stream as unknown as PassThrough).on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
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

/**
 * A hand-cranked grace timer and clock: `setTimer` queues the escalation
 * instead of running it, `fireGrace` runs it, and the clock only moves when a
 * test moves it. No real signal ever leaves the process — `killGroup` and
 * `exit` are captured, so the test runner is never signalled or torn down.
 */
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

  let now = 1_000;
  const scheduled: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const live = new Set(pids);

  const handler = createInterruptHandler({
    progress,
    logger: captured.logger,
    activePids: () => live,
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
    clock: () => now,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, live: true };
      scheduled.push(entry);
      return entry;
    },
    clearTimer: (timer) => {
      (timer as { live: boolean }).live = false;
    },
    graceMs: 5_000,
  });

  return {
    handler,
    progress,
    tty,
    killed,
    exits,
    live,
    advance: (ms: number) => {
      now += ms;
    },
    fireGrace: () => {
      const entry = scheduled.find((e) => e.live);
      if (!entry) throw new Error('no grace timer scheduled');
      entry.live = false;
      entry.fn();
    },
    pendingTimers: () => scheduled.filter((e) => e.live).length,
    events: () => captured.events,
    lines: () => captured.lines,
    counts: () => ({ checkpointed, released }),
  };
}

describe('SIGINT teardown', () => {
  it('sends SIGTERM to every live process group before the grace window, not just the direct child', () => {
    const h = harness([4242, 4243]);
    h.handler();
    expect(h.killed).toEqual([
      [4242, 'SIGTERM'],
      [4243, 'SIGTERM'],
    ]);
    expect(h.exits).toHaveLength(0);
    expect(h.pendingTimers()).toBe(1);
  });

  it('checkpoints the run interrupted on the first Ctrl+C, before the grace window', () => {
    const h = harness([4242]);
    h.handler();
    expect(h.counts().checkpointed).toBe(1);
    expect(h.exits).toHaveLength(0);
  });

  it('SIGKILLs the survivors the scheduler still lists, then releases the lock and exits 130', () => {
    const h = harness([4242, 4243]);
    h.handler();
    // The scheduler drops a pid that exited on SIGTERM; only 4243 is left.
    h.live.delete(4242);
    h.advance(5_000);
    h.fireGrace();
    expect(h.killed).toEqual([
      [4242, 'SIGTERM'],
      [4243, 'SIGTERM'],
      [4243, 'SIGKILL'],
    ]);
    expect(h.counts().released).toBe(1);
    expect(h.exits).toEqual([SIGINT_EXIT_CODE]);
  });

  it('restores the cursor — ora hides it, and a hard exit would leave it hidden', () => {
    const h = harness([4242]);
    h.progress.start('working');
    h.handler();
    h.fireGrace();
    expect(h.tty.written()).toContain(SHOW_CURSOR);
  });

  it('skips the grace window entirely when nothing is in flight', () => {
    const h = harness([]);
    h.handler();
    expect(h.pendingTimers()).toBe(0);
    expect(h.counts()).toEqual({ checkpointed: 1, released: 1 });
    expect(h.exits).toEqual([SIGINT_EXIT_CODE]);
  });

  it('a second Ctrl+C during the grace window escalates immediately instead of returning early', () => {
    const h = harness([4242]);
    h.handler();
    expect(h.exits).toHaveLength(0);
    h.handler();
    expect(h.killed).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL'],
    ]);
    expect(h.exits).toEqual([SIGINT_EXIT_CODE]);
    // The pending grace timer was cancelled, so firing it later is a no-op.
    expect(h.pendingTimers()).toBe(0);
  });

  it('a third Ctrl+C after escalation does nothing', () => {
    const h = harness([4242]);
    h.handler();
    h.handler();
    h.handler();
    expect(h.exits).toHaveLength(1);
    expect(h.killed).toHaveLength(2);
  });

  it('logs the signal before it kills anything, so a crash mid-teardown leaves evidence', () => {
    const h = harness([4242]);
    h.handler();
    h.fireGrace();
    const events = h.events();
    expect(events.indexOf('signal.received')).toBeLessThan(
      events.indexOf('process.killed'),
    );
    expect(events).toContain('run.interrupted');
  });

  it('records the grace it actually waited on run.interrupted', () => {
    const h = harness([4242]);
    h.handler();
    h.advance(5_000);
    h.fireGrace();
    const interrupted = h.lines().find((line) => line.event === 'run.interrupted');
    expect(interrupted?.['grace_ms']).toBe(5_000);
  });
});
