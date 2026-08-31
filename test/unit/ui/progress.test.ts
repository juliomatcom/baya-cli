import { PassThrough } from 'node:stream';
import { createProgress, restoreCursor } from '../../../src/ui/progress.js';

const SHOW_CURSOR = '\u001B[?25h';

/** A writable that reports itself as a TTY, so ora takes its live path. */
function fakeTty(): { stream: NodeJS.WriteStream; written: () => string } {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  let buffer = '';
  (stream as unknown as PassThrough).on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
  });
  (stream as { isTTY?: boolean }).isTTY = true;
  (stream as { columns?: number }).columns = 80;
  // ora drives the line through the tty cursor API, which PassThrough lacks.
  Object.assign(stream, {
    cursorTo: () => true,
    moveCursor: () => true,
    clearLine: () => true,
  });
  return { stream, written: () => buffer };
}

function fakePipe(): { stream: NodeJS.WritableStream; written: () => string } {
  const stream = new PassThrough();
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
  });
  return { stream, written: () => buffer };
}

describe('createProgress enablement', () => {
  it('is on for an interactive stderr', () => {
    const { stream } = fakeTty();
    expect(createProgress({ stream, env: {}, installExitGuard: false }).enabled).toBe(
      true,
    );
  });

  it('is off when stderr is not a TTY — spinner frames in a pipe are noise', () => {
    const { stream } = fakePipe();
    expect(createProgress({ stream, env: {}, installExitGuard: false }).enabled).toBe(
      false,
    );
  });

  it('is off under --json, so stdout stays a clean document', () => {
    const { stream } = fakeTty();
    expect(
      createProgress({ stream, env: {}, json: true, installExitGuard: false }).enabled,
    ).toBe(false);
  });

  it('is off under NO_COLOR', () => {
    const { stream } = fakeTty();
    expect(
      createProgress({ stream, env: { NO_COLOR: '1' }, installExitGuard: false }).enabled,
    ).toBe(false);
  });

  it('is off under --no-progress', () => {
    const { stream } = fakeTty();
    expect(
      createProgress({ stream, env: {}, disabled: true, installExitGuard: false })
        .enabled,
    ).toBe(false);
  });
});

describe('progress.write', () => {
  it('passes lines straight through when disabled', () => {
    const { stream, written } = fakePipe();
    const progress = createProgress({ stream, env: {}, installExitGuard: false });
    progress.write('hello');
    expect(written()).toBe('hello\n');
  });

  it('does not double a trailing newline', () => {
    const { stream, written } = fakePipe();
    createProgress({ stream, env: {}, installExitGuard: false }).write('hello\n');
    expect(written()).toBe('hello\n');
  });

  it('clears and repaints around a persistent line while spinning', () => {
    const { stream, written } = fakeTty();
    const progress = createProgress({ stream, env: {}, installExitGuard: false });
    progress.start('working');
    progress.write('a task finished');
    progress.dispose();
    expect(written()).toContain('a task finished');
  });
});

describe('spinner does not hold stdin', () => {
  // ora's default stdin discarder puts a TTY in raw mode, which suppresses the
  // kernel's Ctrl+C→SIGINT before the first prompt runs. Baya owns its own
  // SIGINT teardown, so `start()` must pass `discardStdin: false` and never
  // touch stdin's raw mode.
  it('never puts stdin into raw mode', () => {
    const stdin = process.stdin as unknown as Record<string, unknown>;
    const original: Record<string, unknown> = {
      isTTY: stdin['isTTY'],
      isRaw: stdin['isRaw'],
      isPaused: stdin['isPaused'],
      setRawMode: stdin['setRawMode'],
    };
    const rawModeCalls: boolean[] = [];
    stdin['isTTY'] = true;
    stdin['isRaw'] = false;
    stdin['isPaused'] = () => false;
    stdin['setRawMode'] = (mode: boolean) => {
      rawModeCalls.push(mode);
      return stdin;
    };
    try {
      const { stream } = fakeTty();
      const progress = createProgress({ stream, env: {}, installExitGuard: false });
      progress.start('working');
      progress.update('still working');
      progress.dispose();
      expect(rawModeCalls).toEqual([]);
    } finally {
      for (const key of Object.keys(original)) stdin[key] = original[key];
    }
  });
});

describe('cursor restoration', () => {
  it('emits the show-cursor escape on dispose — ora hides it', () => {
    const { stream, written } = fakeTty();
    const progress = createProgress({ stream, env: {}, installExitGuard: false });
    progress.start('working');
    progress.dispose();
    expect(written()).toContain(SHOW_CURSOR);
  });

  it('restores again on a second dispose, as a signal handler would call it', () => {
    const { stream, written } = fakeTty();
    const progress = createProgress({ stream, env: {}, installExitGuard: false });
    progress.start('working');
    progress.dispose();
    const afterFirst = written().split(SHOW_CURSOR).length - 1;
    progress.dispose();
    expect(written().split(SHOW_CURSOR).length - 1).toBeGreaterThan(afterFirst);
  });

  it('restoreCursor is callable directly from a signal handler', () => {
    const { stream, written } = fakeTty();
    restoreCursor(stream);
    expect(written()).toBe(SHOW_CURSOR);
  });

  it('writes no escape to a non-TTY, which would otherwise pollute a log file', () => {
    const { stream, written } = fakePipe();
    restoreCursor(stream);
    expect(written()).toBe('');
  });
});
