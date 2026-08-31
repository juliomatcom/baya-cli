import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userConfigPath } from '../../src/config/index.js';
import {
  BUILTIN_CATALOG,
  type Catalog,
  type CatalogModel,
} from '../../src/providers/index.js';
import {
  FAKE_PROVIDER,
  makeWorkspace,
  runCli,
  type Workspace,
} from '../helpers/runCli.js';

describe('baya doctor', () => {
  it('reports the resolved path, version, and capability set', async () => {
    const result = await runCli(['doctor']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('codex');
    expect(result.stdout).toContain(FAKE_PROVIDER);
    expect(result.stdout).toContain('fake-provider 1.0.0');
    expect(result.stdout).toContain('prompt via stdin/argv');
    expect(result.stdout).toContain('schema schema-file');
    expect(result.stdout).toContain('max concurrency 2');
  });

  it('resolves a provider that is nowhere on $PATH', async () => {
    const workspace = makeWorkspace({});
    // The provider lives in ~/.local/bin; $PATH holds only the node bin dir.
    const localBin = join(workspace.home, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    const { copyFileSync, chmodSync } = await import('node:fs');
    copyFileSync(FAKE_PROVIDER, join(localBin, 'codex'));
    chmodSync(join(localBin, 'codex'), 0o755);
    writeFileSync(userConfigPath(workspace.env), JSON.stringify({ version: 1 }));

    const result = await runCli(['doctor'], { workspace });
    expect(result.stdout).toContain(join(localBin, 'codex'));
    expect(result.stdout).toContain('found via known-location');
  });

  it('exits 2 with install hints when no provider resolves', async () => {
    const workspace = makeWorkspace({});
    writeFileSync(
      userConfigPath(workspace.env),
      JSON.stringify({ version: 1, providers: { codex: { bin: '/nonexistent/codex' } } }),
    );
    const result = await runCli(['doctor'], { workspace });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('npm i -g @openai/codex');
  });

  it('reports the workspace as free when no baya is running', async () => {
    const result = await runCli(['doctor']);
    expect(result.stdout).toContain('no baya is running in this directory');
  });

  it('names an unreadable lock for a human to delete rather than removing it', async () => {
    const workspace = makeWorkspace({});
    writeFileSync(join(workspace.cwd, '.baya', 'baya.lock'), 'not json');
    const result = await runCli(['doctor'], { workspace });
    expect(result.stdout).toContain('delete it by hand');
  });
});

describe('baya config', () => {
  it('prints the user config path', async () => {
    const result = await runCli(['config', 'path']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/baya\/config\.json$/);
  });

  it('--show names the source layer of every value', async () => {
    const result = await runCli(['config', '--show']);
    expect(result.stdout).toContain('defaults.provider');
    expect(result.stdout).toContain('from user');
    expect(result.stdout).toContain('providers.codex.bin');
  });

  it('set writes the user layer, and --show then attributes it there', async () => {
    const workspace = makeWorkspace({});
    writeFileSync(userConfigPath(workspace.env), JSON.stringify({ version: 1 }));

    const set = await runCli(['config', 'set', 'defaults.provider', 'codex'], {
      workspace,
    });
    expect(set.code).toBe(0);

    const show = await runCli(['config', '--show'], { workspace });
    expect(show.stdout).toContain('from user');
  });

  it('rejects an unknown provider rather than storing it', async () => {
    const result = await runCli(['config', 'set', 'defaults.provider', 'rogue']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('rogue');
  });

  it('reports a malformed config clearly, naming the file', async () => {
    const workspace = makeWorkspace({});
    writeFileSync(userConfigPath(workspace.env), '{oops');
    const result = await runCli(['config', '--show'], { workspace });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not valid JSON');
    expect(result.stderr).toContain('config.json');
  });
});

describe('baya config refresh-models', () => {
  /** Stands in for `opencode models` — the one provider that enumerates live. */
  function fakeOpencode(dir: string, ids: string[]): string {
    const path = join(dir, 'opencode');
    const args = ids.map((id) => `'${id}'`).join(' ');
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${args}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  /** `opencode` reachable only through the config's `bin` override. */
  function setup(ids: string[] | null, userConfig: object): Workspace {
    const workspace = makeWorkspace({});
    const bin =
      ids === null ? '/nonexistent/opencode' : fakeOpencode(workspace.home, ids);
    const userPath = userConfigPath(workspace.env);
    mkdirSync(dirname(userPath), { recursive: true });
    writeFileSync(
      userPath,
      JSON.stringify({
        version: 1,
        providers: { opencode: { bin } },
        ...userConfig,
      }),
    );
    return workspace;
  }

  interface WrittenConfig {
    modelCatalog?: Catalog;
    defaults?: { provider: string | null; model: string | null };
  }

  function readUser(workspace: Workspace): WrittenConfig {
    const raw = readFileSync(userConfigPath(workspace.env), 'utf8');
    return JSON.parse(raw) as WrittenConfig;
  }

  /** What an older baya wrote: the whole built-in catalog, copied into the file. */
  function snapshot(): Catalog {
    return JSON.parse(JSON.stringify(BUILTIN_CATALOG)) as Catalog;
  }

  it('caches the live opencode list, not the built-in catalog', async () => {
    const workspace = setup(['anthropic/claude-sonnet-4', 'openai/gpt-5'], {});
    const result = await runCli(['config', 'refresh-models'], { workspace });

    expect(result.code).toBe(0);
    const written = readUser(workspace);
    expect(Object.keys(written.modelCatalog ?? {})).toEqual(['opencode']);
    expect((written.modelCatalog?.opencode ?? []).map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-5',
    ]);
    // Counts still describe everything a run can resolve, built-ins included.
    expect(result.stderr).toContain('codex 3');
    expect(result.stderr).toContain('opencode 2');
  });

  it('migrates out a stored snapshot but keeps a deliberate override', async () => {
    const stored = snapshot();
    const luna = (stored.codex ?? []).find((m) => m.id === 'gpt-5.6-luna');
    (luna as CatalogModel).aliases = ['luna', 'cheap'];
    const workspace = setup(['openai/gpt-5'], {
      defaults: { provider: 'codex', model: null },
      modelCatalog: stored,
    });

    expect((await runCli(['config', 'refresh-models'], { workspace })).code).toBe(0);

    const written = readUser(workspace);
    const keys = Object.keys(written.modelCatalog ?? {}).sort();
    expect(keys).toEqual(['codex', 'opencode']);
    expect(written.modelCatalog?.codex).toEqual([luna]);
    // The identical copies are gone; unrelated settings are untouched.
    expect(written.modelCatalog?.claude).toBeUndefined();
    expect(written.defaults).toEqual({ provider: 'codex', model: null });

    // …and the merged view a run sees is unchanged by the migration.
    const show = await runCli(['config', '--show'], { workspace });
    expect(show.stdout).toContain('codex:3');
    expect(show.stdout).toContain('claude:4');
    expect(show.stdout).toContain('opencode:1');
  });

  it('keeps the stored cache when opencode cannot be found', async () => {
    const cached = [{ id: 'openai/gpt-5', aliases: [], description: '' }];
    const workspace = setup(null, { modelCatalog: { opencode: cached } });

    const result = await runCli(['config', 'refresh-models'], { workspace });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('opencode not found');
    expect(readUser(workspace).modelCatalog?.opencode).toEqual(cached);
  });
});

describe('baya models', () => {
  /** A user config at layer 4 with a hand-written `modelCatalog`. */
  function withUserCatalog(catalog: Catalog): Workspace {
    const workspace = makeWorkspace({});
    const userPath = userConfigPath(workspace.env);
    mkdirSync(dirname(userPath), { recursive: true });
    writeFileSync(userPath, JSON.stringify({ version: 1, modelCatalog: catalog }));
    return workspace;
  }

  it('prints the built-in catalog grouped by provider, every row tagged built-in', async () => {
    const result = await runCli(['models']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('codex');
    expect(result.stdout).toContain('gpt-5.6-sol');
    expect(result.stdout).toContain('sol');
    expect(result.stdout).toContain('highest capability');
    expect(result.stdout).toContain('claude');
    expect(result.stdout).toContain('copilot');
    expect(result.stdout).toContain('built-in');
    expect(result.stdout).not.toMatch(/\buser\b(?! config)/);
  });

  it('narrows to one provider when given a filter', async () => {
    const result = await runCli(['models', 'codex']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('gpt-5.6-sol');
    expect(result.stdout).not.toContain('claude-sonnet-5');
    expect(result.stdout).not.toContain('kimi-k3');
  });

  it('tags an entry that overrides a built-in id as user, leaving the rest built-in', async () => {
    const workspace = withUserCatalog({
      codex: [
        {
          id: 'gpt-5.6-luna',
          aliases: ['luna', 'cheap'],
          description: 'my cheap default',
        },
      ],
    });

    const result = await runCli(['models', 'codex'], { workspace });

    expect(result.code).toBe(0);
    const luna = result.stdout.split('\n').find((line) => line.includes('gpt-5.6-luna'));
    expect(luna).toContain('cheap');
    expect(luna).toContain('my cheap default');
    expect(luna).toContain('user');
    const sol = result.stdout.split('\n').find((line) => line.includes('gpt-5.6-sol'));
    expect(sol).toContain('built-in');
  });

  it('surfaces a user-added opencode entry', async () => {
    const workspace = withUserCatalog({
      opencode: [{ id: 'anthropic/claude-sonnet-4', aliases: [], description: 'cached' }],
    });

    const result = await runCli(['models', 'opencode'], { workspace });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('anthropic/claude-sonnet-4');
    expect(result.stdout).toContain('user');
  });

  it('prints the effective catalog as clean JSON and suppresses the banner', async () => {
    const workspace = makeWorkspace({
      env: { FORCE_COLOR: '3', NO_COLOR: '' },
    });

    const result = await runCli(['models', '--json'], { workspace });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(BUILTIN_CATALOG);
    expect(result.stdout).not.toContain('\u001b[');
    expect(result.stderr).not.toContain('▗▄▄▖');
  });

  it('applies the provider filter to JSON output', async () => {
    const workspace = withUserCatalog({
      codex: [{ id: 'gpt-5.6-luna', aliases: ['cheap'], description: 'override' }],
    });

    const result = await runCli(['models', 'codex', '--json'], { workspace });
    const catalog = JSON.parse(result.stdout) as Catalog;

    expect(result.code).toBe(0);
    expect(Object.keys(catalog)).toEqual(['codex']);
    expect(catalog.codex).toContainEqual({
      id: 'gpt-5.6-luna',
      aliases: ['cheap'],
      description: 'override',
    });
    expect(catalog.claude).toBeUndefined();
  });

  it('rejects an unknown provider filter with exit 2', async () => {
    const result = await runCli(['models', 'rogue']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('rogue');
  });
});

describe('baya runs', () => {
  function seedRun(workspace: Workspace, id: string, stateJson: string): void {
    const dir = join(workspace.cwd, '.baya', 'runs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), stateJson);
  }

  const paused = (id: string): string =>
    JSON.stringify({
      version: 1,
      run_id: id,
      status: 'paused',
      started_at: '2026-08-30T12:00:00.000Z',
      source: { path: 'tasks.md', sha256: 'x' },
      totals: { succeeded: 1, failed: 0, skipped: 0, parked: 1, pending: 0, running: 0 },
    });

  it('lists resumable and damaged runs newest first, hides completed ones', async () => {
    const workspace = makeWorkspace({});
    seedRun(workspace, '20260830T090000Z-aaa-1', paused('20260830T090000Z-aaa-1'));
    seedRun(
      workspace,
      '20260830T100000Z-bbb-1',
      JSON.stringify({ version: 1, run_id: 'x', status: 'completed', totals: {} }),
    );
    seedRun(workspace, '20260830T110000Z-ccc-1', '{"version":1,"status":"pau');

    const result = await runCli(['runs'], { workspace });
    expect(result.code).toBe(0);
    const body = result.stdout;
    expect(body).toContain('20260830T110000Z-ccc-1');
    expect(body).toContain('damaged');
    expect(body).toContain('20260830T090000Z-aaa-1');
    expect(body).not.toContain('20260830T100000Z-bbb-1');
    expect(body.indexOf('ccc-1')).toBeLessThan(body.indexOf('aaa-1'));
  });

  it('says so when there is nothing to resume', async () => {
    const result = await runCli(['runs'], { workspace: makeWorkspace({}) });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no resumable runs');
  });

  it('emits the rows as clean JSON and suppresses the banner', async () => {
    const workspace = makeWorkspace({ env: { FORCE_COLOR: '3', NO_COLOR: '' } });
    seedRun(workspace, '20260830T090000Z-aaa-1', paused('20260830T090000Z-aaa-1'));

    const result = await runCli(['runs', '--json'], { workspace });
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: '20260830T090000Z-aaa-1',
      status: 'paused',
      source_path: 'tasks.md',
      resumable: true,
    });
    expect(result.stdout).not.toContain('[');
    expect(result.stderr).not.toContain('▗▄▄▖');
  });
});

describe('baya --help', () => {
  it('lists the providers with their resolution status', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PROVIDERS');
    expect(result.stdout).toContain('codex');
    expect(result.stdout).toContain('baya ./tasks.md');
  });

  it("shows each resolved provider's version, not a placeholder", async () => {
    const result = await runCli(['--help']);
    expect(result.stdout).toContain('fake-provider 1.0.0');
    expect(result.stdout).not.toContain('unknown');
  });

  it("resolves through the config's binary override, as every command must", async () => {
    const result = await runCli(['--help']);
    expect(result.stdout).toContain(FAKE_PROVIDER);
  });

  it('still prints when the config is unreadable — help must survive a broken setup', async () => {
    const workspace = makeWorkspace({});
    writeFileSync(userConfigPath(workspace.env), '{oops');
    const result = await runCli(['--help'], { workspace });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('USAGE');
  });

  it('is what a bare invocation shows', async () => {
    const result = await runCli([]);
    expect(result.stdout).toContain('USAGE');
  });
});

describe('baya --version', () => {
  const expected = String(
    (
      JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { version: string }
    ).version,
  );

  it('prints the package version to stdout and exits 0', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it('keeps the banner off stdout and stderr', async () => {
    const result = await runCli(['--version']);
    expect(result.stdout.trim()).toBe(expected);
    expect(result.stderr).toBe('');
  });

  it('accepts the -v and -V short forms', async () => {
    for (const flag of ['-v', '-V']) {
      const result = await runCli([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    }
  });
});

describe('argument errors', () => {
  it('exits 2 on an unknown flag rather than ignoring it', async () => {
    const result = await runCli(['./tasks.md', '--turbo']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown flag: --turbo');
  });

  it('treats a command word as a command, never as a task-list path', async () => {
    const result = await runCli(['resume']);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain('cannot read');
    expect(result.stderr).toContain('baya runs');
  });

  it('reports a missing task list', async () => {
    const result = await runCli(['./nope.md', '--yes']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('cannot read');
  });
});

describe('non-TTY provider selection', () => {
  const noDefault = { version: 1, providers: { codex: { bin: FAKE_PROVIDER } } };

  it('uses the only provider found, with a warning, and proceeds', async () => {
    const workspace = makeWorkspace({
      scenario: {
        __planner__: {
          final: {
            tasks: [
              {
                id: 'a',
                title: 'A',
                instruction: 'do a',
                provider: 'codex',
                model: null,
                depends_on: [],
                access: 'read-only',
                cwd: null,
              },
            ],
          },
        },
        a: {
          final: {
            baya: '1',
            kind: 'task_result',
            task_id: 'a',
            status: 'ok',
            summary: 's',
          },
        },
      },
    });
    writeFileSync(userConfigPath(workspace.env), JSON.stringify(noDefault));

    const result = await runCli(['./tasks.md', '--yes'], { workspace });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('only one found');
  });

  it('exits 2 with install hints when zero providers resolve', async () => {
    const workspace = makeWorkspace({});
    writeFileSync(
      userConfigPath(workspace.env),
      JSON.stringify({ version: 1, providers: { codex: { bin: '/nonexistent/codex' } } }),
    );
    const result = await runCli(['./tasks.md', '--yes'], { workspace });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no provider CLI found');
    expect(result.stderr).toContain('baya doctor');
  });

  it('never prompts under BAYA_NO_INPUT, even on a TTY', async () => {
    const workspace = makeWorkspace({});
    writeFileSync(
      userConfigPath(workspace.env),
      JSON.stringify({ version: 1, providers: { codex: { bin: '/nonexistent/codex' } } }),
    );
    const result = await runCli(['./tasks.md'], {
      workspace,
      stdinIsTty: true,
      stdoutIsTty: true,
    });
    expect(result.code).toBe(2);
  });
});
