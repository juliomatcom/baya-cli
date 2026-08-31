import { opencodeAdapter } from '../../../src/providers/index.js';
import {
  PROTOCOL_VERSION,
  type Task,
  type TaskRequest,
  type TaskResult,
} from '../../../src/manifest/index.js';

/** A process returns one result per task; these adapters are exercised with one. */
const one = (results: TaskResult[]): TaskResult => results[0] as TaskResult;

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'gen-schema',
  title: 'Generate DB schema',
  instruction: 'Create the tables.',
  provider: 'opencode',
  model: null,
  depends_on: [],
  access: 'read-only',
  cwd: null,
  ...overrides,
});

const request: TaskRequest = {
  baya: PROTOCOL_VERSION,
  kind: 'task_request',
  run_id: 'run-1',
  task: { id: 'gen-schema', title: 't', instruction: 'i' },
  workspace: { cwd: '/work', access: 'read-only', isolation: 'shared' },
  context: [],
  response_contract: { schema_path: '/work/.baya/schema/task_result.schema.json' },
  constraints: { max_runtime_s: 900 },
};

const input = (overrides = {}) => ({
  bin: '/home/u/.opencode/bin/opencode',
  task: task(),
  request,
  model: null as string | null,
  cwd: '/work',
  schemaPath: '/work/.baya/schema/task_result.schema.json',
  schemaContents: '{"type":"object"}',
  resultFile: '/work/.baya/runs/r1/tasks/gen-schema/result.json',
  prompt: 'do the thing',
  ...overrides,
});

const conforming = JSON.stringify({
  baya: PROTOCOL_VERSION,
  kind: 'task_result',
  task_id: 'gen-schema',
  status: 'ok',
  summary: 'made the tables',
});

describe('opencodeAdapter.buildRun argv', () => {
  it('matches the recorded surface', () => {
    expect(opencodeAdapter.buildRun(input()).argv).toMatchSnapshot();
  });

  // The bug this pins: `-f` *attaches* a file, it is not the message. An argv
  // carrying only `-f prompt.md` reaches no model — opencode exits 1 with
  // "You must provide a message or a command". The prompt must be the trailing
  // positional, and nothing may follow it.
  it('delivers the prompt as the trailing positional, never by -f, never stdin', () => {
    const plan = opencodeAdapter.buildRun(input());
    expect(plan.stdin).toBe('ignore');
    expect(plan.argv.at(-1)).toBe('do the thing');
    expect(plan.argv).not.toContain('-f');
  });

  // yargs reads a leading `-` as a flag: without the separator opencode prints
  // its help text and exits rather than running the prompt.
  it('separates the prompt from the flags with --', () => {
    for (const plan of [
      opencodeAdapter.buildRun(input({ prompt: '--do the thing' })),
      opencodeAdapter.buildResume('ses_abc', '-use postgres', input()),
    ]) {
      expect(plan.argv.at(-2)).toBe('--');
    }
  });

  it('still records the prompt on disk for the run directory', () => {
    expect(opencodeAdapter.buildRun(input()).files).toEqual([
      {
        path: '/work/.baya/runs/r1/tasks/gen-schema/prompt.md',
        contents: 'do the thing',
      },
    ]);
  });

  it('sends the resume answer as the trailing positional too', () => {
    const plan = opencodeAdapter.buildResume('ses_abc', 'use postgres', input());
    expect(plan.argv.at(-1)).toBe('use postgres');
    expect(plan.argv).not.toContain('-f');
  });

  it('passes -m only when a model is set, in compound provider/model form as given', () => {
    expect(opencodeAdapter.buildRun(input()).argv).not.toContain('-m');
    const argv = opencodeAdapter.buildRun(
      input({ model: 'anthropic/claude-sonnet-4' }),
    ).argv;
    expect(argv[argv.indexOf('-m') + 1]).toBe('anthropic/claude-sonnet-4');
  });

  it('passes the working directory through --dir', () => {
    const argv = opencodeAdapter.buildRun(input({ cwd: '/elsewhere' })).argv;
    expect(argv[argv.indexOf('--dir') + 1]).toBe('/elsewhere');
  });

  it('builds a resume around the captured session id', () => {
    expect(
      opencodeAdapter.buildResume('ses_abc', 'use postgres', input()).argv,
    ).toMatchSnapshot();
  });
});

describe('opencodeAdapter.parseEvents', () => {
  it('captures the session id', () => {
    expect(
      opencodeAdapter.parseEvents('{"type":"step-start","sessionID":"ses_abc"}'),
    ).toContainEqual({ t: 'session', id: 'ses_abc' });
  });

  it('maps a 401 error onto a non-retryable auth event and keeps the raw line', () => {
    const events = opencodeAdapter.parseEvents(
      '{"type":"error","error":{"name":"ProviderAuthError","data":{"statusCode":401,"isRetryable":false}}}',
    );
    expect(events.find((e) => e.t === 'error')).toMatchObject({ kind: 'auth' });
    expect(events.some((e) => e.t === 'unknown')).toBe(true);
  });

  it('treats a retryable error as rate_limit', () => {
    const events = opencodeAdapter.parseEvents(
      '{"type":"error","error":{"name":"APIError","data":{"statusCode":503,"isRetryable":true}}}',
    );
    expect(events.find((e) => e.t === 'error')).toMatchObject({ kind: 'rate_limit' });
  });

  it('reads assistant text from a text part', () => {
    expect(
      opencodeAdapter.parseEvents(
        '{"type":"part","part":{"type":"text","text":"hello"}}',
      ),
    ).toContainEqual({ t: 'text', text: 'hello' });
  });

  it('keeps an unrecognized line as unknown rather than dropping it', () => {
    expect(opencodeAdapter.parseEvents('{"type":"snapshot","hash":"abc"}')).toEqual([
      { t: 'unknown', raw: '{"type":"snapshot","hash":"abc"}' },
    ]);
  });

  it('keeps a non-JSON line as unknown', () => {
    expect(opencodeAdapter.parseEvents('starting…')).toEqual([
      { t: 'unknown', raw: 'starting…' },
    ]);
  });
});

describe('opencodeAdapter.extractResult', () => {
  const ctx = (raw: string, over: Partial<Record<string, unknown>> = {}) => ({
    taskIds: ['gen-schema'],
    events: opencodeAdapter.parseEvents(raw),
    resultFileContents: null,
    exitCode: 0,
    stderr: '',
    ...over,
  });

  it('mines a conforming result out of a fenced block in the assistant text', () => {
    const raw = `{"type":"part","part":{"type":"text","text":"Done.\\n\\n\`\`\`json\\n${conforming.replace(
      /"/g,
      '\\"',
    )}\\n\`\`\`"}}`;
    const result = one(opencodeAdapter.extractResults(ctx(raw)));
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('made the tables');
  });

  it('parses a verbatim result emitted as a plain text part', () => {
    const raw = JSON.stringify({ type: 'text', text: conforming });
    expect(one(opencodeAdapter.extractResults(ctx(raw))).status).toBe('ok');
  });

  it('synthesizes a non-retryable failure from a 401 error line', () => {
    const raw =
      '{"type":"error","error":{"name":"ProviderAuthError","data":{"statusCode":401,"isRetryable":false}}}';
    const result = one(opencodeAdapter.extractResults(ctx(raw)));
    expect(result.status).toBe('failed');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toContain('401');
  });

  it('synthesizes a retryable failure from a 503 error line', () => {
    const raw =
      '{"type":"error","error":{"name":"APIError","data":{"statusCode":503,"isRetryable":true}}}';
    expect(one(opencodeAdapter.extractResults(ctx(raw))).error?.retryable).toBe(true);
  });

  it('synthesizes a failure when opencode produced nothing usable', () => {
    const result = one(
      opencodeAdapter.extractResults({
        taskIds: ['gen-schema'],
        events: [],
        resultFileContents: null,
        exitCode: 1,
        stderr: 'boom',
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('no parseable result');
  });
});

describe('opencodeAdapter.extractUsage', () => {
  // Real opencode 1.18.25 `step_finish` line: tokens/cost live under `part`,
  // and `part.tokens.input` is fresh-only with cache reads/writes alongside.
  const stepFinish = (
    input: number,
    output: number,
    cacheRead: number,
    cost: number,
  ): string =>
    JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_abc',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: {
          total: input + output + cacheRead,
          input,
          output,
          reasoning: 0,
          cache: { write: 0, read: cacheRead },
        },
        cost,
      },
    });

  it('sums tokens and cost across step_finish lines, input gross of cache', () => {
    const events = opencodeAdapter.parseEvents(
      [stepFinish(10, 4, 100, 0.01), stepFinish(6, 2, 200, 0.02)].join('\n'),
    );
    expect(opencodeAdapter.extractUsage?.(events)).toEqual({
      input_tokens: 316, // (10 + 6) fresh + (100 + 200) cache read
      output_tokens: 6,
      cached_input_tokens: 300,
      cost_usd: 0.03,
    });
  });

  it('still reads a flat top-level shape', () => {
    const events = opencodeAdapter.parseEvents(
      '{"type":"step-finish","tokens":{"input":10,"output":4},"cost":0.01}',
    );
    expect(opencodeAdapter.extractUsage?.(events)).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      cost_usd: 0.01,
    });
  });

  it('reports nothing when no usage lines are present', () => {
    const events = opencodeAdapter.parseEvents('{"type":"step-start","sessionID":"ses_abc"}');
    expect(opencodeAdapter.extractUsage?.(events)).toEqual({});
  });
});
