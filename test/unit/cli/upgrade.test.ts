import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { upgradeCommand } from '../../../src/cli/upgrade.js';
import { claudeAdapter, codexAdapter } from '../../../src/providers/index.js';
import type {
  ProviderAdapter,
  ProviderStatus,
  Registry,
  ResolveOptions,
} from '../../../src/providers/index.js';
import type { ProviderId } from '../../../src/manifest/index.js';
import { createTheme } from '../../../src/ui/theme.js';
import { sealedEnv } from '../../helpers/env.js';

/**
 * A binary that answers `--version` from a state file (starting at `before`,
 * overwritten with `after` once "upgraded") and simulates the upgrade
 * subcommand itself failing when `failFile` exists. `probeVersion` never
 * forwards a custom env (providers/resolve.ts), so state travels through
 * paths baked into the script, not env vars.
 */
function makeUpgradeableBinary(
  dir: string,
  name: string,
  opts: { versionFile: string; failFile: string; before: string; after: string },
): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  if [ -f "${opts.versionFile}" ]; then cat "${opts.versionFile}"; else echo "${opts.before}"; fi`,
      '  exit 0',
      'fi',
      `if [ -f "${opts.failFile}" ]; then echo boom 1>&2; exit 1; fi`,
      `echo "${opts.after}" > "${opts.versionFile}"`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const stream = new PassThrough();
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
  });
  return { stream, text: () => buffer };
}

/** A hand-built `Registry` — never a mocked module (testing.md convention). */
function fakeRegistry(
  entries: Partial<Record<ProviderId, { adapter: ProviderAdapter; bin: string | null }>>,
): Registry {
  const ids = Object.keys(entries) as ProviderId[];
  const statusFor = (id: ProviderId): ProviderStatus => {
    const entry = entries[id];
    return {
      id,
      adapter: entry!.adapter,
      resolved:
        entry!.bin === null
          ? null
          : { bin: entry!.bin, version: 'unknown', source: 'known-location' },
    };
  };
  return {
    ids,
    get: (id) => entries[id as ProviderId]?.adapter,
    has: (id): id is ProviderId => ids.includes(id as ProviderId),
    resolve: (id: ProviderId, _options: ResolveOptions) =>
      Promise.resolve(entries[id] ? statusFor(id).resolved : null),
    resolveAll: (_options: ResolveOptions) => Promise.resolve(ids.map(statusFor)),
  };
}

function io(): {
  io: ReturnType<typeof buildIo>;
  stdout: () => string;
  stderr: () => string;
} {
  const out = capture();
  const err = capture();
  return {
    io: buildIo(out.stream, err.stream),
    stdout: out.text,
    stderr: err.text,
  };
}

function buildIo(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
} {
  return { stdout, stderr, stdinIsTty: false, stdoutIsTty: false };
}

const theme = createTheme('never');

describe('upgradeCommand', () => {
  it('resolves each provider, spawns its upgradeArgs, and reports the version before and after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'baya-upgrade-'));
    const bin = makeUpgradeableBinary(dir, 'codex', {
      versionFile: join(dir, 'codex.version'),
      failFile: join(dir, 'codex.fail'),
      before: '1.0.0',
      after: '2.0.0',
    });
    const registry = fakeRegistry({ codex: { adapter: codexAdapter, bin } });
    const { io: cliIo, stdout } = io();

    const code = await upgradeCommand({
      registry,
      cwd: dir,
      env: sealedEnv(),
      io: cliIo,
      theme,
    });

    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain('codex');
    expect(text).toContain('1.0.0 -> 2.0.0');
  });

  it('narrows to the filtered provider and never touches the others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'baya-upgrade-'));
    const claudeBin = makeUpgradeableBinary(dir, 'claude', {
      versionFile: join(dir, 'claude.version'),
      failFile: join(dir, 'claude.fail'),
      before: '1.1.0',
      after: '1.2.0',
    });
    const codexBin = makeUpgradeableBinary(dir, 'codex', {
      versionFile: join(dir, 'codex.version'),
      failFile: join(dir, 'codex.fail'),
      before: '1.0.0',
      after: '2.0.0',
    });
    const registry = fakeRegistry({
      codex: { adapter: codexAdapter, bin: codexBin },
      claude: { adapter: claudeAdapter, bin: claudeBin },
    });
    const { io: cliIo, stdout } = io();

    const code = await upgradeCommand({
      provider: 'claude',
      registry,
      cwd: dir,
      env: sealedEnv(),
      io: cliIo,
      theme,
    });

    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain('claude');
    expect(text).toContain('1.1.0 -> 1.2.0');
    expect(text).not.toContain('codex');
  });

  it('rejects an unknown provider filter without spawning anything', async () => {
    const registry = fakeRegistry({ codex: { adapter: codexAdapter, bin: '/bin/true' } });
    const { io: cliIo, stderr } = io();

    const code = await upgradeCommand({
      provider: 'nope',
      registry,
      cwd: process.cwd(),
      env: sealedEnv(),
      io: cliIo,
      theme,
    });

    expect(code).toBe(2);
    expect(stderr()).toContain('unknown provider: nope');
  });

  it('reports an unresolved provider as skipped, distinct from a failed upgrade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'baya-upgrade-'));
    const claudeBin = makeUpgradeableBinary(dir, 'claude', {
      versionFile: join(dir, 'claude.version'),
      failFile: join(dir, 'claude.fail'),
      before: '1.1.0',
      after: '1.2.0',
    });
    writeFileSync(join(dir, 'claude.fail'), ''); // claude's upgrade subcommand fails
    const registry = fakeRegistry({
      codex: { adapter: codexAdapter, bin: null }, // never resolves
      claude: { adapter: claudeAdapter, bin: claudeBin },
    });
    const { io: cliIo, stdout } = io();

    const code = await upgradeCommand({
      registry,
      cwd: dir,
      env: sealedEnv(),
      io: cliIo,
      theme,
    });

    // A failure outweighs a skip: `codex` never counts against the exit code,
    // `claude`'s failed upgrade does.
    expect(code).toBe(1);
    const text = stdout();
    expect(text).toContain('codex');
    expect(text).toContain(`not found — ${codexAdapter.installHint}`);
    expect(text).toContain('claude');
    expect(text).toContain('exited 1');
  });
});
