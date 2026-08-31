import {
  checkModelRouting,
  providerForModel,
  routeProvider,
  validateManifest,
  MANIFEST_VERSION,
  type Task,
} from '../../../src/manifest/index.js';

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 't',
  title: 'T',
  instruction: 'do it',
  provider: null,
  model: null,
  depends_on: [],
  access: 'read-only',
  cwd: null,
  ...overrides,
});

describe('providerForModel', () => {
  it.each([
    ['sonnet', 'claude'],
    ['opus', 'claude'],
    ['claude-sonnet-4-5', 'claude'],
    ['sonnet-latest', 'claude'],
    ['gpt-5.1-codex', 'codex'],
    ['gpt-4o', 'codex'],
    ['o3-mini', 'codex'],
    ['gpt-5.1-codex-max', 'codex'],
  ])('routes %s to %s', (model, provider) => {
    expect(providerForModel(model)).toBe(provider);
  });

  it('returns null for a model it does not recognize', () => {
    expect(providerForModel('mystery-model-9')).toBeNull();
    expect(providerForModel(null)).toBeNull();
  });
});

describe('routeProvider', () => {
  it('prefers an explicit provider', () => {
    expect(routeProvider(task({ provider: 'codex', model: 'sonnet' }), 'opencode')).toBe(
      'codex',
    );
  });

  it('falls to the model alias when no provider is set', () => {
    expect(routeProvider(task({ model: 'opus' }), 'codex')).toBe('claude');
  });

  it('falls to the run default when nothing else resolves', () => {
    expect(routeProvider(task({ model: 'mystery-9' }), 'opencode')).toBe('opencode');
    expect(routeProvider(task(), 'codex')).toBe('codex');
  });
});

describe('checkModelRouting', () => {
  const all = ['codex', 'claude', 'copilot', 'opencode'] as const;

  it('passes a task whose provider and model agree', () => {
    expect(
      checkModelRouting([task({ provider: 'claude', model: 'sonnet' })], all),
    ).toEqual([]);
  });

  it('errors, with a suggestion, on a provider/model mismatch', () => {
    const [issue] = checkModelRouting(
      [task({ id: 'x', provider: 'codex', model: 'sonnet' })],
      all,
    );
    expect(issue?.taskId).toBe('x');
    expect(issue?.message).toContain('claude');
    expect(issue?.message).toContain('provider "codex"');
  });

  it('errors when an inferred provider is outside the allowlist', () => {
    const [issue] = checkModelRouting([task({ model: 'sonnet' })], ['codex', 'opencode']);
    expect(issue?.message).toContain('allowlist');
  });

  it("errors on a deferred provider's model", () => {
    const [issue] = checkModelRouting([task({ model: 'gemini-2.0-flash' })], all);
    expect(issue?.message).toContain('not in this release');
  });

  it('says nothing about a task with no model', () => {
    expect(checkModelRouting([task({ provider: 'codex' })], all)).toEqual([]);
  });
});

describe('validateManifest — model routing stage', () => {
  const manifest = (tasks: Task[]) => ({
    version: MANIFEST_VERSION,
    source: { path: 'tasks.md', sha256: 'x' },
    tasks,
  });

  it('rejects a manifest that pairs codex with a claude model', () => {
    const result = validateManifest(
      manifest([task({ provider: 'codex', model: 'opus' })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('model_routing');
    }
  });

  it('accepts a manifest whose bare model routes to an allowed provider', () => {
    const result = validateManifest(manifest([task({ model: 'sonnet' })]));
    expect(result.ok).toBe(true);
  });
});
