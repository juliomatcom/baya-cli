import { readLog, runCli, taskResult } from '../helpers/runCli.js';

const ESC = String.fromCharCode(27);

const plan = (ids: string[]) => ({
  tasks: ids.map((id, index) => ({
    id,
    title: id,
    instruction: `do ${id}`,
    provider: 'codex',
    model: null,
    depends_on: index === 0 ? [] : [ids[index - 1] as string],
    access: 'read-only',
    cwd: null,
  })),
});

const chatty = {
  __planner__: { final: plan(['gen-schema']) },
  'gen-schema': {
    emit: [
      { line: '{"type":"thread.started","thread_id":"t-1"}' },
      {
        line: '{"type":"item.completed","item":{"type":"file_change","path":"migrations/001.sql"}}',
      },
      {
        line: '{"type":"item.completed","item":{"type":"agent_message","text":"Adding the FK from orders.user_id."}}',
      },
      { line: 'codex: warming up', stream: 'stderr' as const },
    ],
    final: taskResult('ok', {
      task_id: 'gen-schema',
      summary: 'Created 4 tables with FK constraints.',
      output: '## Schema\n\nfour tables',
      notes: [
        { severity: 'info', message: 'assumed utf8 collation' },
        { severity: 'warn', message: 'migration locks users for ~30s on big tables' },
        {
          severity: 'action_required',
          message: 'set STRIPE_WEBHOOK_SECRET before this ships',
        },
      ],
    }),
  },
};

describe('provider output bubbles up as info', () => {
  it('forwards prose, tool calls, and child stderr to the terminal, task-prefixed', async () => {
    const result = await runCli(['./tasks.md', '--yes'], { scenario: chatty });
    expect(result.stderr).toContain('Adding the FK from orders.user_id.');
    expect(result.stderr).toContain('Edit(migrations/001.sql)');
    expect(result.stderr).toContain('codex: warming up');
    for (const line of result.stderr.split('\n').filter((l) => l.includes('Edit('))) {
      expect(line).toContain('gen-schema');
    }
  });

  it('prints the exact provider command, with flags, as each task spawns', async () => {
    const result = await runCli(['./tasks.md', '--yes'], { scenario: chatty });
    const cmd = result.stderr
      .split('\n')
      .find((l) => l.includes('gen-schema') && l.includes('$ '));
    expect(cmd).toBeDefined();
    expect(cmd).toContain('exec');
    expect(cmd).toContain('--output-schema');
    expect(cmd).toContain('-s read-only');
    // codex takes the prompt on stdin, so it is simply absent from the command
    expect(cmd).not.toContain('do gen-schema');
  });

  it('hides session ids and unknown events from the terminal by default', async () => {
    const result = await runCli(['./tasks.md', '--yes'], { scenario: chatty });
    expect(result.stderr).not.toContain('t-1');
  });

  it('keeps the full stream in baya.jsonl at every verbosity', async () => {
    for (const flags of [['--quiet'], [], ['--verbose']]) {
      const result = await runCli(['./tasks.md', '--yes', ...flags], {
        scenario: chatty,
      });
      const events = readLog(result.paths!).map((line) => String(line['event']));
      expect(events).toContain('provider.text');
      expect(events).toContain('provider.tool');
      expect(events).toContain('provider.stderr');
      expect(events).toContain('provider.session');
    }
  });

  it('suppresses live output under --quiet but still prints notes', async () => {
    const result = await runCli(['./tasks.md', '--yes', '--quiet'], { scenario: chatty });
    expect(result.stderr).not.toContain('Adding the FK');
    expect(result.stderr).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('persists an ANSI-free event stream', async () => {
    const result = await runCli(['./tasks.md', '--yes'], {
      scenario: {
        __planner__: { final: plan(['gen-schema']) },
        'gen-schema': {
          emit: [
            {
              line: `${ESC}[32m{"type":"item.completed","item":{"type":"agent_message","text":"colored"}}${ESC}[0m`,
            },
          ],
          final: taskResult('ok', { task_id: 'gen-schema', summary: 'done', output: '' }),
        },
      },
    });
    const events = result.readText(result.paths!.events('gen-schema'));
    expect(events).not.toContain(ESC);
    expect(result.readText(result.paths!.stdout('gen-schema'))).not.toContain(ESC);
  });
});

describe('surfacing task output', () => {
  it("prints the summary's first line on completion", async () => {
    const result = await runCli(['./tasks.md', '--yes'], { scenario: chatty });
    expect(result.stderr).toContain('Created 4 tables with FK constraints.');
  });

  it('prints warn and action_required notes immediately, holding info for the report', async () => {
    const result = await runCli(['./tasks.md', '--yes'], { scenario: chatty });
    const beforeReport = result.stderr.slice(0, result.stderr.indexOf('Flagged'));

    expect(beforeReport).toContain('migration locks users');
    expect(beforeReport).toContain('STRIPE_WEBHOOK_SECRET');
    // `info` would bury the two that matter; it waits for the Flagged section.
    expect(beforeReport).not.toContain('assumed utf8 collation');
    expect(result.stderr).toContain('assumed utf8 collation');
  });

  it('prints the full output for a single-task run', async () => {
    const result = await runCli(['./tasks.md', '--yes'], { scenario: chatty });
    expect(result.stderr).toContain('four tables');
  });

  it('does not print full outputs for a multi-task run, which would bury everything', async () => {
    const twoTasks = {
      __planner__: { final: plan(['a', 'b']) },
      a: {
        final: taskResult('ok', {
          task_id: 'a',
          summary: 'did a',
          output: 'AAA-FULL-OUTPUT',
        }),
      },
      b: {
        final: taskResult('ok', {
          task_id: 'b',
          summary: 'did b',
          output: 'BBB-FULL-OUTPUT',
        }),
      },
    };
    const quiet = await runCli(['./tasks.md', '--yes'], { scenario: twoTasks });
    expect(quiet.stderr).not.toContain('AAA-FULL-OUTPUT');

    const loud = await runCli(['./tasks.md', '--yes', '--verbose'], {
      scenario: twoTasks,
    });
    expect(loud.stderr).toContain('AAA-FULL-OUTPUT');
  });
});

describe('the end-of-run report', () => {
  it('closes with a Flagged section, action_required first', async () => {
    const result = await runCli(['./tasks.md', '--yes'], { scenario: chatty });
    const flagged = result.stderr.slice(result.stderr.indexOf('Flagged'));
    expect(flagged.indexOf('STRIPE_WEBHOOK_SECRET')).toBeLessThan(
      flagged.indexOf('migration locks users'),
    );
  });

  it('omits the section entirely when no task raised anything', async () => {
    const result = await runCli(['./tasks.md', '--yes'], {
      scenario: {
        __planner__: { final: plan(['a']) },
        a: { final: taskResult('ok', { task_id: 'a', summary: 'clean', output: '' }) },
      },
    });
    expect(result.stderr).not.toContain('Flagged');
  });
});

describe('--json', () => {
  it('puts a single clean JSON document on stdout and nothing else', async () => {
    const result = await runCli(['./tasks.md', '--yes', '--json'], { scenario: chatty });
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout).not.toContain(ESC);
  });

  it('parses cleanly even with color forced on and a spinner requested', async () => {
    const result = await runCli(['./tasks.md', '--yes', '--json'], {
      scenario: chatty,
      stdoutIsTty: true,
      env: { FORCE_COLOR: '3', NO_COLOR: '' },
    });
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout).not.toContain(ESC);
  });

  it('carries per-task notes and the aggregated flagged list, losing nothing to a pipe', async () => {
    const result = await runCli(['./tasks.md', '--yes', '--json'], { scenario: chatty });
    const report = JSON.parse(result.stdout) as {
      tasks: Array<{ notes: Array<{ severity: string }>; summary: string }>;
      flagged: Array<{ severity: string; task_id: string }>;
      totals: Record<string, number>;
      exit_code: number;
    };
    expect(report.tasks[0]?.notes).toHaveLength(3);
    expect(report.tasks[0]?.summary).toContain('Created 4 tables');
    expect(report.flagged.map((note) => note.severity)).toEqual([
      'action_required',
      'warn',
      'info',
    ]);
    expect(report.totals.succeeded).toBe(1);
    expect(report.exit_code).toBe(0);
  });
});

/**
 * `--quiet` asks Baya to stop narrating the work, not to stop reporting it.
 * The other outcomes survived on level alone — `task.failed` is `error`,
 * `task.parked`/`task.skipped` are `warn` — so a quiet run used to show every
 * bad outcome and no good one.
 */
describe('--quiet keeps the outcomes and drops the chatter', () => {
  it('still prints the per-task result line', async () => {
    const result = await runCli(['./tasks.md', '--yes', '--quiet'], {
      scenario: chatty,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Created 4 tables with FK constraints.');
    // The narration around it is what --quiet is for.
    expect(result.stderr).not.toContain('Adding the FK from orders.user_id.');
    expect(result.stderr).not.toContain('codex: warming up');
  });
});
