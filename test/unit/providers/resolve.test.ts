import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRegistry,
  knownLocations,
  resolveBinary,
} from '../../../src/providers/index.js';
import { homeLocations, sealedEnv } from '../../helpers/env.js';
import { codexAdapter } from '../../../src/providers/codex.js';

function makeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\necho fake 1.0.0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('knownLocations', () => {
  /**
   * Three of the defaults are absolute host paths, the active nvm bin among
   * them — which is also where `npm i -g` puts provider CLIs. Anything that
   * must resolve *nothing* therefore resolved whatever the developer had
   * installed: four integration tests failed on the author's machine and none
   * in CI, which reads as a broken branch every time.
   */
  it('lets the environment replace the host paths it would otherwise search', () => {
    expect(knownLocations({ BAYA_KNOWN_LOCATIONS: '/a:/b' })).toEqual(['/a', '/b']);
  });

  it('treats an empty value as "search nowhere", not as "use the defaults"', () => {
    expect(knownLocations({ BAYA_KNOWN_LOCATIONS: '' })).toEqual([]);
  });

  it('still searches the defaults when the variable is unset', () => {
    const locations = knownLocations({ HOME: '/home/x' });
    expect(locations).toContain('/home/x/.local/bin');
    expect(locations.length).toBeGreaterThan(1);
  });

  it('resolves nothing when the search list is empty and $PATH is empty', () => {
    expect(resolveBinary('codex', { env: sealedEnv({ PATH: '' }) })).toBeNull();
  });
});

describe('the sealed test environment', () => {
  /**
   * The invariant behind `sealedEnv`, asserted rather than assumed: with
   * provider binaries planted in every directory resolution knows about,
   * a sealed env still finds nothing.
   *
   * Without it the suite's result depends on what the developer has
   * installed — four tests failed on a laptop with `copilot` in the nvm bin
   * and passed in CI, which reads as a broken branch every time.
   */
  it('finds nothing even with providers planted in every known location', () => {
    const host = mkdtempSync(join(tmpdir(), 'baya-hostile-'));
    makeExecutable(join(host, 'bin'), 'codex');
    for (const dir of ['.local/bin', '.opencode/bin', '.claude/local']) {
      makeExecutable(join(host, ...dir.split('/')), 'codex');
    }

    // A hand-built env that *looks* sealed: it is not, because the
    // known-location defaults still reach the host.
    expect(knownLocations({ PATH: '/nonexistent', HOME: host })).not.toEqual([]);
    // The real thing.
    expect(resolveBinary('codex', { env: sealedEnv() })).toBeNull();
    expect(resolveBinary('codex', { env: sealedEnv({ HOME: host }) })).toBeNull();
  });
});

describe('resolveBinary', () => {
  it('takes a config override ahead of everything else', () => {
    const root = mkdtempSync(join(tmpdir(), 'baya-resolve-'));
    const override = makeExecutable(join(root, 'custom'), 'codex');
    makeExecutable(join(root, 'path'), 'codex');

    expect(
      resolveBinary('codex', { override, env: sealedEnv({ PATH: join(root, 'path') }) }),
    ).toEqual({ bin: override, source: 'config' });
  });

  it('refuses a configured path that is not executable rather than falling through', () => {
    const root = mkdtempSync(join(tmpdir(), 'baya-resolve-'));
    const onPath = makeExecutable(join(root, 'path'), 'codex');
    expect(
      resolveBinary('codex', {
        override: join(root, 'nope', 'codex'),
        env: sealedEnv({ PATH: join(root, 'path') }),
      }),
    ).toBeNull();
    expect(
      resolveBinary('codex', { env: sealedEnv({ PATH: join(root, 'path') }) })?.bin,
    ).toBe(onPath);
  });

  it('finds a binary on $PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'baya-resolve-'));
    const bin = makeExecutable(join(root, 'path'), 'codex');
    expect(
      resolveBinary('codex', { env: sealedEnv({ PATH: join(root, 'path') }) }),
    ).toEqual({
      bin,
      source: 'path',
    });
  });

  it('finds a binary in ~/.local/bin when $PATH does not have it — never assume $PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'baya-home-'));
    const bin = makeExecutable(join(home, '.local', 'bin'), 'codex');
    expect(
      resolveBinary('codex', {
        env: sealedEnv({ HOME: home, BAYA_KNOWN_LOCATIONS: homeLocations(home) }),
      }),
    ).toEqual({
      bin,
      source: 'known-location',
    });
  });

  it('returns null when nothing resolves', () => {
    const home = mkdtempSync(join(tmpdir(), 'baya-home-'));
    expect(
      resolveBinary('codex', {
        env: sealedEnv({ HOME: home, BAYA_KNOWN_LOCATIONS: homeLocations(home) }),
      }),
    ).toBeNull();
  });

  it("ignores a directory that shares the binary's name", () => {
    const root = mkdtempSync(join(tmpdir(), 'baya-resolve-'));
    mkdirSync(join(root, 'path', 'codex'), { recursive: true });
    expect(
      resolveBinary('codex', {
        env: sealedEnv({
          PATH: join(root, 'path'),
          HOME: root,
          BAYA_KNOWN_LOCATIONS: homeLocations(root),
        }),
      }),
    ).toBeNull();
  });
});

describe('registry', () => {
  it('reports every registered adapter with its resolution status', async () => {
    const home = mkdtempSync(join(tmpdir(), 'baya-home-'));
    const bin = makeExecutable(join(home, '.local', 'bin'), 'codex');
    const registry = createRegistry([codexAdapter]);

    const statuses = await registry.resolveAll({
      env: sealedEnv({ HOME: home, BAYA_KNOWN_LOCATIONS: homeLocations(home) }),
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.id).toBe('codex');
    expect(statuses[0]?.resolved?.bin).toBe(bin);
    expect(statuses[0]?.resolved?.version).toBe('fake 1.0.0');
  });

  it('reports a missing adapter as unresolved rather than throwing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'baya-home-'));
    const registry = createRegistry([codexAdapter]);
    const statuses = await registry.resolveAll({
      env: sealedEnv({ HOME: home, BAYA_KNOWN_LOCATIONS: homeLocations(home) }),
    });
    expect(statuses[0]?.resolved).toBeNull();
  });

  it('has() narrows an unknown string safely', () => {
    const registry = createRegistry([codexAdapter]);
    expect(registry.has('codex')).toBe(true);
    expect(registry.has('rogue')).toBe(false);
  });
});
