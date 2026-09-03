import { buildReport, exitCodeFor, renderReport } from '../../../src/ui/report.js';
import { createTheme } from '../../../src/ui/theme.js';
import { emptyTaskEntry, type RunState } from '../../../src/executor/index.js';
import type { Failure } from '../../../src/executor/index.js';
import type { Manifest } from '../../../src/manifest/index.js';

const theme = createTheme('never');
const ESC = String.fromCharCode(27);

const manifest: Manifest = {
  version: 1,
  source: { path: 'tasks.md', sha256: 'abc' },
  tasks: [
    {
      id: 'gen-schema',
      title: 'Generate DB schema',
      instruction: 'i',
      provider: 'codex',
      model: null,
      depends_on: [],
      access: 'read-write',
      cwd: null,
    },
    {
      id: 'deploy-cfg',
      title: 'Deploy config',
      instruction: 'i',
      provider: 'codex',
      model: null,
      depends_on: ['gen-schema'],
      access: 'read-write',
      cwd: null,
    },
  ],
};

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    version: 1,
    run_id: '20260828T215204Z-a1f4c9-3182',
    status: 'completed',
    started_at: '2026-08-28T21:52:03.000Z',
    updated_at: '2026-08-28T21:52:50.000Z',
    source: { path: 'tasks.md', sha256: 'abc' },
    manifest_path: 'manifest.json',
    config_snapshot: {
      planner: { provider: 'codex', model: null },
      defaults: { provider: 'codex', model: null },
      max_parallel: 1,
      isolation: 'shared',
      context_strategy: 'link-only',
      context_budget: 12_000,
      memory: true,
      memory_budget: 1200,
      group_size: 6,
      retries: 1,
    },
    totals: {
      succeeded: 2,
      failed: 0,
      skipped: 0,
      parked: 0,
      pending: 0,
      running: 0,
      cost_usd: 0.42,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
    },
    tasks: {
      'gen-schema': emptyTaskEntry({
        state: 'succeeded',
        provider: 'codex',
        duration_ms: 8112,
        notes: [{ severity: 'warn', message: 'migration locks users for ~30s' }],
        artifacts: { output: 'tasks/gen-schema/output.md' },
      }),
      'deploy-cfg': emptyTaskEntry({
        state: 'succeeded',
        provider: 'codex',
        duration_ms: 4200,
        notes: [
          { severity: 'info', message: 'assumed utf8' },
          {
            severity: 'action_required',
            message: 'set STRIPE_WEBHOOK_SECRET before shipping',
          },
        ],
      }),
    },
    ...overrides,
  };
}

const report = (s = state()) => buildReport(s, manifest, { runDir: '/w/.baya/runs/r' });

describe('buildReport', () => {
  it('aggregates every note across tasks, action_required first', () => {
    expect(report().flagged.map((note) => [note.severity, note.task_id])).toEqual([
      ['action_required', 'deploy-cfg'],
      ['warn', 'gen-schema'],
      ['info', 'deploy-cfg'],
    ]);
  });

  it('carries per-task notes as well, so nothing is terminal-only', () => {
    const json = report();
    expect(json.tasks[0]?.notes).toHaveLength(1);
    expect(json.tasks[1]?.notes).toHaveLength(2);
  });

  it('computes the run duration from the state timestamps', () => {
    expect(report().duration_ms).toBe(47_000);
  });

  it('survives a JSON round-trip with no ANSI in it', () => {
    const text = JSON.stringify(report());
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain(ESC);
  });
});

describe('exitCodeFor', () => {
  it('is 0 when everything succeeded', () => {
    expect(exitCodeFor(state())).toBe(0);
  });

  it('is 1 when any task failed', () => {
    expect(exitCodeFor(state({ totals: { ...state().totals, failed: 1 } }))).toBe(1);
  });

  it('is 1 when work was skipped, since the run did not finish', () => {
    expect(exitCodeFor(state({ totals: { ...state().totals, skipped: 2 } }))).toBe(1);
  });

  it('is 130 on an interrupt', () => {
    expect(exitCodeFor(state({ status: 'interrupted' }))).toBe(130);
  });
});

describe('renderReport', () => {
  it('matches the recorded output', () => {
    expect(renderReport(report(), theme)).toMatchSnapshot();
  });

  it('omits the Flagged section entirely when there are no notes', () => {
    const clean = state({
      tasks: {
        'gen-schema': emptyTaskEntry({ state: 'succeeded' }),
        'deploy-cfg': emptyTaskEntry({ state: 'succeeded' }),
      },
    });
    const text = renderReport(report(clean), theme);
    expect(text).not.toContain('Flagged');
    expect(text).toMatchSnapshot();
  });

  it('puts the action_required note first, because it is what most needs a human', () => {
    const text = renderReport(report(), theme);
    expect(text.indexOf('STRIPE_WEBHOOK_SECRET')).toBeLessThan(
      text.indexOf('locks users'),
    );
  });

  it('reports token usage, and drops the $ figure when no provider gave one', () => {
    const withTokens = state({
      totals: {
        ...state().totals,
        cost_usd: 0,
        input_tokens: 122_271,
        output_tokens: 1570,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
      },
    });
    const text = renderReport(report(withTokens), theme);
    expect(text).toContain('124k tokens');
    expect(text).not.toContain('$0.00');
  });

  // A `<id>` placeholder in this line left the reader to assemble the path by
  // hand — the one thing the line exists to spare them.
  it('names the file itself when a single task wrote an output', () => {
    expect(renderReport(report(), theme)).toContain(
      '/w/.baya/runs/r/tasks/gen-schema/output.md',
    );
  });

  it('names the directory when several tasks wrote outputs', () => {
    const both = state({
      tasks: {
        'gen-schema': emptyTaskEntry({
          state: 'succeeded',
          artifacts: { output: 'tasks/gen-schema/output.md' },
        }),
        'deploy-cfg': emptyTaskEntry({
          state: 'succeeded',
          artifacts: { output: 'tasks/deploy-cfg/output.md' },
        }),
      },
    });
    const text = renderReport(report(both), theme);
    expect(text).toContain('/w/.baya/runs/r/tasks');
    expect(text).not.toContain('output.md');
  });
});

describe('the Next block — how to pick an unfinished run back up', () => {
  const failure = (kind: Failure['kind']): Failure => ({
    kind,
    message: `${kind} happened`,
    provider_code: null,
    status_code: null,
    retry: 'now',
    occurred_at: '2026-08-28T21:52:40.000Z',
  });

  const stopped = (
    kind: Failure['kind'],
    totals: Partial<RunState['totals']> = {},
  ): RunState =>
    state({
      status: 'failed',
      totals: { ...state().totals, succeeded: 0, failed: 1, skipped: 1, ...totals },
      tasks: {
        'gen-schema': emptyTaskEntry({ state: 'failed', failure: failure(kind) }),
        'deploy-cfg': emptyTaskEntry({ state: 'skipped', blocked_by: 'gen-schema' }),
      },
    });

  it('says nothing after a clean run — success must not end on recovery advice', () => {
    expect(report().next).toBeNull();
    expect(renderReport(report(), theme)).not.toContain('Next');
  });

  it('names the resume command for the run that actually failed', () => {
    const text = renderReport(report(stopped('network')), theme);
    expect(text).toContain('baya resume 20260828T215204Z-a1f4c9-3182');
  });

  it('leads with the command, not the diagnosis — the command is the point', () => {
    const text = renderReport(report(stopped('network')), theme);
    const block = text.slice(text.indexOf('Next'));
    expect(block.indexOf('baya resume')).toBeLessThan(block.indexOf('unreachable'));
    // On the `Next` line itself, not buried under a wrapped explanation.
    expect(block.split('\n')[0]).toContain('baya resume');
  });

  it('names the cause, so the reader knows what to go and fix', () => {
    // The failure that motivated this block: an agent that could not resolve a
    // hostname reported `ENOTFOUND` and nothing about what to do next.
    expect(report(stopped('network')).next?.cause).toContain('network was unreachable');
    expect(report(stopped('auth')).next?.cause).toContain('credentials');
    expect(report(stopped('quota')).next?.cause).toContain('--provider');
  });

  it('reports the dominant failure, not whichever task is listed first', () => {
    // One `quota` halts the whole run, so every other failure is downstream of
    // it. Naming a symptom would send the reader to fix the wrong thing.
    const mixed = state({
      status: 'failed',
      totals: { ...state().totals, succeeded: 0, failed: 2, skipped: 0 },
      tasks: {
        'gen-schema': emptyTaskEntry({ state: 'failed', failure: failure('crash') }),
        'deploy-cfg': emptyTaskEntry({ state: 'failed', failure: failure('quota') }),
      },
    });
    expect(buildReport(mixed, manifest, { runDir: '/out' }).next?.cause).toContain(
      'allowance is spent',
    );
  });

  it('promises that finished work is kept — the reason to resume over re-running', () => {
    const partial = stopped('network', { succeeded: 1, failed: 1, skipped: 0 });
    expect(buildReport(partial, manifest, { runDir: '/out' }).next?.scope).toBe(
      'Picks up where this stopped: re-runs 1 failed, keeps the 1 that succeeded.',
    );
  });

  it('counts only what will actually run again', () => {
    expect(report(stopped('network')).next?.scope).toBe(
      'Picks up where this stopped: re-runs 1 failed and 1 skipped.',
    );
  });

  it('offers a resume after an interrupt, which fails nothing at all', () => {
    // Ctrl+C leaves tasks that never started: `pending`, not `failed` or
    // `skipped`. Counting only failures promised to re-run nothing at all.
    const stoppedByHand = state({
      status: 'interrupted',
      totals: { ...state().totals, succeeded: 1, failed: 0, skipped: 0, pending: 1 },
    });
    const next = buildReport(stoppedByHand, manifest, { runDir: '/out' }).next;
    expect(next?.cause).toContain('interrupted');
    expect(next?.scope).toBe(
      'Picks up where this stopped: re-runs 1 unfinished, keeps the 1 that succeeded.',
    );
  });

  it('reaches --json too: the block is report data, not terminal decoration', () => {
    const parsed = JSON.parse(JSON.stringify(report(stopped('network'))));
    expect(parsed.next).toEqual({
      cause: expect.stringContaining('network'),
      command: 'baya resume 20260828T215204Z-a1f4c9-3182',
      scope: expect.any(String),
    });
  });

  it('matches the recorded output', () => {
    expect(renderReport(report(stopped('network')), theme)).toMatchSnapshot();
  });
});

describe('process count', () => {
  const started = '2026-08-28T21:52:04.000Z';

  const report = (tasks: RunState['tasks']) =>
    buildReport(state({ tasks }), manifest, { runDir: '/out' });

  it('counts one process for a whole group, not one per task', () => {
    const { processes } = report({
      'gen-schema': emptyTaskEntry({
        state: 'succeeded',
        started_at: started,
        group_id: 'gen-schema',
      }),
      'deploy-cfg': emptyTaskEntry({
        state: 'succeeded',
        started_at: started,
        group_id: 'gen-schema',
      }),
    });
    expect(processes).toBe(1);
  });

  it('counts an ungrouped task as its own process', () => {
    const { processes } = report({
      'gen-schema': emptyTaskEntry({ state: 'succeeded', started_at: started }),
      'deploy-cfg': emptyTaskEntry({ state: 'succeeded', started_at: started }),
    });
    expect(processes).toBe(2);
  });

  /** A skipped task never reached `running`, so no CLI was ever launched for it. */
  it('does not count a task that never spawned', () => {
    const { processes } = report({
      'gen-schema': emptyTaskEntry({ state: 'failed', started_at: started }),
      'deploy-cfg': emptyTaskEntry({ state: 'skipped', blocked_by: 'gen-schema' }),
    });
    expect(processes).toBe(1);
  });

  it('shows the count in the summary, and says nothing for a single task', () => {
    const many = renderReport(
      report({
        'gen-schema': emptyTaskEntry({ state: 'succeeded', started_at: started }),
        'deploy-cfg': emptyTaskEntry({ state: 'succeeded', started_at: started }),
      }),
      theme,
    );
    expect(many).toContain('2 processes');

    const one = buildReport(
      state({
        tasks: {
          'gen-schema': emptyTaskEntry({ state: 'succeeded', started_at: started }),
        },
      }),
      { ...manifest, tasks: [manifest.tasks[0]!] },
      { runDir: '/out' },
    );
    expect(renderReport(one, theme)).not.toContain('process');
  });
});

/**
 * The badge is graded on how much of the run landed, not on whether anything
 * threw. A run with nothing `failed` but half its tasks `skipped` did not
 * complete, and the old `failed > 0` test called that one green.
 */
describe('outcome badge', () => {
  const summary = (totals: Partial<RunState['totals']>) =>
    renderReport(
      buildReport(
        state({ totals: { ...state().totals, ...totals } as RunState['totals'] }),
        manifest,
        { runDir: '/out' },
      ),
      theme,
    );

  it('is complete only when every task succeeded', () => {
    expect(summary({ succeeded: 2 })).toContain('Run complete');
  });

  it('is finished, not complete, when some tasks did not succeed', () => {
    expect(summary({ succeeded: 1, failed: 1 })).toContain('Run finished');
    // Nothing failed here — the tasks were skipped — and it still is not complete.
    expect(summary({ succeeded: 1, skipped: 1 })).toContain('Run finished');
  });

  it('is failed when nothing succeeded', () => {
    expect(summary({ succeeded: 0, failed: 2 })).toContain('Run failed');
  });

  // A question is the escalation protocol working, not an agent failing: a run
  // waiting on a human is paused, whatever else did or did not land.
  it('is paused when a task asked a question and nothing failed', () => {
    expect(summary({ succeeded: 0, parked: 1 })).toContain('Run paused');
    expect(summary({ succeeded: 1, parked: 1 })).toContain('Run paused');
    expect(summary({ succeeded: 0, parked: 1 })).not.toContain('Run failed');
  });

  it('is failed, not paused, when something actually failed alongside', () => {
    expect(summary({ succeeded: 0, failed: 1, parked: 1 })).toContain('Run failed');
  });
});
