import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPlannerProvider } from '../../../src/planner/provider.js';
import { codexAdapter } from '../../../src/providers/codex.js';
import { writePlanDraftSchema } from '../../../src/manifest/index.js';
import { captureLogger } from '../../helpers/logger.js';

const FAKE_PROVIDER = fileURLToPath(
  new URL('../../fixtures/fake-provider.mjs', import.meta.url),
);

/**
 * The planner's process group has to reach the CLI's interrupt teardown.
 *
 * `activePids` is fed by the executor's hooks; the planner spawns through the
 * same `runProcess` but used to pass none, so during planning the live set was
 * empty. SIGINT then took the "nothing in flight" fast path, baya exited, and
 * the planner kept running orphaned — measured 2026-08-31 with `opencode run`
 * surviving with no parent, still spending.
 *
 * What matters is the pair, not the number: reported on spawn, and cleared on
 * *every* exit path, because a pid left in the set is SIGKILLed blind after
 * the OS reuses it.
 */
function harness(scenario: unknown): {
  run: (prompt: string, attempt: number) => Promise<string>;
  spawned: number[];
  exited: number[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'baya-planner-pid-'));
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const schemaPath = writePlanDraftSchema(dir);

  const spawned: number[] = [];
  const exited: number[] = [];
  return {
    spawned,
    exited,
    run: runPlannerProvider({
      adapter: codexAdapter,
      bin: FAKE_PROVIDER,
      cwd: dir,
      model: null,
      schemaPath,
      resultFile: join(dir, 'plan-draft.json'),
      runId: 'run-1',
      logger: captureLogger().logger,
      env: { ...process.env, BAYA_FAKE_SCRIPT: scenarioPath },
      onProcessSpawn: (pid) => spawned.push(pid),
      onProcessExit: (pid) => exited.push(pid),
    }),
  };
}

describe('runPlannerProvider process registration', () => {
  it('reports the planner pid and clears it once the planner is done', async () => {
    const h = harness({ __planner__: { final: { tasks: [] } } });
    await h.run('plan this', 1);

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toBeGreaterThan(0);
    expect(h.exited).toEqual(h.spawned);
  });

  it('clears the pid even when the planner exits non-zero', async () => {
    const h = harness({ __planner__: { exit_code: 1, stderr: 'boom' } });
    await h.run('plan this', 1).catch(() => undefined);

    expect(h.spawned).toHaveLength(1);
    expect(h.exited).toEqual(h.spawned);
  });
});
