import type { ProviderId } from '../manifest/index.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { opencodeAdapter } from './opencode.js';
import { probeVersion, resolveBinary } from './resolve.js';
import type { ProviderAdapter, ResolvedProvider } from './types.js';

/**
 * The adapter registry. `--help`, `doctor`, and the first-run wizard all read
 * their provider list from here, so registering an adapter is the only edit
 * needed to make a provider visible everywhere (providers.md §Drift policy #4).
 *
 * Only *implemented* adapters are registered. Listing a provider we cannot
 * actually drive would make `--help` and `doctor` lie.
 */
export interface ProviderStatus {
  id: ProviderId;
  adapter: ProviderAdapter;
  resolved: ResolvedProvider | null;
}

export interface ResolveOptions {
  /** user config `providers.<id>.bin` overrides, keyed by provider id. */
  binOverrides?: Partial<Record<ProviderId, string>>;
  /** Required: resolution reads the host through this and nowhere else. */
  env: NodeJS.ProcessEnv;
  /** Skip the `--version` probe — `resolve()` is on the run path, `doctor` is not. */
  probe?: boolean;
}

export interface Registry {
  readonly ids: ProviderId[];
  get(id: string): ProviderAdapter | undefined;
  has(id: string): id is ProviderId;
  resolve(id: ProviderId, options: ResolveOptions): Promise<ResolvedProvider | null>;
  resolveAll(options: ResolveOptions): Promise<ProviderStatus[]>;
}

export function createRegistry(adapters: readonly ProviderAdapter[]): Registry {
  const byId = new Map<string, ProviderAdapter>(
    adapters.map((adapter) => [adapter.id, adapter]),
  );
  const cache = new Map<string, ResolvedProvider | null>();

  async function resolve(
    id: ProviderId,
    options: ResolveOptions,
  ): Promise<ResolvedProvider | null> {
    const cacheKey = `${id}:${options.probe === false ? 'nover' : 'ver'}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const adapter = byId.get(id);
    if (!adapter) {
      cache.set(cacheKey, null);
      return null;
    }

    const found = resolveBinary(id, {
      override: options.binOverrides?.[id],
      env: options.env,
      ...(adapter.knownLocations ? { extraLocations: adapter.knownLocations } : {}),
    });
    if (!found) {
      cache.set(cacheKey, null);
      return null;
    }

    const version = options.probe === false ? 'unknown' : await probeVersion(found.bin);
    const resolved: ResolvedProvider = { ...found, version };
    cache.set(cacheKey, resolved);
    return resolved;
  }

  return {
    ids: adapters.map((adapter) => adapter.id),
    get: (id) => byId.get(id),
    has: (id): id is ProviderId => byId.has(id),
    resolve,
    resolveAll: async (options) =>
      Promise.all(
        adapters.map(async (adapter) => ({
          id: adapter.id,
          adapter,
          resolved: await resolve(adapter.id, options),
        })),
      ),
  };
}

/**
 * The v1 adapter set. Order is display order for `--help`, `doctor`, and the
 * wizard: `codex` and `claude` first (verified surfaces, run on the reference
 * machine), then `opencode` and `copilot` (adapters landed M3, success paths
 * pending a local environment fix / quota reset).
 */
export const V1_ADAPTERS: readonly ProviderAdapter[] = [
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  copilotAdapter,
];

/**
 * A fresh registry per invocation. Resolution is cached *within* a registry —
 * one run must not re-stat the filesystem per task — but never across
 * invocations, where a changed config or a newly installed binary would be
 * masked by a stale entry.
 */
export function createDefaultRegistry(): Registry {
  return createRegistry(V1_ADAPTERS);
}
