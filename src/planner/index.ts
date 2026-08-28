import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  MANIFEST_VERSION,
  validateManifest,
  type Manifest,
  type ProviderId,
  type Source,
  type ValidationError,
} from "../manifest/index.js";
import type { Logger } from "../log/index.js";
import { stripAnsi } from "../log/index.js";
import { linearFallback } from "./fallback.js";
import { plannerPrompt, repairPrompt } from "./prompt.js";

export { linearFallback, slugify, splitSections } from "./fallback.js";
export { plannerPrompt, repairPrompt } from "./prompt.js";
export { runPlannerProvider, type RunPlannerProviderOptions } from "./provider.js";

/** Reads the Markdown and its identity in one step; `sha256` guards resume. */
export function readSource(path: string): { source: Source; markdown: string } {
  const markdown = readFileSync(path, "utf8");
  const sha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  return { source: { path, sha256 }, markdown };
}

/** Injectable so every planner test runs offline against a scripted response. */
export type PlannerRunner = (prompt: string, attempt: number) => Promise<string>;

export interface PlanOptions {
  markdown: string;
  source: Source;
  runner: PlannerRunner;
  logger: Logger;
  providers: readonly ProviderId[];
  defaultProvider: ProviderId;
  schemaPath: string;
  maxTasks?: number;
  /** Attempts after the first. architecture.md: repair ×2, then fall back. */
  maxRepairs?: number;
}

export interface PlanResult {
  manifest: Manifest;
  origin: "planner" | "fallback";
  attempts: number;
  warnings: string[];
}

const DEFAULT_MAX_REPAIRS = 2;

/**
 * Rung order for a plan payload. Unlike a `task_result`, a manifest has no
 * provider that enforces it natively for every CLI, so a fenced block is a
 * realistic shape — but this still parses JSON, never prose (conventions.md #3).
 */
export function parsePlanDraft(raw: string): unknown | null {
  const text = stripAnsi(raw).trim();
  if (text === "") return null;

  try {
    return JSON.parse(text);
  } catch {
    // fall through to the fenced-extract rung
  }

  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const last = fences[fences.length - 1]?.[1];
  if (last === undefined) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

function draftToManifest(draft: unknown, source: Source): unknown {
  const tasks =
    draft !== null && typeof draft === "object"
      ? (draft as Record<string, unknown>)["tasks"]
      : undefined;
  return { version: MANIFEST_VERSION, source, tasks: tasks ?? [] };
}

/**
 * Markdown -> manifest, with a bounded repair loop and a fallback that cannot
 * fail. **Never abort on a bad plan**: the planner is the least reliable link
 * in the system, and a user with a valid task list should always get a run.
 */
export async function plan(options: PlanOptions): Promise<PlanResult> {
  const { logger, source } = options;
  const maxTasks = options.maxTasks ?? 50;
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const warnings: string[] = [];

  const base = plannerPrompt({
    markdown: options.markdown,
    sourcePath: source.path,
    maxTasks,
    providers: options.providers,
    defaultProvider: options.defaultProvider,
    schemaPath: options.schemaPath,
  });

  let prompt = base;
  let lastErrors: ValidationError[] = [];

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    logger.info("plan.requested", { attempt, max_repairs: maxRepairs });
    const startedAt = Date.now();
    const raw = await options.runner(prompt, attempt);
    logger.info("plan.received", {
      attempt,
      bytes: Buffer.byteLength(raw, "utf8"),
      duration_ms: Date.now() - startedAt,
    });

    const draft = parsePlanDraft(raw);
    const result = validateManifest(draftToManifest(draft, source), {
      allowlist: options.providers,
      maxTasks,
    });

    if (result.ok && result.manifest.tasks.length > 0) {
      logger.info("plan.validated", {
        tasks: result.manifest.tasks.length,
        edges: result.manifest.tasks.reduce((sum, t) => sum + t.depends_on.length, 0),
        attempts: attempt + 1,
      });
      return {
        manifest: result.manifest,
        origin: "planner",
        attempts: attempt + 1,
        warnings,
      };
    }

    lastErrors = result.ok
      ? [{ code: "schema", message: "the plan contained no tasks" }]
      : result.errors;
    logger.warn("plan.validation.failed", {
      attempt,
      errors: lastErrors.map((error) => error.message),
    });

    if (attempt < maxRepairs) {
      logger.info("plan.repair.attempted", { attempt: attempt + 1 });
      prompt = repairPrompt(raw, lastErrors, base);
    }
  }

  const warning = `planner failed after ${maxRepairs + 1} attempts (${lastErrors[0]?.message ?? "no valid plan"}); falling back to a linear chain in document order`;
  warnings.push(warning);
  logger.warn("plan.fallback.linear", {
    reason: lastErrors[0]?.message ?? "no valid plan",
    attempts: maxRepairs + 1,
  });

  const manifest = linearFallback(options.markdown, source, { maxTasks });
  logger.info("plan.validated", {
    tasks: manifest.tasks.length,
    edges: Math.max(0, manifest.tasks.length - 1),
    origin: "fallback",
  });
  return { manifest, origin: "fallback", attempts: maxRepairs + 1, warnings };
}
