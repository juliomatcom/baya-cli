import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeTaskResultBatchSchema,
  writeTaskResultSchema,
  type Manifest,
} from '../../../src/manifest/index.js';
import { createRegistry } from '../../../src/providers/index.js';
import { codexAdapter } from '../../../src/providers/codex.js';
import {
  StateStore,
  emptyTaskEntry,
  makeRunId,
  runPaths,
  runSequential,
  type RunState,
} from '../../../src/executor/index.js';
import { captureLogger } from '../../helpers/logger.js';
import { FAKE_PROVIDER } from '../../helpers/runCli.js';

/**
 * `onProcessSpawn` / `onProcessExit` are the pair `src/cli/run.ts` and
 * `src/cli/resume.ts` keep `activePids` from. The scheduler must fire spawn
 * once per process, fire exit for that exact pid when it settles, and never
 * lose or double-count one — otherwise Ctrl+C signals a stale pid or misses a
 * live group.
 */
const TASK_IDS = ['a', 'b', 'c'] as const;

function manifest(): Manifest {
  return {
    version: 1,
    source: { path: 'tasks.md', sha256: 'abc' },
    tasks: TASK_IDS.map((id) => ({
      id,
      title: `Task ${id}`,
      instruction: 'do it',
      provider: 'codex' as const,
      model: null,
      depends_on: [],
      access: 'read-only' as const,
      cwd: null,
    })),
  };
}

function initialState(runId: string): RunState {
  return {
    version: 1,
    run_id: runId,
    status: 'running',
    started_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:00:00.000Z',
    source: { path: 'tasks.md', sha256: 'abc' },
    manifest_path: 'manifest.json',
    config_snapshot: {
      planner: { provider: 'codex', model: null },
      defaults: { provider: 'codex', model: null },
      max_parallel: 3,
      isolation: 'shared',
      context_strategy: 'link-only',
      context_budget: 12_000,
      memory: false,
      memory_budget: 1200,
      group_size: 1,
      retries: 0,
    },
    totals: {
      succeeded: 0,
      failed: 0,
      skipped: 0,
      parked: 0,
      pending: TASK_IDS.length,
      running: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
    },
    tasks: Object.fromEntries(TASK_IDS.map((id) => [id, emptyTaskEntry()])),
  };
}

describe('scheduler pid callbacks', () => {
  it('pairs every spawn with an exit for the same pid, across parallel processes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'baya-pids-'));
    const runId = makeRunId();
    const paths = runPaths(cwd, runId);
    mkdirSync(paths.runDir, { recursive: true });
    mkdirSync(paths.schemaDir, { recursive: true });

    const scenarioPath = join(cwd, 'scenario.json');
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        by_task: Object.fromEntries(
          TASK_IDS.map((id) => [
            id,
            {
              hang_ms: 200,
              final: {
                baya: '1',
                kind: 'task_result',
                task_id: id,
                status: 'ok',
                summary: id,
              },
            },
          ]),
        ),
      }),
    );

    const store = new StateStore(paths.state, initialState(runId));
    const registry = createRegistry([codexAdapter]);

    const spawned: number[] = [];
    const exited: number[] = [];
    const active = new Set<number>();
    let peak = 0;

    await runSequential({
      manifest: manifest(),
      cwd,
      paths,
      registry,
      logger: captureLogger().logger,
      store,
      schemaPath: writeTaskResultSchema(paths.schemaDir),
      batchSchemaPath: writeTaskResultBatchSchema(paths.schemaDir),
      defaultProvider: 'codex',
      defaultModel: null,
      binOverrides: { codex: FAKE_PROVIDER },
      memory: false,
      groupSize: 1,
      maxParallel: 3,
      retries: 0,
      env: { ...process.env, BAYA_FAKE_SCRIPT: scenarioPath },
      onProcessSpawn: (pid) => {
        spawned.push(pid);
        active.add(pid);
        peak = Math.max(peak, active.size);
      },
      onProcessExit: (pid) => {
        exited.push(pid);
        // The pid must currently be tracked — an exit for an unknown or
        // already-removed pid is exactly the stale/reused-pid bug.
        expect(active.has(pid)).toBe(true);
        active.delete(pid);
      },
    });

    const asc = (a: number, b: number): number => a - b;
    expect(store.get().totals.succeeded).toBe(3);
    expect(spawned).toHaveLength(3);
    expect([...exited].sort(asc)).toEqual([...spawned].sort(asc));
    // codex caps at 2 concurrent processes: two overlap, then the third spawns
    // only after one has exited and been removed — the reuse path.
    expect(peak).toBe(2);
    // Nothing left tracked once the run is done.
    expect(active.size).toBe(0);
    // No pid settled twice.
    expect(new Set(exited).size).toBe(exited.length);
  });
});
