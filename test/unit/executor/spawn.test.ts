import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, type Timers } from '../../../src/executor/index.js';
import { FAKE_PROVIDER } from '../../helpers/runCli.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A controllable stand-in for `setTimeout`: timers are queued, not run, and
 * `fireNext` fires the earliest still-live one — the deadline first, then the
 * SIGTERM→SIGKILL grace it schedules.
 */
function fakeTimers(): {
  timers: Timers;
  fireNext: () => void;
  liveCount: () => number;
} {
  const queue: Array<{ fn: () => void; live: boolean }> = [];
  return {
    timers: {
      set(fn) {
        const entry = { fn, live: true };
        queue.push(entry);
        return entry;
      },
      clear(handle) {
        (handle as { live: boolean }).live = false;
      },
    },
    fireNext() {
      const entry = queue.find((e) => e.live);
      if (!entry) throw new Error('no live timer to fire');
      entry.live = false;
      entry.fn();
    },
    liveCount: () => queue.filter((e) => e.live).length,
  };
}

function scenarioFile(scenario: object): string {
  const path = join(mkdtempSync(join(tmpdir(), 'baya-spawn-')), 'scenario.json');
  writeFileSync(path, JSON.stringify(scenario));
  return path;
}

const plan = (): { argv: string[]; cwd: string; stdin: 'ignore' } => ({
  argv: [process.execPath, FAKE_PROVIDER],
  cwd: process.cwd(),
  stdin: 'ignore',
});

describe('runProcess environment', () => {
  // `SpawnPlan.env` carries knobs a CLI exposes only through the environment
  // (claude's `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`). It must layer over
  // the inherited env, never replace it: these CLIs find their credentials
  // through `PATH`, `HOME` and their own `*_HOME` vars.
  const echoEnv = (keys: string[]): string[] => [
    process.execPath,
    '-e',
    `process.stdout.write(JSON.stringify(${JSON.stringify(keys)}.map((k) => process.env[k] ?? null)))`,
  ];

  it('merges adapter env over the inherited env without dropping it', async () => {
    const result = await runProcess({
      plan: {
        argv: echoEnv(['BAYA_SPAWN_BASE', 'BAYA_SPAWN_ADAPTER', 'BAYA_SPAWN_OVERRIDE']),
        cwd: process.cwd(),
        stdin: 'ignore',
        env: { BAYA_SPAWN_ADAPTER: 'adapter', BAYA_SPAWN_OVERRIDE: 'wins' },
      },
      env: { ...process.env, BAYA_SPAWN_BASE: 'base', BAYA_SPAWN_OVERRIDE: 'loses' },
    });

    expect(JSON.parse(result.stdout)).toEqual(['base', 'adapter', 'wins']);
  });

  it('leaves the env untouched when the plan sets none', async () => {
    const result = await runProcess({
      plan: {
        argv: echoEnv(['BAYA_SPAWN_BASE']),
        cwd: process.cwd(),
        stdin: 'ignore',
      },
      env: { ...process.env, BAYA_SPAWN_BASE: 'base' },
    });

    expect(JSON.parse(result.stdout)).toEqual(['base']);
  });
});

describe('runProcess timeout escalation', () => {
  it('escalates a SIGTERM-trapping process to SIGKILL after the grace window', async () => {
    const ft = fakeTimers();
    const promise = runProcess({
      plan: plan(),
      env: {
        ...process.env,
        BAYA_FAKE_SCRIPT: scenarioFile({ hang_ms: 10_000, on_signal: 'ignore' }),
      },
      timeoutMs: 1_000,
      killGraceMs: 2_000,
      timers: ft.timers,
    });

    // Let the child spawn and install its (ignoring) signal handlers.
    await sleep(250);

    // Deadline fires: SIGTERM, and the grace timer is now scheduled.
    ft.fireNext();
    expect(ft.liveCount()).toBe(1);

    // The process traps SIGTERM, so it is still alive and the promise pending.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await sleep(150);
    expect(settled).toBe(false);

    // Grace elapses: SIGKILL to the group, which is uncatchable.
    ft.fireNext();
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('clears the deadline timer when the process exits on its own', async () => {
    const ft = fakeTimers();
    const result = await runProcess({
      plan: plan(),
      env: {
        ...process.env,
        BAYA_FAKE_SCRIPT: scenarioFile({
          final: {
            baya: '1',
            kind: 'task_result',
            task_id: 't',
            status: 'ok',
            summary: 'done',
          },
          exit_code: 0,
        }),
      },
      timeoutMs: 1_000,
      killGraceMs: 2_000,
      timers: ft.timers,
    });

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    // Deadline timer cleared, grace timer never scheduled.
    expect(ft.liveCount()).toBe(0);
  });
});
