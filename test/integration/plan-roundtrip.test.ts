import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, readLog, runCli, taskResult } from '../helpers/runCli.js';

const PLAN = {
  tasks: [
    {
      id: 'a',
      title: 'A',
      instruction: 'do a',
      provider: 'codex',
      model: null,
      depends_on: [],
      access: 'read-only',
      cwd: null,
    },
    {
      id: 'b',
      title: 'B',
      instruction: 'do b',
      provider: 'codex',
      model: null,
      depends_on: ['a'],
      access: 'read-only',
      cwd: null,
    },
  ],
};

const scenario = {
  __planner__: { final: PLAN },
  a: { final: taskResult('ok', { task_id: 'a', summary: 'did a' }) },
  b: { final: taskResult('ok', { task_id: 'b', summary: 'did b' }) },
};

describe('--plan-out / --plan-in', () => {
  it('writes the manifest and exits without executing', async () => {
    const workspace = makeWorkspace({ scenario });
    const out = join(workspace.cwd, 'plan.json');
    const result = await runCli(['./tasks.md', '--plan-out', 'plan.json'], { workspace });

    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(result.paths!.state)).toBe(false);

    const manifest = JSON.parse(readFileSync(out, 'utf8')) as {
      version: number;
      source: { sha256: string };
      tasks: Array<{ id: string }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.tasks.map((task) => task.id)).toEqual(['a', 'b']);
    expect(manifest.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('executes a reviewed manifest directly, skipping planning entirely', async () => {
    const workspace = makeWorkspace({ scenario });
    await runCli(['./tasks.md', '--plan-out', 'plan.json'], { workspace });
    const executed = await runCli(
      ['run', './tasks.md', '--plan-in', 'plan.json', '--yes'],
      {
        workspace,
      },
    );

    expect(executed.code).toBe(0);
    const events = readLog(executed.paths!).map((line) => String(line['event']));
    expect(events).not.toContain('plan.requested');
    expect(events).toContain('plan.validated');

    const state = executed.readJson(executed.paths!.state) as {
      tasks: Record<string, { state: string }>;
    };
    expect(state.tasks['a']?.state).toBe('succeeded');
    expect(state.tasks['b']?.state).toBe('succeeded');
  });

  it('produces an identical manifest on the round trip', async () => {
    const workspace = makeWorkspace({ scenario });
    await runCli(['./tasks.md', '--plan-out', 'plan.json'], { workspace });
    const first = readFileSync(join(workspace.cwd, 'plan.json'), 'utf8');

    const executed = await runCli(
      ['run', './tasks.md', '--plan-in', 'plan.json', '--yes'],
      {
        workspace,
      },
    );
    expect(executed.readText(executed.paths!.manifest)).toBe(first);
  });

  it('rejects an invalid manifest with exit 2, before spending anything', async () => {
    const workspace = makeWorkspace({ scenario });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(workspace.cwd, 'bad.json'),
      JSON.stringify({
        version: 1,
        source: { path: 'tasks.md', sha256: 'x' },
        tasks: [
          { id: 'a', title: 'A', instruction: 'i', depends_on: ['b'] },
          { id: 'b', title: 'B', instruction: 'i', depends_on: ['a'] },
        ],
      }),
    );

    const result = await runCli(['run', './tasks.md', '--plan-in', 'bad.json', '--yes'], {
      workspace,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('dependency cycle');
  });

  /**
   * `writes` became `access` (a clean break — the manifest is versioned and
   * nothing is published against it). A stale plan file must be refused
   * loudly: silently defaulting it to `read-only` would strip a task's
   * permission to run its own tests and blame the provider for the denials.
   */
  it('refuses a plan file still carrying the old `writes` key', async () => {
    const workspace = makeWorkspace();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(workspace.cwd, 'stale.json'),
      JSON.stringify({
        version: 1,
        source: { path: 'tasks.md', sha256: 'x' },
        tasks: [
          {
            id: 'a',
            title: 'A',
            instruction: 'i',
            provider: null,
            model: null,
            depends_on: [],
            writes: true,
            cwd: null,
          },
        ],
      }),
    );

    const result = await runCli(
      ['run', './tasks.md', '--plan-in', 'stale.json', '--yes'],
      { workspace },
    );
    expect(result.code).toBe(2);
  });
});
