import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../../src/cli/index.js';
import { runPaths, type RunPaths } from '../../src/executor/index.js';
import type { FakeProviderScenario } from './fakeProvider.js';

/**
 * Drives the real CLI end to end against `fake-provider.mjs`, which stands in
 * for `codex` via the user config's binary override — the same override a
 * user would set. Zero network, zero cost, deterministic.
 */
export const FAKE_PROVIDER = fileURLToPath(
  new URL('../fixtures/fake-provider.mjs', import.meta.url),
);

export interface Workspace {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  scenarioPath: string;
  tasksPath: string;
}

export interface CliOptions {
  scenario?: Record<string, FakeProviderScenario> | FakeProviderScenario;
  /** Contents of the task-list file written into the workspace. */
  taskList?: string;
  /** Basename for the task-list file (default `tasks.md`). */
  taskFile?: string;
  /** Extra user-config values merged over the defaults. */
  config?: Record<string, unknown>;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
  env?: NodeJS.ProcessEnv;
  workspace?: Workspace;
}

export function makeWorkspace(options: CliOptions = {}): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'baya-run-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(join(cwd, '.baya'), { recursive: true });
  mkdirSync(home, { recursive: true });

  const tasksPath = join(cwd, options.taskFile ?? 'tasks.md');
  writeFileSync(tasksPath, options.taskList ?? '# Design the API\n\nDesign it.\n');

  const scenarioPath = join(root, 'scenario.json');
  const scenario =
    options.scenario && 'by_task' in options.scenario
      ? options.scenario
      : options.scenario && !isScenario(options.scenario)
        ? { by_task: options.scenario }
        : (options.scenario ?? {});
  writeFileSync(scenarioPath, JSON.stringify(scenario));

  // The user config, since that is the only config layer there is. The fake
  // provider is reached through its `providers.codex.bin` override — the same
  // override a real user would write.
  mkdirSync(join(home, '.config', 'baya'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'baya', 'config.json'),
    JSON.stringify({
      version: 1,
      defaults: { provider: 'codex', model: null },
      planner: { provider: 'codex', model: null },
      providers: { codex: { bin: FAKE_PROVIDER } },
      ...options.config,
    }),
  );

  return {
    cwd,
    home,
    tasksPath,
    scenarioPath,
    env: {
      // The fake provider's shebang is `#!/usr/bin/env node`, so node itself
      // must stay reachable; the provider binary comes from the config
      // override, never from this PATH.
      PATH: dirname(process.execPath),
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      BAYA_FAKE_SCRIPT: scenarioPath,
      BAYA_NO_INPUT: '1',
      NO_COLOR: '1',
      ...options.env,
    },
  };
}

function isScenario(value: object): value is FakeProviderScenario {
  return 'final' in value || 'emit' in value || 'exit_code' in value;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  workspace: Workspace;
  /** Paths for the single run this invocation created, if any. */
  paths: RunPaths | null;
  runId: string | null;
  readJson: (path: string) => unknown;
  readText: (path: string) => string;
}

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const stream = new PassThrough();
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
  });
  return { stream, text: () => buffer };
}

export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const workspace = options.workspace ?? makeWorkspace(options);
  // runIds carry second precision, so two runs in the same second sort by
  // their random suffix. Diffing the directory identifies this run exactly.
  const before = new Set(runIds(workspace.cwd));
  const stdout = capture();
  const stderr = capture();

  const code = await main({
    argv,
    cwd: workspace.cwd,
    env: workspace.env,
    io: {
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdinIsTty: options.stdinIsTty ?? false,
      stdoutIsTty: options.stdoutIsTty ?? false,
    },
  });

  const runId = runIds(workspace.cwd).find((id) => !before.has(id)) ?? null;
  return {
    code,
    stdout: stdout.text(),
    stderr: stderr.text(),
    workspace,
    runId,
    paths: runId === null ? null : runPaths(workspace.cwd, runId),
    readJson: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
    readText: (path) => readFileSync(path, 'utf8'),
  };
}

export function runIds(cwd: string): string[] {
  try {
    // runIds are lexically sortable by design, so this needs no index.
    return readdirSync(join(cwd, '.baya', 'runs')).sort();
  } catch {
    return [];
  }
}

/** Every JSONL line the run recorded — the file always has the full stream. */
export function readLog(paths: RunPaths): Array<Record<string, unknown>> {
  return readFileSync(paths.log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function taskResult(
  status: 'ok' | 'failed' | 'needs_input',
  fields: object,
): object {
  return { baya: '1', kind: 'task_result', status, ...fields };
}
