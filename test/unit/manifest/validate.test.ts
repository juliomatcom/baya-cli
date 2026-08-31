import { validateManifest, type ValidationError } from '../../../src/manifest/index.js';

const source = { path: 'tasks.md', sha256: 'abc' };
const task = (id: string, depends_on: string[] = [], extra = {}) => ({
  id,
  title: id,
  instruction: 'do it',
  depends_on,
  ...extra,
});
const manifest = (tasks: unknown[]) => ({ version: 1, source, tasks });

function codes(errors: ValidationError[]): string[] {
  return errors.map((error) => error.code);
}

describe('validateManifest', () => {
  it('accepts a valid two-task chain', () => {
    const result = validateManifest(manifest([task('a'), task('b', ['a'])]));
    expect(result.ok).toBe(true);
  });

  it('reports a schema error before anything else', () => {
    const result = validateManifest({ version: 2, source, tasks: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.errors)).toEqual(['schema']);
  });

  it('rejects a non-kebab id', () => {
    const result = validateManifest(manifest([task('Gen_Schema')]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.errors)).toEqual(['id_format']);
  });

  it('reports a duplicate id once, not once per occurrence', () => {
    const result = validateManifest(manifest([task('a'), task('a')]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.errors)).toEqual(['id_duplicate']);
      expect(result.errors[0]?.taskId).toBe('a');
    }
  });

  it('reports every dangling dependency in one pass', () => {
    const result = validateManifest(manifest([task('a', ['ghost', 'phantom'])]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.errors)).toEqual(['dep_unresolved', 'dep_unresolved']);
    }
  });

  it('detects a self-loop and names it', () => {
    const result = validateManifest(manifest([task('a', ['a'])]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('dep_cycle');
      expect(result.errors[0]?.path).toEqual(['a', 'a']);
    }
  });

  it('reports the actual path of a 3-cycle, not just that one exists', () => {
    const result = validateManifest(
      manifest([task('a', ['c']), task('b', ['a']), task('c', ['b'])]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const path = result.errors[0]?.path ?? [];
      expect(path).toHaveLength(4);
      expect(path[0]).toBe(path[path.length - 1]);
      expect(new Set(path)).toEqual(new Set(['a', 'b', 'c']));
    }
  });

  it('names only the cycle, not the acyclic tail hanging off it', () => {
    const result = validateManifest(
      manifest([task('a', ['b']), task('b', ['a']), task('tail', ['a'])]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).not.toContain('tail');
  });

  it('rejects a provider outside the allowlist', () => {
    const result = validateManifest(manifest([task('a', [], { provider: 'claude' })]), {
      allowlist: ['codex'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.errors)).toEqual(['provider_not_allowed']);
  });

  it("allows a null provider — that means 'use the run default'", () => {
    const result = validateManifest(manifest([task('a', [], { provider: null })]), {
      allowlist: ['codex'],
    });
    expect(result.ok).toBe(true);
  });

  it('enforces --max-tasks', () => {
    const tasks = Array.from({ length: 4 }, (_, index) => task(`t${index}`));
    const result = validateManifest(manifest(tasks), { maxTasks: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.errors)).toEqual(['too_many_tasks']);
  });

  it('stops at the first failing stage rather than cascading', () => {
    // A dangling dep would also make cycle detection meaningless; only the
    // earlier stage should report.
    const result = validateManifest(manifest([task('a', ['ghost']), task('a')]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.errors)).toEqual(['id_duplicate']);
  });
});
