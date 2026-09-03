import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeTaskResultBatchSchema,
  writeTaskResultSchema,
  type Manifest,
} from '../../src/manifest/index.js';
import { createRegistry } from '../../src/providers/index.js';
import { codexAdapter } from '../../src/providers/codex.js';
import {
  StateStore,
  emptyTaskEntry,
  killGroup,
  makeRunId,
  runPaths,
  runSequential,
  type RunState,
} from '../../src/executor/index.js';
import { SIGINT_EXIT_CODE, createInterruptHandler } from '../../src/cli/interrupt.js';
import { createProgress } from '../../src/ui/progress.js';
import { captureLogger } from '../helpers/logger.js';
import { FAKE_PROVIDER } from '../helpers/runCli.js';
import { sealedEnv } from '../helpers/env.js';

/**
 * Case 4, testing.md: a long fake provider that spawns a grandchild and traps
 * SIGTERM; Ctrl+C mid-flight ⇒ exit 130, **zero surviving pids**, grandchild
 * included — verified with `ps`, never inferred from the run promise.
 *
 * The scheduler and the fake provider are real; only the grace timer and
 * `exit` are injected, so no real signal is sent to the test runner.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Every pid `ps` will show us, or null when `ps` is missing or errors. */
function psPids(): Set<number> | null {
  const result = spawnSync('ps', ['-A', '-o', 'pid=']);
  if (result.status !== 0 || result.stdout === null || result.stdout.length === 0) {
    return null;
  }
  return new Set(
    result.stdout
      .toString('utf8')
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid)),
  );
}

/**
 * `ps` is missing or filtered in some sandboxes — there it reports nothing
 * rather than failing, which would pass this test while proving nothing. It
 * counts only if it runs *and* lists this very process; otherwise it cannot be
 * trusted to reveal a surviving child, and an empty result is not proof of a
 * clean teardown. Those runs skip, naming the reason.
 */
const PS_USABLE = psPids()?.has(process.pid) === true;

/** Pids whose parent is `ppid`, via `ps` (portable across BSD/GNU). */
function childPids(ppid: number): number[] {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=']);
  return result.stdout
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === ppid)
    .map(([pid]) => pid as number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const TASK_ID = 'hang';

function manifest(): Manifest {
  return {
    version: 1,
    source: { path: 'tasks.md', sha256: 'abc' },
    tasks: [
      {
        id: TASK_ID,
        title: 'Hang',
        instruction: 'hang',
        provider: 'codex',
        model: null,
        depends_on: [],
        access: 'read-only',
        cwd: null,
      },
    ],
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
      max_parallel: 2,
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
      pending: 1,
      running: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
    },
    tasks: { [TASK_ID]: emptyTaskEntry() },
  };
}

(PS_USABLE ? describe : describe.skip)(
  "SIGINT process-tree teardown (needs a ps that lists this process's own pids)",
  () => {
    it('SIGKILLs the provider group and its grandchild, then exits 130', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'baya-interrupt-'));
      const runId = makeRunId();
      const paths = runPaths(cwd, runId);
      mkdirSync(paths.runDir, { recursive: true });
      mkdirSync(paths.schemaDir, { recursive: true });

      const scenarioPath = join(cwd, 'scenario.json');
      writeFileSync(
        scenarioPath,
        JSON.stringify({
          by_task: {
            [TASK_ID]: { hang_ms: 30_000, spawn_child: true, on_signal: 'ignore' },
          },
        }),
      );

      const store = new StateStore(paths.state, initialState(runId));
      const registry = createRegistry([codexAdapter]);
      const activePids = new Set<number>();

      const runPromise = runSequential({
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
        maxParallel: 2,
        retries: 0,
        env: sealedEnv({ BAYA_FAKE_SCRIPT: scenarioPath }),
        onProcessSpawn: (pid) => activePids.add(pid),
        onProcessExit: (pid) => activePids.delete(pid),
      });

      // Wait for the provider process, then for the grandchild it spawns.
      for (let i = 0; i < 60 && activePids.size === 0; i += 1) await sleep(50);
      expect(activePids.size).toBe(1);
      const providerPid = [...activePids][0]!;

      let grandchildPid: number | undefined;
      for (let i = 0; i < 60 && grandchildPid === undefined; i += 1) {
        grandchildPid = childPids(providerPid)[0];
        if (grandchildPid === undefined) await sleep(50);
      }
      // `ps` is usable (it lists our own pid) and the fixture spawns a child, so
      // an absent grandchild is a real failure, never a quietly-skipped one.
      expect(grandchildPid).toBeDefined();

      const grace: Array<() => void> = [];
      let exitCode: number | undefined;
      const handler = createInterruptHandler({
        progress: createProgress({ disabled: true, installExitGuard: false }),
        logger: captureLogger().logger,
        activePids: () => activePids,
        killGroup,
        checkpointInterrupted: () => store.setStatus('interrupted'),
        releaseLock: () => undefined,
        exit: (code) => {
          exitCode = code;
        },
        setTimer: (fn) => {
          grace.push(fn);
          return fn;
        },
        clearTimer: () => undefined,
      });

      // First Ctrl+C: SIGTERM the group. The provider traps it, so it is still
      // alive — and hung — when the grace window opens.
      handler();
      await sleep(200);
      expect(alive(providerPid)).toBe(true);

      // Grace elapses: SIGKILL the whole group.
      expect(grace).toHaveLength(1);
      grace[0]!();

      await runPromise;

      for (let i = 0; i < 40 && (alive(providerPid) || alive(grandchildPid!)); i += 1) {
        await sleep(50);
      }
      expect(alive(providerPid)).toBe(false);
      expect(alive(grandchildPid!)).toBe(false);
      expect(activePids.size).toBe(0);
      expect(exitCode).toBe(SIGINT_EXIT_CODE);
    }, 20_000);
  },
);
