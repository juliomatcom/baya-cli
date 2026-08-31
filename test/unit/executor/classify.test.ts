import { classifyFailure } from '../../../src/executor/index.js';
import type { ProviderEvent } from '../../../src/manifest/index.js';

const at = () => new Date('2026-08-29T12:00:00.000Z');

const base = {
  timedOut: false,
  exitCode: 1,
  events: [] as ProviderEvent[],
  errorMessage: '',
  retryable: true,
};

describe('classifyFailure', () => {
  it('a timeout is retryable now', () => {
    const f = classifyFailure({ ...base, timedOut: true }, at);
    expect(f).toMatchObject({ kind: 'timeout', retry: 'now' });
  });

  it('an auth error never retries', () => {
    const f = classifyFailure(
      { ...base, errorMessage: '401 unauthorized: invalid api key' },
      at,
    );
    expect(f).toMatchObject({ kind: 'auth', retry: 'never', status_code: 401 });
  });

  it('an auth error event classifies even without a matching message', () => {
    const f = classifyFailure(
      { ...base, events: [{ t: 'error', kind: 'auth', message: 'nope' }] },
      at,
    );
    expect(f.kind).toBe('auth');
  });

  it('quota exhaustion retries later, not now — it must not burn attempts', () => {
    const f = classifyFailure({ ...base, errorMessage: 'quota_exceeded (HTTP 402)' }, at);
    expect(f).toMatchObject({ kind: 'quota', retry: 'later', status_code: 402 });
  });

  it('a plain rate limit retries later', () => {
    const f = classifyFailure(
      { ...base, events: [{ t: 'error', kind: 'rate_limit', message: '429 slow down' }] },
      at,
    );
    expect(f).toMatchObject({ kind: 'rate_limit', retry: 'later' });
  });

  // A session/usage/weekly/daily limit is an exhausted allowance that only a
  // reset refills — `quota`, so it burns no attempts. The OpenAI rate-limit
  // string beside it says "limit" four times and carries a "rate-limits" URL,
  // but it is an ordinary per-minute throttle and must stay `rate_limit`.
  it('a session limit is quota, an OpenAI rate limit beside it is not', () => {
    expect(
      classifyFailure(
        {
          ...base,
          errorMessage: "You've hit your session limit · resets 12:30am (Europe/Madrid)",
        },
        at,
      ),
    ).toMatchObject({ kind: 'quota', retry: 'later' });

    expect(
      classifyFailure(
        {
          ...base,
          errorMessage:
            'Rate limit reached for gpt-5.6-luna in organization org-… on tokens per min (TPM): Limit 200000, Used 187001, Requested 92261. Please try again in 23.778s. Visit https://platform.openai.com/account/rate-limits to learn more.',
        },
        at,
      ),
    ).toMatchObject({ kind: 'rate_limit', retry: 'later' });
  });

  it('weekly and daily limits with reset phrasing are quota', () => {
    for (const message of [
      "You've reached your weekly limit. Your access resets on Monday.",
      'Usage limit reached — limit resets at 00:00 UTC',
    ]) {
      expect(classifyFailure({ ...base, errorMessage: message }, at)).toMatchObject({
        kind: 'quota',
        retry: 'later',
      });
    }
  });

  it('a permission denial never retries', () => {
    const f = classifyFailure(
      {
        ...base,
        errorMessage:
          'claude was denied permission for: Bash, Write. Raise --permission-mode.',
      },
      at,
    );
    expect(f).toMatchObject({ kind: 'permission', retry: 'never' });
  });

  // codex's `read-only` sandbox refuses `$TMPDIR` too, so a test runner dies on
  // its own cache file. No retry can widen a sandbox.
  it('an OS sandbox refusal is a permission failure, never retried', () => {
    for (const message of [
      "Error: EPERM: operation not permitted, open '/var/folders/x/haste-map-jest'",
      "EROFS: read-only file system, mkdir '/tmp/build'",
    ]) {
      const f = classifyFailure({ ...base, errorMessage: message }, at);
      expect(f).toMatchObject({ kind: 'permission', retry: 'never' });
    }
  });

  it('an unparseable result is a schema failure, retryable now', () => {
    const f = classifyFailure(
      {
        ...base,
        errorMessage: 'codex wrote a result file that does not match task_result',
      },
      at,
    );
    expect(f).toMatchObject({ kind: 'schema', retry: 'now' });
  });

  it('a network blip retries now', () => {
    const f = classifyFailure({ ...base, errorMessage: 'fetch failed: ECONNRESET' }, at);
    expect(f).toMatchObject({ kind: 'network', retry: 'now' });
  });

  it('a wrong model name never retries — only a config change fixes it', () => {
    const f = classifyFailure(
      {
        ...base,
        errorMessage: '404 Not Found: Model not found gpt-5.1-codex',
        retryable: true,
      },
      at,
    );
    expect(f).toMatchObject({ kind: 'crash', retry: 'never' });
  });

  it("an unclassifiable failure honors the adapter's retryable flag", () => {
    expect(
      classifyFailure({ ...base, errorMessage: 'boom', retryable: true }, at),
    ).toMatchObject({ kind: 'crash', retry: 'now' });
    expect(
      classifyFailure({ ...base, errorMessage: 'boom', retryable: false }, at),
    ).toMatchObject({ kind: 'crash', retry: 'never' });
  });
});
