import {
  extractResultFromText,
  lastJsonFence,
  parseResultJson,
  synthesizeFailure,
} from '../../../src/providers/index.js';
import { PROTOCOL_VERSION, type TaskResult } from '../../../src/manifest/index.js';

/** These rungs are exercised one task at a time; a group has its own suite. */
const one = (results: TaskResult[]): TaskResult => results[0] as TaskResult;

const ESC = String.fromCharCode(27);

const conforming = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    baya: PROTOCOL_VERSION,
    kind: 'task_result',
    task_id: 't',
    status: 'ok',
    summary: 'did the thing',
    ...overrides,
  });

describe('synthesizeFailure', () => {
  it('is always a valid failed task_result', () => {
    const result = one(synthesizeFailure(['t'], 'unparseable result'));
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({ message: 'unparseable result', retryable: true });
    expect(parseResultJson(['t'], JSON.stringify(result))).not.toBeNull();
  });

  it('carries retryable through', () => {
    expect(
      one(synthesizeFailure(['t'], 'bad auth', { retryable: false })).error?.retryable,
    ).toBe(false);
  });
});

describe('lastJsonFence', () => {
  it('returns the body of a ```json block', () => {
    const text = `Here you go:\n\n\`\`\`json\n{"a":1}\n\`\`\`\n`;
    expect(lastJsonFence(text)).toBe('{"a":1}');
  });

  it('accepts a bare ``` fence wrapping an object', () => {
    expect(lastJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('prefers the last block when a draft precedes the final answer', () => {
    const text = [
      '```json',
      '{"draft":true}',
      '```',
      'on reflection:',
      '```json',
      '{"final":true}',
      '```',
    ].join('\n');
    expect(lastJsonFence(text)).toBe('{"final":true}');
  });

  it('ignores a fence for another language', () => {
    expect(lastJsonFence('```python\nprint(1)\n```')).toBeNull();
  });

  it('ignores a fence whose body is not an object', () => {
    expect(lastJsonFence('```json\n[1,2,3]\n```')).toBeNull();
  });

  it('returns null when there is no fence', () => {
    expect(lastJsonFence('just prose, no code')).toBeNull();
  });

  it('strips ANSI before scanning', () => {
    const text = `${ESC}[32m\`\`\`json\n{"a":1}\n\`\`\`${ESC}[0m`;
    expect(lastJsonFence(text)).toBe('{"a":1}');
  });
});

describe('extractResultFromText — degradation ladder rungs 2–3', () => {
  it('rung 2: the whole message is conforming JSON', () => {
    const parsed = extractResultFromText(['t'], conforming());
    expect(parsed).toMatchObject({ rung: 'verbatim' });
    expect(parsed?.results[0]?.status).toBe('ok');
  });

  it('rung 2 tolerates surrounding whitespace', () => {
    expect(extractResultFromText(['t'], `\n  ${conforming()}  \n`)?.rung).toBe(
      'verbatim',
    );
  });

  it('rung 3: conforming JSON inside a fenced block after prose', () => {
    const text = `I finished. Result:\n\n\`\`\`json\n${conforming()}\n\`\`\`\n`;
    const parsed = extractResultFromText(['t'], text);
    expect(parsed).toMatchObject({ rung: 'fenced' });
    expect(parsed?.results[0]?.summary).toBe('did the thing');
  });

  it('normalizes a mismatched task_id so a result cannot be misrouted', () => {
    const parsed = extractResultFromText(['t'], conforming({ task_id: 'other' }));
    expect(parsed?.results[0]?.task_id).toBe('t');
  });

  it('rejects JSON that does not match the schema (ok without a summary)', () => {
    const text = `\`\`\`json\n${conforming({ status: 'ok', summary: '' })}\n\`\`\``;
    expect(extractResultFromText(['t'], text)).toBeNull();
  });

  it('returns null on pure prose so the caller can synthesize a failure', () => {
    expect(extractResultFromText(['t'], 'I could not complete the task.')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(extractResultFromText(['t'], '   ')).toBeNull();
  });

  it('falls to the fence when the message wraps JSON in any prose at all', () => {
    // Verbatim is strict: the whole message must be the object. A trailing
    // sentence pushes it to rung 3.
    const text = `${conforming({ summary: 'real' })}\n\nThat's everything.`;
    expect(extractResultFromText(['t'], text)).toBeNull();
    const fenced = `\`\`\`json\n${conforming({ summary: 'real' })}\n\`\`\`\n\nThat's everything.`;
    expect(extractResultFromText(['t'], fenced)).toMatchObject({ rung: 'fenced' });
  });
});

describe('parseResultJson for a group', () => {
  const batch = (results: unknown[]): string =>
    JSON.stringify({ baya: PROTOCOL_VERSION, kind: 'task_result_batch', results });

  const entry = (taskId: string): unknown =>
    JSON.parse(conforming({ task_id: taskId })) as unknown;

  it('splits a batch back out by task_id, in the order asked for', () => {
    const parsed = parseResultJson(['a', 'b'], batch([entry('b'), entry('a')]));
    expect(parsed?.map((result) => result.task_id)).toEqual(['a', 'b']);
  });

  /**
   * The one place leniency would be dangerous. With a single task a wrong id is
   * normalized, because there is only one place the result can go; in a group
   * that same normalization would file one task's work under another's id, and
   * downstream tasks read those results as fact.
   */
  it('fails a task the provider never named rather than guessing by position', () => {
    const parsed = parseResultJson(['a', 'b'], batch([entry('a')]));
    expect(parsed?.[0]?.status).toBe('ok');
    expect(parsed?.[1]).toMatchObject({ task_id: 'b', status: 'failed' });
  });

  it('keeps the finished tasks when the provider answered short', () => {
    const parsed = parseResultJson(['a', 'b', 'c'], batch([entry('a'), entry('c')]));
    expect(parsed?.map((result) => result.status)).toEqual(['ok', 'failed', 'ok']);
  });

  it('rejects a plain task_result where a batch was asked for', () => {
    expect(parseResultJson(['a', 'b'], conforming({ task_id: 'a' }))).toBeNull();
  });
});
