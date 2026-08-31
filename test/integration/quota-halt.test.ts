import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, runCli, taskResult, type Workspace } from '../helpers/runCli.js';
import { FAKE_PROVIDER } from '../helpers/runCli.js';

/**
 * A `quota` failure halts the whole run, not just the provider that hit it
 * (execution.md §Failure semantics). `quota-task` runs on claude and fails
 * classified `quota`; `slow-task` is already in flight on codex and finishes;
 * `after-slow` and `independent` never start and are `skipped` carrying the
 * quota `failure` — which is what tells them apart from a plain dependency
 * skip (that leaves `failure` null, see failure.test.ts). The run stays
 * resumable and a `baya resume` picks up exactly the work that never ran.
 */
const PLAN = {
  tasks: [
    {
      id: 'quota-task',
      title: 'Quota task',
      instruction: 'do the thing that hits the wall',
      provider: 'claude',
      model: null,
      depends_on: [],
      access: 'read-only',
      cwd: null,
    },
    {
      id: 'slow-task',
      title: 'Slow task',
      instruction: 'take a while on the other provider',
      provider: 'codex',
      model: null,
      depends_on: [],
      access: 'read-only',
      cwd: null,
    },
    {
      id: 'after-slow',
      title: 'After slow',
      instruction: 'run once slow-task is done',
      provider: 'codex',
      model: null,
      depends_on: ['slow-task'],
      access: 'read-only',
      cwd: null,
    },
    {
      id: 'independent',
      title: 'Independent',
      instruction: 'unrelated branch',
      provider: 'codex',
      model: null,
      depends_on: [],
      access: 'read-only',
      cwd: null,
    },
  ],
};

const TWO_PROVIDERS = {
  providers: { codex: { bin: FAKE_PROVIDER }, claude: { bin: FAKE_PROVIDER } },
};

interface Marker {
  pid: number;
  event: 'start' | 'end';
}

function markers(path: string): Marker[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Marker);
}

/** The halted first run, plus the marker file its processes wrote to. */
async function haltedRun(): Promise<{
  workspace: Workspace;
  paths: NonNullable<Awaited<ReturnType<typeof runCli>>['paths']>;
  runId: string;
  markerPath: string;
}> {
  const workspace = makeWorkspace({ config: TWO_PROVIDERS });
  const markerPath = join(workspace.cwd, 'markers.jsonl');
  writeFileSync(
    workspace.scenarioPath,
    JSON.stringify({
      by_task: {
        __planner__: { final: PLAN },
        'quota-task': {
          writes_file: markerPath,
          final: taskResult('failed', {
            task_id: 'quota-task',
            summary: '',
            error: {
              message:
                'You have exceeded your monthly quota — credit balance too low (402)',
              retryable: false,
            },
          }),
        },
        'slow-task': {
          hang_ms: 400,
          writes_file: markerPath,
          final: taskResult('ok', {
            task_id: 'slow-task',
            summary: 'slow done',
            output: '# slow',
          }),
        },
        'after-slow': {
          writes_file: markerPath,
          final: taskResult('ok', {
            task_id: 'after-slow',
            summary: 'after',
            output: '# after',
          }),
        },
        independent: {
          writes_file: markerPath,
          final: taskResult('ok', {
            task_id: 'independent',
            summary: 'indep',
            output: '# indep',
          }),
        },
      },
    }),
  );

  const first = await runCli(
    ['./tasks.md', '--yes', '--group-size', '1', '--max-parallel', '2'],
    { workspace },
  );
  expect(first.code).toBe(1);
  return { workspace, paths: first.paths!, runId: first.runId!, markerPath };
}

describe('quota halt and resumability', () => {
  it('halts admission run-wide, drains in-flight work, skips the rest with the quota failure', async () => {
    const { paths, markerPath } = await haltedRun();
    const state = JSON.parse(readFileSync(paths.state, 'utf8')) as {
      status: string;
      totals: Record<string, number>;
      tasks: Record<
        string,
        {
          state: string;
          attempts: number;
          started_at: string | null;
          blocked_by: string | null;
          failure: { kind: string; retry: string } | null;
        }
      >;
    };

    // The task that hit the wall, and the independent one already in flight
    // elsewhere — which was allowed to finish, not killed.
    expect(state.tasks['quota-task']).toMatchObject({ state: 'failed' });
    expect(state.tasks['quota-task']?.failure?.kind).toBe('quota');
    expect(state.tasks['slow-task']).toMatchObject({ state: 'succeeded' });

    // Never-started tasks: `skipped`, and carrying the quota `failure` so they
    // read apart from a dependency skip. `after-slow` is downstream of a task
    // that *succeeded*, so dependency logic would never have skipped it — this
    // skip can only be the halt.
    for (const id of ['after-slow', 'independent']) {
      expect(state.tasks[id]).toMatchObject({
        state: 'skipped',
        blocked_by: 'quota-task',
      });
      expect(state.tasks[id]?.failure).toMatchObject({ kind: 'quota', retry: 'later' });
      expect(state.tasks[id]?.started_at).toBeNull();
      expect(state.tasks[id]?.attempts).toBe(0);
    }

    // No process started on either provider after the quota failure: only
    // `quota-task` and `slow-task` ever ran, and both wrote a matching `end`.
    const starts = markers(markerPath).filter((m) => m.event === 'start');
    const ends = markers(markerPath).filter((m) => m.event === 'end');
    expect(starts).toHaveLength(2);
    expect(new Set(ends.map((m) => m.pid))).toEqual(new Set(starts.map((m) => m.pid)));

    expect(state.status).toBe('failed');
    expect(state.totals).toMatchObject({ succeeded: 1, failed: 1, skipped: 2 });
  });

  it('resumes to target exactly the tasks that never ran', async () => {
    const { workspace, paths, runId } = await haltedRun();
    const before = JSON.parse(readFileSync(paths.state, 'utf8')) as {
      tasks: Record<string, { attempts: number; ended_at: string | null }>;
    };

    const slowMarker = join(workspace.cwd, 'slow-reran.jsonl');
    writeFileSync(
      workspace.scenarioPath,
      JSON.stringify({
        by_task: {
          __planner__: { final: PLAN },
          'quota-task': {
            final: taskResult('ok', {
              task_id: 'quota-task',
              summary: 'recovered',
              output: '# ok',
            }),
          },
          // `slow-task` already succeeded — it must not be touched again.
          'slow-task': { writes_file: slowMarker, exit_code: 1, final: null },
          'after-slow': {
            final: taskResult('ok', {
              task_id: 'after-slow',
              summary: 'after',
              output: '# after',
            }),
          },
          independent: {
            final: taskResult('ok', {
              task_id: 'independent',
              summary: 'indep',
              output: '# indep',
            }),
          },
        },
      }),
    );

    const resumed = await runCli(['resume', runId, '--group-size', '1'], { workspace });
    expect(resumed.code).toBe(0);
    expect(existsSync(slowMarker)).toBe(false);

    const after = JSON.parse(readFileSync(paths.state, 'utf8')) as {
      status: string;
      run_id: string;
      totals: Record<string, number>;
      tasks: Record<string, { state: string; attempts: number; ended_at: string | null }>;
    };
    expect(after.status).toBe('completed');
    expect(after.run_id).toBe(runId);
    expect(after.totals).toMatchObject({ succeeded: 4, failed: 0, skipped: 0 });

    // Re-run: the one that hit the wall and the two the halt never let start.
    expect(after.tasks['quota-task']?.state).toBe('succeeded');
    expect(after.tasks['quota-task']?.attempts).toBe(2);
    expect(after.tasks['after-slow']?.attempts).toBe(1);
    expect(after.tasks['independent']?.attempts).toBe(1);

    // Kept: the in-flight task that completed. Not re-run, not re-timed.
    expect(after.tasks['slow-task']?.attempts).toBe(before.tasks['slow-task']?.attempts);
    expect(after.tasks['slow-task']?.ended_at).toBe(before.tasks['slow-task']?.ended_at);
  });
});
