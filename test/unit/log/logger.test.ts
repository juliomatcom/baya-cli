import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { jest } from '@jest/globals';
import { createLogger } from '../../../src/log/logger.js';

const ESC = String.fromCharCode(27);

function tempTraceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'baya-logger-'));
  return join(dir, 'baya.jsonl');
}

function captureStream(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, lines: () => chunks };
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('createLogger', () => {
  it('writes every level to the trace file regardless of the stderr filter', () => {
    const traceFile = tempTraceFile();
    const { stream } = captureStream();
    const logger = createLogger({
      runId: 'r1',
      traceFile,
      stderrLevel: 'warn',
      stderrStream: stream,
    });

    logger.trace('state.checkpointed', { detail: 'a' });
    logger.debug('provider.session', { detail: 'b' });
    logger.info('task.spawned', { detail: 'c' });
    logger.warn('task.retried', { detail: 'd' });
    logger.error('task.failed', { detail: 'e' });

    const records = readJsonl(traceFile) as Array<{ level: string; event: string }>;
    expect(records).toHaveLength(5);
    expect(records.map((r) => r.level)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
    ]);
  });

  it('filters stderr to the configured level while the file keeps everything', () => {
    const traceFile = tempTraceFile();
    const { stream, lines } = captureStream();
    const logger = createLogger({
      runId: 'r1',
      traceFile,
      stderrLevel: 'warn',
      stderrStream: stream,
    });

    logger.info('task.spawned', {});
    logger.debug('provider.session', {});
    logger.warn('task.retried', {});
    logger.error('task.failed', {});

    const rendered = lines().join('');
    expect(rendered).not.toContain('task.spawned');
    expect(rendered).not.toContain('provider.session');
    expect(rendered).toContain('task.retried');
    expect(rendered).toContain('task.failed');
  });

  it('stamps ts and run_id on every line', () => {
    const traceFile = tempTraceFile();
    const { stream } = captureStream();
    const logger = createLogger({ runId: 'run-xyz', traceFile, stderrStream: stream });

    logger.info('cli.invoked', { argv: ['baya', './tasks.md'] });

    const [record] = readJsonl(traceFile) as Array<{
      ts: string;
      run_id: string;
      event: string;
    }>;
    expect(record?.run_id).toBe('run-xyz');
    expect(record?.event).toBe('cli.invoked');
    expect(() => new Date(record!.ts).toISOString()).not.toThrow();
  });

  it('redacts secret-shaped strings in both sinks', () => {
    const traceFile = tempTraceFile();
    const { stream, lines } = captureStream();
    const logger = createLogger({ runId: 'r1', traceFile, stderrStream: stream });

    logger.info('provider.resolved', { token: 'sk-abcdefghij1234567890' });

    const [record] = readJsonl(traceFile) as Array<{ token: string }>;
    expect(record?.token).toBe('sk-***REDACTED***');
    expect(lines().join('')).not.toContain('sk-abcdefghij1234567890');
  });

  it('elides a prompt field to prompt_bytes', () => {
    const traceFile = tempTraceFile();
    const { stream } = captureStream();
    const logger = createLogger({ runId: 'r1', traceFile, stderrStream: stream });

    logger.info('task.spawned', {
      prompt: 'do the thing',
      request: 'tasks/t1/request.json',
    });

    const [record] = readJsonl(traceFile) as Array<Record<string, unknown>>;
    expect(record?.['prompt']).toBeUndefined();
    expect(record?.['prompt_bytes']).toBe(Buffer.byteLength('do the thing', 'utf8'));
  });

  it('strips ANSI escapes before either sink is written', () => {
    const traceFile = tempTraceFile();
    const { stream, lines } = captureStream();
    const logger = createLogger({ runId: 'r1', traceFile, stderrStream: stream });

    logger.info('provider.text', { text: `${ESC}[32mgreen${ESC}[39m` });

    const [record] = readJsonl(traceFile) as Array<{ text: string }>;
    expect(record?.text).toBe('green');
    expect(lines().join('')).not.toContain('[');
  });

  it('never writes to stdout', () => {
    const traceFile = tempTraceFile();
    const { stream } = captureStream();
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const logger = createLogger({ runId: 'r1', traceFile, stderrStream: stream });
      logger.trace('state.checkpointed', {});
      logger.debug('provider.session', {});
      logger.info('task.spawned', { prompt: 'secret sk-abcdefghij1234567890' });
      logger.warn('task.retried', {});
      logger.error('task.failed', { text: `${ESC}[31mred${ESC}[39m` });

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

/**
 * `--quiet` is a request to stop narrating the work, not to stop reporting it.
 * The other outcomes survive on level alone (`task.failed` is `error`,
 * `task.parked`/`task.skipped` are `warn`), so before this a quiet run showed
 * every bad outcome and no good one.
 */
describe('outcomes outrank the level filter', () => {
  it('shows a succeeded task under --quiet, while chatter stays filtered', () => {
    const traceFile = tempTraceFile();
    const { stream, lines } = captureStream();
    const logger = createLogger({
      runId: 'r1',
      traceFile,
      stderrLevel: 'warn',
      stderrStream: stream,
    });

    logger.info('task.succeeded', { task_id: 'gen-schema' });
    logger.info('provider.text', { text: 'thinking out loud' });
    logger.info('provider.tool', { name: 'Read' });

    const rendered = lines().join('');
    expect(rendered).toContain('task.succeeded');
    expect(rendered).not.toContain('provider.text');
    expect(rendered).not.toContain('provider.tool');
  });

  it('does not change what the trace file records', () => {
    const traceFile = tempTraceFile();
    const { stream } = captureStream();
    const logger = createLogger({
      runId: 'r1',
      traceFile,
      stderrLevel: 'error',
      stderrStream: stream,
    });
    logger.info('task.succeeded', { task_id: 'a' });

    const records = readJsonl(traceFile) as Array<{ level: string }>;
    expect(records[0]?.level).toBe('info');
  });
});
