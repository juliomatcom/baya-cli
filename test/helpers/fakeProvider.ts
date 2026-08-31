import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_PROVIDER_PATH = fileURLToPath(
  new URL('../fixtures/fake-provider.mjs', import.meta.url),
);

export interface FakeProviderScenario {
  emit?: Array<{ delay_ms?: number; line: string; stream?: 'stdout' | 'stderr' }>;
  stderr?: string;
  final?: unknown;
  exit_code?: number;
  on_signal?: 'exit' | 'ignore';
  hang_ms?: number;
  spawn_child?: boolean;
  expect_stdin?: boolean | string;
  /** Exit 1 with nothing parseable when stdin carries this — a refused invocation. */
  reject_stdin?: string;
  expect_file?: string;
  /** Fail (retryably) for this many invocations of the task, then behave normally. */
  fail_attempts?: number;
  writes_file?: string;
  by_task?: Record<string, FakeProviderScenario>;
}

export interface FakeProviderResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function writeScenarioFile(scenario: FakeProviderScenario): string {
  const dir = mkdtempSync(join(tmpdir(), 'baya-fake-provider-'));
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  return scenarioPath;
}

/** Spawns the fixture and hands back the live child for tests that need to signal/inspect it. */
export function spawnFakeProvider(
  scenario: FakeProviderScenario,
): ChildProcessWithoutNullStreams {
  const scenarioPath = writeScenarioFile(scenario);
  return spawn(process.execPath, [FAKE_PROVIDER_PATH], {
    env: { ...process.env, BAYA_FAKE_SCRIPT: scenarioPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Spawns the fixture, feeds it optional stdin, and resolves once it exits. */
export function runFakeProvider(
  scenario: FakeProviderScenario,
  options: { stdin?: string } = {},
): Promise<FakeProviderResult> {
  return new Promise((resolve, reject) => {
    const child = spawnFakeProvider(scenario);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ stdout, stderr, code, signal });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
