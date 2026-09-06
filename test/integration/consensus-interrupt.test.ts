import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCritiqueResultSchema } from '../../src/manifest/index.js';
import { codexAdapter } from '../../src/providers/codex.js';
import { killGroup } from '../../src/executor/index.js';
import { runPlannerProvider } from '../../src/planner/index.js';
import { SIGINT_EXIT_CODE, createInterruptHandler } from '../../src/cli/interrupt.js';
import { createProgress } from '../../src/ui/progress.js';
import { createBlock } from '../../src/ui/block.js';
import { createTheme } from '../../src/ui/theme.js';
import { captureLogger } from '../helpers/logger.js';
import { FAKE_PROVIDER } from '../helpers/runCli.js';
import { sealedEnv } from '../helpers/env.js';

/**
 * Ctrl+C during a consensus round must reap every process it spawned,
 * grandchildren included, and clear the live block on the way out.
 *
 * Verified with `ps`, never inferred from a promise: the fake provider traps
 * SIGTERM and spawns a child, so only a real group SIGKILL ends it.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  );
}

function childPids(parent: number): number[] {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=']);
  if (result.status !== 0) return [];
  return result.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((pair) => pair.length === 2 && pair[1] === parent)
    .map((pair) => pair[0] as number);
}

const alive = (pid: number): boolean => psPids()?.has(pid) ?? false;
const PS_USABLE = psPids()?.has(process.pid) === true;

(PS_USABLE ? describe : describe.skip)('consensus SIGINT teardown', () => {
  it('SIGKILLs every reviewer process and its grandchild, then exits 130', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'baya-consensus-int-'));
    const schemaDir = join(cwd, '.baya', 'schema');
    mkdirSync(schemaDir, { recursive: true });
    const schemaPath = writeCritiqueResultSchema(schemaDir);

    const scenarioPath = join(cwd, 'scenario.json');
    writeFileSync(
      scenarioPath,
      JSON.stringify({ hang_ms: 30_000, spawn_child: true, on_signal: 'ignore' }),
    );

    const live = new Set<number>();
    const env = sealedEnv({ BAYA_FAKE_SCRIPT: scenarioPath });

    // Two reviewers in flight at once — a round is a fan-out, so one surviving
    // process would be as bad as all of them.
    const calls = ['reviewer-a', 'reviewer-b'].map((id) =>
      runPlannerProvider({
        adapter: codexAdapter,
        bin: FAKE_PROVIDER,
        cwd,
        model: null,
        schemaPath,
        resultFile: join(cwd, id, 'result.json'),
        runId: 'consensus-test',
        logger: captureLogger().logger,
        env,
        timeoutMs: 30_000,
        taskId: id,
        onProcessSpawn: (pid) => live.add(pid),
        onProcessExit: (pid) => live.delete(pid),
      })('review this', 0),
    );

    for (let i = 0; i < 80 && live.size < 2; i += 1) await sleep(50);
    expect(live.size).toBe(2);
    const providerPids = [...live];

    const grandchildren: number[] = [];
    for (const pid of providerPids) {
      let child: number | undefined;
      for (let i = 0; i < 60 && child === undefined; i += 1) {
        child = childPids(pid)[0];
        if (child === undefined) await sleep(50);
      }
      expect(child).toBeDefined();
      grandchildren.push(child as number);
    }

    // The block is the second owner of the terminal; teardown must clear it.
    let blockDisposed = false;
    const theme = createTheme('never');
    const block = createBlock({ theme, disabled: true });
    const progress = createProgress({ disabled: true, installExitGuard: false });

    const grace: Array<() => void> = [];
    let exitCode: number | undefined;
    const handler = createInterruptHandler({
      progress: {
        ...progress,
        dispose: () => {
          blockDisposed = true;
          block.dispose();
          progress.dispose();
        },
      },
      logger: captureLogger().logger,
      activePids: () => live,
      killGroup,
      checkpointInterrupted: () => undefined,
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

    // First Ctrl+C: SIGTERM the groups. The fixture traps it and stays alive.
    handler();
    await sleep(200);
    expect(providerPids.some((pid) => alive(pid))).toBe(true);

    // Grace elapses: SIGKILL every group.
    expect(grace).toHaveLength(1);
    grace[0]?.();

    await Promise.allSettled(calls);

    for (let i = 0; i < 60; i += 1) {
      if (![...providerPids, ...grandchildren].some((pid) => alive(pid))) break;
      await sleep(50);
    }

    for (const pid of providerPids) expect(alive(pid)).toBe(false);
    for (const pid of grandchildren) expect(alive(pid)).toBe(false);
    expect(live.size).toBe(0);
    expect(exitCode).toBe(SIGINT_EXIT_CODE);
    expect(blockDisposed).toBe(true);
  }, 30_000);
});
