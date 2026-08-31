import { elidePrompt, redactDeep, redactSecrets } from '../../../src/log/redact.js';

describe('redactSecrets', () => {
  it('redacts sk-shaped strings', () => {
    const out = redactSecrets('key is sk-abcdefghij1234567890 in the request');
    expect(out).not.toContain('sk-abcdefghij1234567890');
    expect(out).toContain('sk-***REDACTED***');
  });

  it('redacts ghp_-shaped strings', () => {
    const out = redactSecrets('token=ghp_ABCDEFGHIJ1234567890abcdef');
    expect(out).not.toContain('ghp_ABCDEFGHIJ1234567890abcdef');
    expect(out).toContain('ghp_***REDACTED***');
  });

  it('redacts multiple secrets in the same string', () => {
    const out = redactSecrets('sk-aaaaaaaaaaaaaaaaaaaa and ghp_bbbbbbbbbbbbbbbbbbbb');
    expect(out).toBe('sk-***REDACTED*** and ghp_***REDACTED***');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('nothing secret here')).toBe('nothing secret here');
  });
});

describe('redactDeep', () => {
  it('redacts secrets nested in objects and arrays', () => {
    const input = {
      argv: ['--token', 'sk-abcdefghij1234567890'],
      nested: { auth: { header: 'Bearer ghp_ABCDEFGHIJ1234567890abcdef' } },
      count: 3,
      ok: true,
    };
    const out = redactDeep(input);
    expect(out.argv[1]).toBe('sk-***REDACTED***');
    expect(out.nested.auth.header).toBe('Bearer ghp_***REDACTED***');
    expect(out.count).toBe(3);
    expect(out.ok).toBe(true);
  });
});

describe('elidePrompt', () => {
  it('replaces a string prompt field with prompt_bytes', () => {
    const out = elidePrompt({ prompt: 'hello world', task_id: 't1' });
    expect(out['prompt']).toBeUndefined();
    expect(out['prompt_bytes']).toBe(Buffer.byteLength('hello world', 'utf8'));
    expect(out['task_id']).toBe('t1');
  });

  it('is a no-op when there is no prompt field', () => {
    const fields = { task_id: 't1' };
    expect(elidePrompt(fields)).toEqual(fields);
  });

  it('is a no-op when prompt is not a string', () => {
    const fields = { prompt: 123 };
    expect(elidePrompt(fields)).toEqual(fields);
  });
});
