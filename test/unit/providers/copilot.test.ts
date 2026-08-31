import { copilotAdapter } from '../../../src/providers/index.js';
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
  provider: 'copilot',
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
  bin: '/home/u/.nvm/versions/node/v24/bin/copilot',
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

describe('copilotAdapter.buildRun argv', () => {
  it('matches the recorded surface', () => {
    expect(copilotAdapter.buildRun(input()).argv).toMatchSnapshot();
  });

  it('carries the prompt as the -p flag value — copilot is argv-only', () => {
    const plan = copilotAdapter.buildRun(input());
    expect(plan.stdin).toBe('ignore');
    expect(plan.argv[plan.argv.indexOf('-p') + 1]).toBe('do the thing');
    expect(plan.files).toBeUndefined();
  });

  it('always sets --no-ask-user so a question cannot block the process', () => {
    expect(copilotAdapter.buildRun(input()).argv).toContain('--no-ask-user');
  });

  it('adds --allow-all-tools only for writing or dangerous tasks', () => {
    expect(copilotAdapter.buildRun(input()).argv).not.toContain('--allow-all-tools');
    expect(
      copilotAdapter.buildRun(input({ task: task({ access: 'read-write' }) })).argv,
    ).toContain('--allow-all-tools');
    expect(copilotAdapter.buildRun(input({ dangerouslyAllowAll: true })).argv).toContain(
      '--allow-all-tools',
    );
  });

  it('passes --model and --session-id only when set', () => {
    expect(copilotAdapter.buildRun(input()).argv).not.toContain('--model');
    expect(copilotAdapter.buildRun(input()).argv).not.toContain('--session-id');
    const argv = copilotAdapter.buildRun(
      input({ model: 'claude-sonnet-4', sessionId: 's1' }),
    ).argv;
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-4');
    expect(argv[argv.indexOf('--session-id') + 1]).toBe('s1');
  });

  it('passes the working directory through -C', () => {
    const argv = copilotAdapter.buildRun(input({ cwd: '/elsewhere' })).argv;
    expect(argv[argv.indexOf('-C') + 1]).toBe('/elsewhere');
  });

  it('builds a resume around the pre-assigned session id', () => {
    expect(
      copilotAdapter.buildResume('sess-9', 'use postgres', input()).argv,
    ).toMatchSnapshot();
  });
});

describe('copilotAdapter.parseEvents', () => {
  it('drops ephemeral progress lines', () => {
    expect(
      copilotAdapter.parseEvents('{"type":"progress","ephemeral":true,"data":{}}'),
    ).toEqual([]);
  });

  it('maps the terminal result line onto session + final', () => {
    const events = copilotAdapter.parseEvents(
      '{"type":"result","sessionId":"sess-1","exitCode":0,"usage":{"codeChanges":{"filesModified":["a.sql"]}}}',
    );
    expect(events).toContainEqual({ t: 'session', id: 'sess-1' });
    expect(events.some((e) => e.t === 'final')).toBe(true);
  });

  it('maps a quota error onto a rate_limit event and keeps the raw line', () => {
    const events = copilotAdapter.parseEvents(
      '{"type":"session.error","data":{"errorType":"quota","errorCode":"quota_exceeded","statusCode":402}}',
    );
    expect(events.find((e) => e.t === 'error')).toMatchObject({ kind: 'rate_limit' });
    expect(events.some((e) => e.t === 'unknown')).toBe(true);
  });

  it('keeps a non-JSON line as unknown', () => {
    expect(copilotAdapter.parseEvents('booting')).toEqual([
      { t: 'unknown', raw: 'booting' },
    ]);
  });
});

describe('copilotAdapter.extractResult', () => {
  const ctx = (raw: string, over: Partial<Record<string, unknown>> = {}) => ({
    taskIds: ['gen-schema'],
    events: copilotAdapter.parseEvents(raw),
    resultFileContents: null,
    exitCode: 0,
    stderr: '',
    ...over,
  });

  it('mines a conforming result from a fenced block in an assistant line', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      data: { text: `Here it is:\n\n\`\`\`json\n${conforming}\n\`\`\`` },
    });
    const result = one(copilotAdapter.extractResults(ctx(raw)));
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('made the tables');
  });

  it('fills files_changed from the result line when the mined result omits it', () => {
    const assistant = JSON.stringify({ type: 'assistant', data: { text: conforming } });
    const resultLine =
      '{"type":"result","sessionId":"s","exitCode":0,"usage":{"codeChanges":{"filesModified":["migrations/001.sql"]}}}';
    const result = one(copilotAdapter.extractResults(ctx(`${assistant}\n${resultLine}`)));
    expect(result.files_changed).toEqual(['migrations/001.sql']);
  });

  it('synthesizes a non-retryable failure from a quota error', () => {
    const raw =
      '{"type":"session.error","data":{"errorType":"quota","errorCode":"quota_exceeded","statusCode":402}}';
    const result = one(copilotAdapter.extractResults(ctx(raw)));
    expect(result.status).toBe('failed');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toContain('quota_exceeded');
  });

  it('synthesizes a failure when copilot produced nothing usable', () => {
    const result = one(
      copilotAdapter.extractResults({
        taskIds: ['gen-schema'],
        events: [],
        resultFileContents: null,
        exitCode: 1,
        stderr: 'crash',
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('no parseable result');
  });
});
