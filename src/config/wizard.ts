import { select, input } from "@inquirer/prompts";
import type { ProviderId } from "../manifest/index.js";
import type { ProviderStatus } from "../providers/index.js";
import { writeConfigFile } from "./load.js";

/**
 * First-run setup (config.md §First-run wizard). Two questions, once, then the
 * original command continues.
 *
 * The logic here is deliberately split: `buildProviderChoices`,
 * `buildModelChoices`, `wizardDecision`, and `nonInteractiveDefault` are pure
 * and carry all the tests, while `runWizard` is a thin shell around the prompt
 * calls. **No test may open a prompt** (conventions.md #13) — a suite that
 * blocks on stdin is unrecoverable in CI.
 */
export interface WizardChoice {
  value: string;
  name: string;
  description?: string;
  /** inquirer's convention: `false` for selectable, a reason string to disable. */
  disabled: false | string;
}

export const PROVIDER_DEFAULT_MODEL = "__provider_default__";
export const MODEL_MANUAL_ENTRY = "__manual__";

/**
 * Curated per-provider model lists, filled in as each adapter lands (M3.5b).
 * Deliberately sparse: model ids churn faster than this tool ships, and an
 * out-of-date suggestion is worse than none — "provider default" always works.
 * `opencode` stays empty because its list is enumerated live.
 */
export const CURATED_MODELS: Record<string, string[]> = {
  codex: [],
  claude: ["opus", "sonnet", "haiku"],
  copilot: ["auto"],
  opencode: [],
};

/**
 * Resolved providers are selectable; undetected ones are listed **disabled
 * with an install hint**, so the list doubles as discovery rather than hiding
 * the thing the user was about to go looking for.
 */
export function buildProviderChoices(statuses: ProviderStatus[]): WizardChoice[] {
  const detected = statuses.filter((status) => status.resolved !== null);
  const missing = statuses.filter((status) => status.resolved === null);

  const toChoice = (status: ProviderStatus): WizardChoice =>
    status.resolved
      ? {
          value: status.id,
          name: status.id,
          description: `${status.resolved.version} · ${status.resolved.bin}`,
          disabled: false,
        }
      : {
          value: status.id,
          name: status.id,
          description: status.adapter.installHint,
          disabled: `not installed — ${status.adapter.installHint}`,
        };

  return [...detected, ...missing].map(toChoice);
}

/**
 * `enumerated` comes from the provider itself where it can tell us (`opencode
 * models`, ~190 entries — which is why the caller uses a searchable prompt).
 *
 * The wizard **never validates a typed model**: no CLI enumerates valid ids
 * cheaply, and adding a validation call would cost a real request per setup.
 * The string is stored and the first run surfaces any error.
 */
export function buildModelChoices(
  provider: ProviderId,
  enumerated: string[] = [],
): WizardChoice[] {
  const suggestions =
    enumerated.length > 0 ? enumerated : (CURATED_MODELS[provider] ?? []);
  return [
    {
      value: PROVIDER_DEFAULT_MODEL,
      name: "Provider default (recommended)",
      description: "Let the CLI pick. Model ids churn; this never goes stale.",
      disabled: false,
    },
    ...suggestions.map((model) => ({
      value: model,
      name: model,
      disabled: false as const,
    })),
    {
      value: MODEL_MANUAL_ENTRY,
      name: "Enter a model name manually…",
      disabled: false,
    },
  ];
}

export interface WizardContext {
  command: string;
  userConfigExists: boolean;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  providerFlagGiven: boolean;
  yes: boolean;
  env: NodeJS.ProcessEnv;
}

export type WizardDecision = { run: true } | { run: false; reason: string };

/** Commands that cannot proceed without knowing which provider to use. */
const PROVIDER_COMMANDS = new Set(["run", "plan"]);

export function wizardDecision(ctx: WizardContext): WizardDecision {
  if (!PROVIDER_COMMANDS.has(ctx.command)) {
    return { run: false, reason: `command "${ctx.command}" does not need a provider` };
  }
  if (ctx.userConfigExists) return { run: false, reason: "user config already exists" };
  if (ctx.providerFlagGiven) return { run: false, reason: "--default-provider given" };
  if (ctx.yes) return { run: false, reason: "--yes given" };
  if (ctx.env["BAYA_NO_INPUT"] === "1") return { run: false, reason: "BAYA_NO_INPUT=1" };
  if (ctx.env["CI"] === "true") return { run: false, reason: "CI=true" };
  if (!ctx.stdinIsTty || !ctx.stdoutIsTty) return { run: false, reason: "not a TTY" };
  return { run: true };
}

export type NonInteractiveOutcome =
  | { kind: "use"; provider: ProviderId; warning: string }
  | { kind: "error"; message: string };

/**
 * What to do when the wizard is skipped and no provider is configured. A
 * wizard that blocks a pipe is the worst failure mode in the system, so every
 * branch here resolves without touching stdin.
 */
export function nonInteractiveDefault(statuses: ProviderStatus[]): NonInteractiveOutcome {
  const detected = statuses.filter((status) => status.resolved !== null);

  if (detected.length === 0) {
    const hints = statuses
      .map((status) => `  ${status.id.padEnd(10)} ${status.adapter.installHint}`)
      .join("\n");
    return {
      kind: "error",
      message: `no provider CLI found. Install one, then run \`baya doctor\`:\n${hints}`,
    };
  }
  const only = detected[0] as ProviderStatus;
  if (detected.length === 1) {
    return {
      kind: "use",
      provider: only.id,
      warning: `no configured default provider; using the only one found: ${only.id}`,
    };
  }
  return {
    kind: "error",
    message: `several providers found (${detected.map((s) => s.id).join(", ")}). Pass --default-provider <id> or run \`baya config\`.`,
  };
}

export interface WizardResult {
  provider: ProviderId;
  model: string | null;
  configPath: string;
}

export interface RunWizardOptions {
  statuses: ProviderStatus[];
  configPath: string;
  /** Live model list where the provider can supply one (`opencode models`). */
  enumerateModels?: (provider: ProviderId) => Promise<string[]>;
}

/**
 * The only I/O in this module. Writes layer 4 (user config), so the answer is
 * made once per machine and every project inherits it.
 */
export async function runWizard(options: RunWizardOptions): Promise<WizardResult> {
  const providerChoices = buildProviderChoices(options.statuses);
  const provider = (await select({
    message: "Default provider for Baya",
    choices: providerChoices,
  })) as ProviderId;

  const enumerated = (await options.enumerateModels?.(provider)) ?? [];
  const picked = await select({
    message: `Default model for ${provider}`,
    choices: buildModelChoices(provider, enumerated),
  });

  let model: string | null = null;
  if (picked === MODEL_MANUAL_ENTRY) {
    const typed = (await input({ message: "Model name" })).trim();
    model = typed === "" ? null : typed;
  } else if (picked !== PROVIDER_DEFAULT_MODEL) {
    model = picked;
  }

  writeConfigFile(options.configPath, {
    defaults: { provider, model },
    planner: { provider, model },
  });

  return { provider, model, configPath: options.configPath };
}
