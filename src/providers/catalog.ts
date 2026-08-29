import { PROVIDER_IDS, providerForModel, type ProviderId } from "../manifest/index.js";

/**
 * Model catalog + resolution (M3.6, extended 2026-08-29).
 *
 * Three of the four provider CLIs (`codex`, `claude`, `copilot`) have **no
 * "list models" command**, so their catalog is hardcoded here. `opencode`
 * enumerates live (`opencode models`) and its list is cached into the user
 * config at setup and refreshed on demand. The merged view is the union.
 *
 * Every run resolves a task's named model against this catalog *before*
 * spawning — a name like `luna` becomes `{ codex, gpt-5.6-luna }`, an unknown
 * name is caught at the plan gate, not as a cryptic provider 400 mid-run.
 *
 * This table is a starting point, not a contract: model ids churn. Editing it
 * is expected, and resolution degrades gracefully (best-match, then a prompt)
 * when it drifts.
 */

export interface CatalogModel {
  /** The exact id passed to the provider's `-m` / `--model` flag. */
  id: string;
  /** Short names that resolve to this id (case-insensitive). Keep them unique across providers. */
  aliases: string[];
  /** One line. Also scored during best-match, so "cheap fast model" can find `luna`. */
  description: string;
}

export type Catalog = Partial<Record<ProviderId, CatalogModel[]>>;

export const BUILTIN_CATALOG: Catalog = {
  codex: [
    { id: "gpt-5.6-sol", aliases: ["sol"], description: "highest capability" },
    {
      id: "gpt-5.6-terra",
      aliases: ["terra"],
      description: "balances quality and cost",
    },
    {
      id: "gpt-5.6-luna",
      aliases: ["luna"],
      description: "optimized for cost and high volume",
    },
  ],
  claude: [
    {
      id: "claude-fable-5",
      aliases: ["fable"],
      description: "next-generation intelligence for long-running agents; slower",
    },
    {
      id: "claude-opus-5",
      aliases: ["opus"],
      description: "complex agentic coding and enterprise work; moderate speed",
    },
    {
      id: "claude-sonnet-5",
      aliases: ["sonnet"],
      description: "best combination of speed and intelligence; fast",
    },
    {
      id: "claude-haiku-4-5-20251001",
      aliases: ["haiku"],
      description: "fastest model with near-frontier intelligence; cheapest",
    },
  ],
  // copilot has no `models` command and its docs list display names, not the
  // `--model` slugs. These are the models from the GitHub "supported models"
  // page with slugs in copilot's usual lowercase `vendor-name-version` form —
  // UNVERIFIED. A wrong slug fails at call time like any unvalidated id; the
  // model gate's best-match + prompt and `baya config refresh-models` (once a
  // list command exists) are the escape hatches. Fix a slug here when you hit one.
  copilot: [
    { id: "auto", aliases: [], description: "copilot picks a model per request" },
    { id: "claude-sonnet-4.6", aliases: [], description: "anthropic, balanced" },
    { id: "claude-sonnet-5", aliases: [], description: "anthropic, latest balanced" },
    { id: "claude-opus-4.6", aliases: [], description: "anthropic, complex reasoning" },
    { id: "claude-opus-4.7", aliases: [], description: "anthropic, advanced reasoning" },
    {
      id: "claude-opus-4.8",
      aliases: [],
      description: "anthropic, complex problem-solving",
    },
    {
      id: "claude-opus-4.8-fast",
      aliases: [],
      description: "anthropic, opus 4.8 speed-focused (preview)",
    },
    {
      id: "claude-opus-5",
      aliases: [],
      description: "anthropic, latest high-performance",
    },
    {
      id: "claude-fable-5",
      aliases: [],
      description: "anthropic, cost-efficient, safety focus",
    },
    { id: "gpt-5.3-codex", aliases: [], description: "openai, long-term support" },
    { id: "gpt-5.4", aliases: [], description: "openai, strong general capability" },
    { id: "gpt-5.5", aliases: [], description: "openai, enhanced performance" },
    { id: "gpt-5.6-luna", aliases: [], description: "openai, cost and high volume" },
    { id: "gpt-5.6-sol", aliases: [], description: "openai, highest capability" },
    { id: "gpt-5.6-terra", aliases: [], description: "openai, quality and cost" },
    { id: "kimi-k3", aliases: [], description: "moonshot ai, multilingual" },
  ],
};

/** Later entries win per id; aliases from the base survive unless an override redefines the id. */
export function mergeCatalog(base: Catalog, extra: Catalog | undefined): Catalog {
  if (!extra) return base;
  const merged: Catalog = {};
  for (const provider of PROVIDER_IDS) {
    const byId = new Map<string, CatalogModel>();
    for (const model of base[provider] ?? []) byId.set(model.id, model);
    for (const model of extra[provider] ?? []) byId.set(model.id, model);
    if (byId.size > 0) merged[provider] = [...byId.values()];
  }
  return merged;
}

/** `opencode models` prints `provider/model` lines; turn them into catalog entries. */
export function opencodeCatalog(ids: readonly string[]): CatalogModel[] {
  return ids.map((id) => ({ id, aliases: [], description: "" }));
}

// ---------------------------------------------------------------- resolution

export type ResolvedVia = "exact" | "alias" | "user-alias" | "best-match" | "literal";

export interface ResolvedModel {
  provider: ProviderId;
  model: string;
  via: ResolvedVia;
  /** 0..1 for `best-match` / `literal`; 1 for exact/alias. */
  score: number;
}

export interface ResolveOptions {
  catalog: Catalog;
  /** `config.modelAliases` — nickname -> another name/id, resolved recursively. */
  userAliases?: Record<string, string>;
  /** An explicit `task.provider`, which wins any tie. */
  taskProvider?: ProviderId | null;
  /** The run's default provider — the next tie-breaker after `taskProvider`. */
  runDefaultProvider: ProviderId;
}

export interface ResolveResult {
  /** A single confident answer — exact id, a known alias, or a user alias. */
  match: ResolvedModel | null;
  /** Ranked fallbacks for the plan-gate prompt when `match` is null. */
  candidates: ResolvedModel[];
}

const norm = (s: string): string => s.trim().toLowerCase();
const tokens = (s: string): string[] =>
  norm(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice over character bigrams — order-tolerant and catches typos (`sonet`~`sonnet`). */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const n of ba.values()) total += n;
  for (const [g, n] of bb) {
    total += n;
    shared += Math.min(n, ba.get(g) ?? 0);
  }
  return (2 * shared) / total;
}

/** Dice over token *sets* — for "gpt 5 codex" vs "gpt-5.1-codex". */
function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * The "simple complexity analysis": how well does `requested` name or describe
 * `model`? Exact id / alias => 1. Otherwise the max of: character similarity
 * against the id and each alias (typo-tolerant), a prefix/substring bonus,
 * token overlap, and a discounted match against the description.
 */
export function scoreModel(requested: string, model: CatalogModel): number {
  const r = norm(requested);
  const names = [model.id.toLowerCase(), ...model.aliases.map(norm)];
  if (names.includes(r)) return 1;

  let best = 0;
  for (const name of names) {
    if (name.startsWith(r) || r.startsWith(name)) best = Math.max(best, 0.85);
    if (name.includes(r) || r.includes(name)) best = Math.max(best, 0.78);
    best = Math.max(best, diceSimilarity(r, name));
    // Also compare against the id's last dash/dot segment ("sol" vs "gpt-5.6-sol").
    const tail = name.split(/[-.]/).pop() ?? name;
    best = Math.max(best, diceSimilarity(r, tail) * 0.95);
  }
  best = Math.max(
    best,
    tokenSimilarity(requested, `${model.id} ${model.aliases.join(" ")}`),
  );
  if (model.description) {
    best = Math.max(best, tokenSimilarity(requested, model.description) * 0.6);
  }
  return best;
}

function pickProvider(
  hits: ResolvedModel[],
  taskProvider: ProviderId | null | undefined,
  runDefault: ProviderId,
): ResolvedModel {
  return (
    (taskProvider && hits.find((h) => h.provider === taskProvider)) ||
    hits.find((h) => h.provider === runDefault) ||
    (hits[0] as ResolvedModel)
  );
}

export function resolveModel(requested: string, options: ResolveOptions): ResolveResult {
  const seen = new Set<string>();
  let name = requested;
  // Follow user aliases (with a cycle guard).
  while (options.userAliases && options.userAliases[name] && !seen.has(name)) {
    seen.add(name);
    name = options.userAliases[name] as string;
  }
  const viaUserAlias = name !== requested;

  const entries: Array<{ provider: ProviderId; model: CatalogModel }> = [];
  for (const provider of PROVIDER_IDS) {
    for (const model of options.catalog[provider] ?? [])
      entries.push({ provider, model });
  }

  const exact = entries
    .filter(({ model }) => model.id.toLowerCase() === norm(name))
    .map(({ provider, model }) => ({
      provider,
      model: model.id,
      via: (viaUserAlias ? "user-alias" : "exact") as ResolvedVia,
      score: 1,
    }));
  if (exact.length > 0) {
    return {
      match: pickProvider(exact, options.taskProvider, options.runDefaultProvider),
      candidates: [],
    };
  }

  const aliased = entries
    .filter(({ model }) => model.aliases.some((a) => norm(a) === norm(name)))
    .map(({ provider, model }) => ({
      provider,
      model: model.id,
      via: (viaUserAlias ? "user-alias" : "alias") as ResolvedVia,
      score: 1,
    }));
  if (aliased.length > 0) {
    return {
      match: pickProvider(aliased, options.taskProvider, options.runDefaultProvider),
      candidates: [],
    };
  }

  // No confident hit — rank everything for the prompt.
  const ranked = entries
    .map(({ provider, model }) => ({
      provider,
      model: model.id,
      via: "best-match" as ResolvedVia,
      score: scoreModel(name, model),
    }))
    .filter((c) => c.score > 0.2)
    .sort((a, b) => b.score - a.score);

  // A name that matches a provider's own id pattern (`gpt-*`, `claude-*`) is a
  // plausible literal id even if we have never heard of it.
  const patternProvider = providerForModel(name);
  if (patternProvider && !ranked.some((c) => c.model === name)) {
    ranked.push({
      provider: patternProvider,
      model: name,
      via: "literal",
      score: 0.3,
    });
  }

  return { match: null, candidates: ranked.slice(0, 4) };
}
