import { select } from "@inquirer/prompts";
import {
  providerForModel,
  type Manifest,
  type ProviderId,
  type Task,
} from "../manifest/index.js";
import { resolveModel, type Catalog, type ResolvedModel } from "../providers/index.js";
import type { Theme } from "./theme.js";

/**
 * The model gate (M3.6). Every task that *names* a model is resolved against
 * the catalog before the run starts:
 *
 *  - a confident hit (exact id, known alias, user alias) is applied silently;
 *  - anything else stops at the plan gate and asks the user to pick between the
 *    best match, that provider's default, or exiting.
 *
 * **Hard rule:** a task that named a model never runs on the default model
 * without the user saying so. Under `--yes` / non-TTY a best match is taken
 * only above `autoThreshold`; otherwise the run aborts (exit 2). It never
 * silently falls back.
 *
 * Pure planning (`planModelGate`) is separated from the one `select` call so
 * the logic is testable without opening a prompt (conventions.md #13).
 */

export interface ModelGateOptions {
  manifest: Manifest;
  catalog: Catalog;
  userAliases: Record<string, string>;
  defaultProvider: ProviderId;
  yes: boolean;
  stdinIsTty: boolean;
  theme: Theme;
  beforePrompt?: () => void;
  /** Auto-accept a best match at or above this score under --yes / non-TTY. */
  autoThreshold?: number;
}

export type ModelGateOutcome =
  | { decision: "ok"; manifest: Manifest; notes: string[] }
  | { decision: "aborted"; message: string };

export interface TaskModelAsk {
  taskId: string;
  requested: string;
  candidates: ResolvedModel[];
  /**
   * Where "run on the default model" would send this task: the task's own
   * provider, else the model name's pattern route, else the run default.
   */
  fallbackProvider: ProviderId;
}

export interface ModelGatePlan {
  /** taskId -> the provider/model to write in. `model: null` means "provider default". */
  auto: Map<string, { provider: ProviderId; model: string | null }>;
  asks: TaskModelAsk[];
  notes: string[];
}

const DEFAULT_AUTO_THRESHOLD = 0.85;

/**
 * Below this score a candidate is a coincidental string overlap, not a real
 * suggestion. It is still listed (it might be what the user meant), but the
 * cursor starts on "Run <default> on its default model" instead.
 */
const SUGGEST_THRESHOLD = 0.5;

export function planModelGate(
  manifest: Manifest,
  opts: {
    catalog: Catalog;
    userAliases: Record<string, string>;
    defaultProvider: ProviderId;
  },
): ModelGatePlan {
  const auto = new Map<string, { provider: ProviderId; model: string | null }>();
  const asks: TaskModelAsk[] = [];
  const notes: string[] = [];

  for (const task of manifest.tasks) {
    if (task.model === null) continue;
    const { match, candidates } = resolveModel(task.model, {
      catalog: opts.catalog,
      userAliases: opts.userAliases,
      taskProvider: task.provider,
      runDefaultProvider: opts.defaultProvider,
    });

    if (match) {
      auto.set(task.id, { provider: match.provider, model: match.model });
      if (match.model !== task.model || match.via === "user-alias") {
        notes.push(
          `${task.id}: "${task.model}" → ${match.provider} ${match.model} (${match.via})`,
        );
      }
      continue;
    }

    asks.push({
      taskId: task.id,
      requested: task.model,
      candidates,
      // "Run on the default model" means: the provider the task named, else the
      // one its model name pattern-routes to, else the *run's* default provider.
      // A fuzzy catalog match (which can be a 20-30% string hit against an
      // unrelated provider) must never decide this — that surprised users by
      // offering, say, copilot when the run default is codex.
      fallbackProvider:
        task.provider ?? providerForModel(task.model) ?? opts.defaultProvider,
    });
  }

  return { auto, asks, notes };
}

function applyRewrites(
  manifest: Manifest,
  rewrites: Map<string, { provider: ProviderId; model: string | null }>,
): Manifest {
  return {
    ...manifest,
    tasks: manifest.tasks.map((task) => {
      const rw = rewrites.get(task.id);
      return rw ? { ...task, provider: rw.provider, model: rw.model } : task;
    }),
  };
}

const pct = (score: number): string => `${Math.round(score * 100)}% match`;

const EXIT = "__exit__";

/**
 * The `select` payload for one unresolved task, built as pure data so the
 * choice list and starting cursor are testable without opening a prompt.
 */
export function buildModelAsk(
  ask: TaskModelAsk,
  theme: Theme,
): {
  message: string;
  choices: Array<{ name: string; value: string }>;
  default?: string;
} {
  const fallbackValue = JSON.stringify({ provider: ask.fallbackProvider, model: null });
  const choices = [
    ...ask.candidates.map((c) => ({
      name: `${c.provider} ${c.model}  ${theme.note(`(${pct(c.score)})`)}`,
      value: JSON.stringify({ provider: c.provider, model: c.model }),
    })),
    { name: `Run ${ask.fallbackProvider} on its default model`, value: fallbackValue },
    { name: "Exit — I'll fix the task list", value: EXIT },
  ];
  // Only let a candidate own the cursor when it is a real match; otherwise
  // start on the default-provider fallback so a coincidental string overlap is
  // never the pre-selected answer.
  const strongTop = (ask.candidates[0]?.score ?? 0) >= SUGGEST_THRESHOLD;
  return {
    message: `${ask.taskId} names model "${ask.requested}" — no exact match. Use:`,
    choices,
    ...(strongTop ? {} : { default: fallbackValue }),
  };
}

function unresolvedMessage(asks: TaskModelAsk[]): string {
  const lines = asks.map(
    (ask) =>
      `  ${ask.taskId} wants "${ask.requested}"` +
      (ask.candidates[0]
        ? ` — closest is ${ask.candidates[0].provider} ${ask.candidates[0].model} (${pct(ask.candidates[0].score)})`
        : " — no close match"),
  );
  return [
    "the task list names models that could not be resolved:",
    ...lines,
    "",
    "Fix the name in the list, add a `modelAliases` entry (`baya config set modelAliases.<name> <id>`),",
    "run `baya config refresh-models`, or pass --default-model to override. A named model is never",
    "silently replaced with the default.",
  ].join("\n");
}

export async function runModelGate(options: ModelGateOptions): Promise<ModelGateOutcome> {
  const threshold = options.autoThreshold ?? DEFAULT_AUTO_THRESHOLD;
  const plan = planModelGate(options.manifest, {
    catalog: options.catalog,
    userAliases: options.userAliases,
    defaultProvider: options.defaultProvider,
  });

  const rewrites = new Map(plan.auto);
  const notes = [...plan.notes];

  if (plan.asks.length === 0) {
    return { decision: "ok", manifest: applyRewrites(options.manifest, rewrites), notes };
  }

  // Non-interactive: accept a best match only if we are confident; never default.
  if (options.yes || !options.stdinIsTty) {
    const stillUnresolved: TaskModelAsk[] = [];
    for (const ask of plan.asks) {
      const top = ask.candidates[0];
      if (top && top.score >= threshold) {
        rewrites.set(ask.taskId, { provider: top.provider, model: top.model });
        notes.push(
          `${ask.taskId}: "${ask.requested}" → ${top.provider} ${top.model} (best match, ${pct(top.score)})`,
        );
      } else {
        stillUnresolved.push(ask);
      }
    }
    if (stillUnresolved.length > 0) {
      return { decision: "aborted", message: unresolvedMessage(stillUnresolved) };
    }
    return { decision: "ok", manifest: applyRewrites(options.manifest, rewrites), notes };
  }

  // Interactive: one question per unresolved task.
  options.beforePrompt?.();
  for (const ask of plan.asks) {
    const answer = await select(buildModelAsk(ask, options.theme));
    if (answer === EXIT) {
      return {
        decision: "aborted",
        message: `stopped at the model gate — ${ask.taskId} names "${ask.requested}".`,
      };
    }
    const picked = JSON.parse(answer) as { provider: ProviderId; model: string | null };
    rewrites.set(ask.taskId, picked);
    notes.push(
      `${ask.taskId}: "${ask.requested}" → ${picked.provider} ${picked.model ?? "(default)"}`,
    );
  }

  return { decision: "ok", manifest: applyRewrites(options.manifest, rewrites), notes };
}

export type { Task };
