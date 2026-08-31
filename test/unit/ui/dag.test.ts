import { renderDag } from '../../../src/ui/index.js';
import { createTheme } from '../../../src/ui/theme.js';
import {
  MANIFEST_VERSION,
  type Manifest,
  type Task,
} from '../../../src/manifest/index.js';

const theme = createTheme('never');

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

const manifest = (tasks: Task[]): Manifest => ({
  version: MANIFEST_VERSION,
  source: { path: 'tasks.md', sha256: 'x' },
  tasks,
});

/** The scaffold column of a task's row: the tree glyphs that precede its id. */
const scaffoldOf = (out: string, id: string): string => {
  const line = out.split('\n').find((row) => row.includes(id));
  return line ? line.slice(0, line.indexOf(id)) : '';
};

describe('renderDag', () => {
  it('shows the resolved provider after model-alias routing', () => {
    const out = renderDag(
      manifest([task({ id: 'ask-sonnet', model: 'sonnet' })]),
      theme,
      'codex',
    );
    expect(out).toContain('claude sonnet');
    expect(out).not.toContain('default sonnet');
  });

  it('shows a pinned model even when the provider is the run default', () => {
    const out = renderDag(manifest([task({ id: 'x', model: 'luna' })]), theme, 'codex');
    expect(out).toContain('codex luna');
  });

  it("falls back to 'default' when no default provider is passed and none is pinned", () => {
    const out = renderDag(manifest([task({ id: 'x' })]), theme);
    expect(out).toContain('default');
  });

  it('badges a read-write task and leaves read-only unbadged', () => {
    const out = renderDag(
      manifest([
        task({ id: 'reader', access: 'read-only' }),
        task({ id: 'writer', access: 'read-write' }),
      ]),
      theme,
      'codex',
    );
    expect(scaffoldOf(out, 'writer')).not.toContain('read-write');
    expect(out).toMatch(/writer.*read-write/);
    expect(out).not.toMatch(/reader.*read-write/);
  });

  it('draws a dependent nested under the task it depends on', () => {
    const out = renderDag(
      manifest([task({ id: 'root' }), task({ id: 'leaf', depends_on: ['root'] })]),
      theme,
      'codex',
    );
    // `leaf` is indented past `root` and hangs off a tree connector.
    expect(scaffoldOf(out, 'leaf').length).toBeGreaterThan(
      scaffoldOf(out, 'root').length,
    );
    expect(scaffoldOf(out, 'leaf')).toMatch(/[├└]/);
  });

  it('prints a shared dependency once in full, then as a reference', () => {
    const out = renderDag(
      manifest([
        task({ id: 'alpha' }),
        task({ id: 'beta' }),
        task({ id: 'shared', title: 'Shared step', depends_on: ['alpha', 'beta'] }),
      ]),
      theme,
      'codex',
    );
    const sharedRows = out.split('\n').filter((row) => /[├└]─ shared\b/.test(row));
    // Two appearances of `shared`: one under `alpha`, one under `beta`.
    expect(sharedRows.length).toBe(2);
    // One carries the full row, exactly one is the back-reference.
    expect(sharedRows.filter((row) => row.includes('(shown above)')).length).toBe(1);
    expect(sharedRows.filter((row) => row.includes('Shared step')).length).toBe(1);
  });

  it('heads the preview with the task and stage counts', () => {
    const out = renderDag(
      manifest([task({ id: 'a' }), task({ id: 'b', depends_on: ['a'] })]),
      theme,
      'codex',
    );
    expect(out).toContain('Run order · 2 tasks · 2 stages');
  });

  it("says 'stage', singular, for a one-stage plan", () => {
    const out = renderDag(manifest([task({ id: 'a' })]), theme, 'codex');
    expect(out).toContain('1 task · 1 stage');
    expect(out).not.toContain('1 stages');
  });

  /**
   * Grouping is the other half of what the gate is asking about: which tasks
   * share one process. The assertions are about *which tasks land together*,
   * not about how the line reads.
   */
  describe('group projection', () => {
    const sonnet = (id: string, deps: string[] = []): Task =>
      task({ id, model: 'claude-sonnet-5', depends_on: deps });

    const groupsIn = (out: string): Map<string, string> => {
      const found = new Map<string, string>();
      for (const line of out.split('\n')) {
        const match = line.match(/[├└]─ (\S+).*\(group (#\d+)\)/);
        if (match) found.set(match[1] as string, match[2] as string);
      }
      return found;
    };

    it('puts tasks that share a process under one group number', () => {
      const out = renderDag(
        manifest([sonnet('a'), sonnet('b'), task({ id: 'c', model: 'luna' })]),
        theme,
        'codex',
      );
      const groups = groupsIn(out);
      expect(groups.get('a')).toBe(groups.get('b'));
      expect(groups.get('c')).not.toBe(groups.get('a'));
    });

    it('shows a chain collapsing across stages into one process', () => {
      const groups = groupsIn(
        renderDag(manifest([sonnet('a'), sonnet('b', ['a'])]), theme, 'codex'),
      );
      expect(groups.get('b')).toBe(groups.get('a'));
    });

    it('counts the processes the run will spawn', () => {
      const out = renderDag(manifest([sonnet('a'), sonnet('b')]), theme, 'codex');
      expect(out).toContain('2 tasks · 1 stage · 1 process');
    });

    it('warns about a group that fills --group-size, naming it', () => {
      const out = renderDag(
        manifest([sonnet('a'), sonnet('b'), sonnet('c')]),
        theme,
        'codex',
        { groupSize: 3 },
      );
      const groups = groupsIn(out);
      expect(out).toContain(`group ${groups.get('a')} fills`);
      expect(out).toContain('--group-size 3');
    });

    it('stays quiet when no group holds more than one task', () => {
      const out = renderDag(manifest([sonnet('a'), sonnet('b')]), theme, 'codex', {
        groupSize: 1,
      });
      expect(out).not.toContain('group #');
      expect(out).not.toContain('processes');
    });

    /**
     * A task pinning the run's own model must not read as a separate process
     * from one that pins nothing — that split would exist in the preview only.
     */
    it('keys against the run defaults, as the scheduler does', () => {
      const groups = groupsIn(
        renderDag(
          manifest([task({ id: 'a' }), task({ id: 'b', model: 'gpt-5.6-luna' })]),
          theme,
          'codex',
          { defaultModel: 'gpt-5.6-luna' },
        ),
      );
      expect(groups.get('a')).toBe(groups.get('b'));
    });
  });
});
