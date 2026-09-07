import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  PROVIDER_IDS,
  type ArtifactKind,
  isDeferredModel,
  providerForModel,
  writeConsensusCriteriaSchema,
  writeCritiqueResultSchema,
  writeReconcileResultSchema,
  writeProposalResultSchema,
  writeAgreementResultSchema,
  type ConsensusCriteria,
  type ProviderId,
} from '../manifest/index.js';
import { createLogger, resolveStderrLevel, type Logger } from '../log/index.js';
import { checkTaskText } from '../planner/index.js';
import { runPlannerProvider } from '../planner/index.js';
import {
  BUILTIN_CATALOG,
  mergeCatalog,
  resolveModel,
  type Catalog,
  type ProviderUsage,
  type Registry,
} from '../providers/index.js';
import { killGroup, makeRunId } from '../executor/index.js';
import {
  binOverrides as binOverridesFrom,
  loadConfig,
  providerToolSettings,
} from '../config/index.js';
import { confirmPlan, createProgress, type Progress } from '../ui/index.js';
import { createTheme, type Theme } from '../ui/theme.js';
import { compactPrompt } from '../consensus/prompt.js';
import {
  assignPseudonyms,
  resolveCriteria,
  runConsensus,
  type ConsensusRunner,
} from '../consensus/engine.js';
import { consensusPaths, type ConsensusPaths } from '../consensus/paths.js';
import {
  DEFAULT_LEDGER_BUDGET,
  compactLedger,
  ledgerFor,
  persistRound,
  writeFile,
} from '../consensus/store.js';
import { renderConsensusReport } from '../ui/consensus-report.js';
import { createRoundSpinner } from './spinner.js';
import { installInterruptHandlers } from './interrupt.js';
import { KIND_NEEDS_DRAFT, KIND_NEEDS_WORKSPACE, type ParsedArgs } from './args.js';
import type { CliIo } from './run.js';

/**
 * `baya consensus` — several provider CLIs debate one artifact
 * (specs/002-ai-consensus). Not a `run`: no DAG, no manifest, no task list.
 *
 * ⚠️ Takes **no** directory lock, by design (§8). Reviewers run loose and in
 * parallel; the gate says so and nothing prevents it.
 */
export interface ConsensusCommandOptions {
  args: ParsedArgs;
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  registry: Registry;
}

const CALL_TIMEOUT_MS = 900_000;

function nullStream(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

/** A path if one exists on disk, else the text itself is the artifact. */
function readArtifact(
  input: string,
  cwd: string,
): { artifact: string; sourcePath: string | null } {
  const candidate = resolvePath(cwd, input);
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return { artifact: readFileSync(candidate, 'utf8'), sourcePath: input };
  }
  return { artifact: input, sourcePath: null };
}

/** One participant: which CLI runs, and which model it runs. */
interface Participant {
  provider: ProviderId;
  /** `null` ⇒ the provider's own default. Never a hard-coded id. */
  model: string | null;
}

/**
 * A participant is named by **model**, not by provider — `luna`, `sonnet`,
 * `gpt-5.6-luna`. Baya already knows which CLI serves a model id
 * (`providerForModel`, the catalog, and `modelAliases`), so naming the CLI too
 * would be saying the same thing twice and inviting a mismatched pair.
 *
 * A bare provider id is still accepted and means "that CLI, its own default
 * model" — the shortest way to say "just use claude".
 */
function resolveParticipant(
  token: string,
  catalog: Catalog,
  userAliases: Record<string, string>,
): Participant | { error: string } {
  if ((PROVIDER_IDS as readonly string[]).includes(token)) {
    return { provider: token as ProviderId, model: null };
  }

  // The catalog answers exactly when it can: an exact id, a known alias, or
  // one of the user's own nicknames.
  for (const runDefaultProvider of PROVIDER_IDS) {
    const resolved = resolveModel(token, { catalog, userAliases, runDefaultProvider });
    const match = resolved.match;
    if (match !== null && match.via !== 'literal' && match.via !== 'best-match') {
      return { provider: match.provider, model: match.model };
    }
    break;
  }

  // ⚠️ The catalog is a convenience list, not an allowlist (providers.md): ids
  // ship faster than it does, so a routable name passes through unchanged.
  const routed = providerForModel(token);
  if (routed !== null) return { provider: routed, model: token };

  if (isDeferredModel(token)) {
    return { error: `${token}: gemini is verified but has no adapter yet` };
  }
  return {
    error: `${token}: not a known model or provider — try \`baya models\` for the catalog`,
  };
}

/** `--providers luna,sonnet` → one participant each, first mention wins. */
function parseParticipants(
  raw: string,
  catalog: Catalog,
  userAliases: Record<string, string>,
): { participants: Participant[]; errors: string[] } {
  const participants: Participant[] = [];
  const errors: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    if (part === '') continue;
    const resolved = resolveParticipant(part, catalog, userAliases);
    if ('error' in resolved) {
      errors.push(resolved.error);
      continue;
    }
    // ⚠️ One reviewer per CLI: `reviewers/<provider>/` is the ledger's key, so
    // two models of one CLI would share a history. Worth revisiting.
    if (participants.some((entry) => entry.provider === resolved.provider)) {
      errors.push(
        `${part}: ${resolved.provider} is already reviewing — one model per CLI per debate`,
      );
      continue;
    }
    participants.push(resolved);
  }
  return { participants, errors };
}

export async function consensusCommand(
  options: ConsensusCommandOptions,
): Promise<number> {
  const startedAt = Date.now();
  const { args, cwd, env, io, registry } = options;
  const { flags } = args;
  const theme = createTheme(flags.noColor || env['NO_COLOR'] ? 'never' : 'auto');

  if (args.file === null) {
    io.stderr.write(`${theme.status('fail')} consensus needs a file path or a prompt\n`);
    return 2;
  }

  const { artifact, sourcePath } = readArtifact(args.file, cwd);
  const unreadable = checkTaskText(artifact, sourcePath ?? '(prompt)');
  if (unreadable !== null) {
    io.stderr.write(`${theme.status('fail')} ${unreadable}\n`);
    return 2;
  }

  const loaded = loadConfig({ cwd, env, flags: {} });
  const binOverrides = binOverridesFrom(loaded.config);
  const { providerTools, extraArgs } = providerToolSettings(loaded.config);
  void extraArgs;

  // ---- who reviews, who moderates — named by model, not by provider
  const catalog = mergeCatalog(BUILTIN_CATALOG, loaded.config.modelCatalog);
  const userAliases = loaded.config.modelAliases;

  let specs: Participant[];
  if (flags.providers !== undefined) {
    const parsed = parseParticipants(flags.providers, catalog, userAliases);
    if (parsed.errors.length > 0) {
      for (const error of parsed.errors) {
        io.stderr.write(`${theme.status('fail')} ${theme.fail(error)}\n`);
      }
      return 2;
    }
    specs = parsed.participants;
  } else {
    // The configured default is a **model**; its CLI follows from it.
    const fallback =
      loaded.config.defaults.model !== null
        ? resolveParticipant(loaded.config.defaults.model, catalog, userAliases)
        : loaded.config.defaults.provider !== null
          ? { provider: loaded.config.defaults.provider, model: null }
          : { error: 'no default model configured' };
    if ('error' in fallback) {
      io.stderr.write(
        `${theme.status('fail')} no reviewers: set a default with \`baya config\`, or name them with --providers\n`,
      );
      return 2;
    }
    specs = [fallback];
  }

  if (specs.length === 0) {
    io.stderr.write(`${theme.status('fail')} --providers named no known model\n`);
    return 2;
  }
  const reviewers = specs.map((spec) => spec.provider);
  const reviewerModels = new Map<ProviderId, string | null>(
    specs.map((spec) => [spec.provider, spec.model]),
  );

  const moderatorToken = flags.moderator ?? flags.moderatorModel;
  const moderatorSpec: Participant | { error: string } =
    moderatorToken !== undefined
      ? resolveParticipant(moderatorToken, catalog, userAliases)
      : loaded.config.planner.model !== null
        ? resolveParticipant(loaded.config.planner.model, catalog, userAliases)
        : loaded.config.planner.provider !== null
          ? { provider: loaded.config.planner.provider, model: null }
          : {
              provider: specs[0]?.provider as ProviderId,
              model: specs[0]?.model ?? null,
            };
  if ('error' in moderatorSpec) {
    io.stderr.write(`${theme.status('fail')} moderator: ${moderatorSpec.error}\n`);
    return 2;
  }
  const moderator = moderatorSpec.provider;
  const moderatorModel = moderatorSpec.model;

  // ---- resolve every binary before spending anything
  const needed = [...new Set<ProviderId>([...reviewers, moderator])];
  const statuses = await registry.resolveAll({ binOverrides, env, probe: false });
  const resolved = new Map<ProviderId, string>();
  const missing: ProviderId[] = [];
  for (const id of needed) {
    const bin = statuses.find((status) => status.id === id)?.resolved?.bin;
    if (bin === undefined) missing.push(id);
    else resolved.set(id, bin);
  }
  if (missing.length > 0) {
    io.stderr.write(
      `${theme.status('fail')} not installed: ${missing.join(', ')} — run \`baya doctor\`\n`,
    );
    return 2;
  }

  // ---- run identity, logging, progress
  const runId = makeRunId();
  const paths = consensusPaths(cwd, runId);
  mkdirSync(paths.runDir, { recursive: true });
  writeFile(paths.input, artifact);

  const progress: Progress = createProgress({
    stream: io.stderr,
    disabled: flags.noProgress,
    json: flags.json,
    env,
  });
  const stderrSink = {
    write(chunk: string | Uint8Array): boolean {
      progress.write(String(chunk).replace(/\n$/, ''));
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  const logger: Logger = createLogger({
    runId,
    traceFile: paths.log,
    stderrLevel: resolveStderrLevel({
      ...(flags.logLevel ? { logLevel: flags.logLevel } : {}),
      verbose: flags.verbose,
      quiet: flags.quiet,
    }),
    stderrStream: flags.json ? nullStream() : stderrSink,
    // ⚠️ Provider prose is `debug` here, inverting `run` (§11): four reviewers
    // arguing about the same paragraphs at once is noise, not work.
    render: () => null,
  });

  const label = describeArtifact(artifact, sourcePath);
  logger.info('consensus.created', {
    run_id: runId,
    artifact: label,
    source: sourcePath,
    kind: flags.kind ?? null,
    reviewers,
    moderator,
  });

  const maxRounds = flags.rounds ?? 5;
  const ledgerBudget = flags.ledgerBudget ?? DEFAULT_LEDGER_BUDGET;

  const schemaDir = paths.schemaDir;
  const criteriaSchemaPath = writeConsensusCriteriaSchema(schemaDir);
  const critiqueSchemaPath = writeCritiqueResultSchema(schemaDir);
  const reconcileSchemaPath = writeReconcileResultSchema(schemaDir);
  const proposalSchemaPath = writeProposalResultSchema(schemaDir);
  const agreementSchemaPath = writeAgreementResultSchema(schemaDir);
  const schemaPathFor = (kind: string): string =>
    kind === 'criteria'
      ? criteriaSchemaPath
      : kind === 'reconcile'
        ? reconcileSchemaPath
        : kind === 'propose'
          ? proposalSchemaPath
          : kind === 'agree'
            ? agreementSchemaPath
            : critiqueSchemaPath;

  // ---- the gate
  const criteriaGiven: ConsensusCriteria | undefined =
    flags.kind === undefined
      ? undefined
      : {
          baya: '1',
          kind: 'consensus_criteria',
          artifact_kind: flags.kind,
          needs_workspace: KIND_NEEDS_WORKSPACE[flags.kind],
          needs_draft: KIND_NEEDS_DRAFT[flags.kind],
          criteria: [
            {
              id: 'correctness',
              question: 'What here is wrong, missing, or unworkable?',
            },
            { id: 'risk', question: 'What fails first under real conditions?' },
          ],
        };

  const spinner = createRoundSpinner({ progress, theme, stream: io.stderr });

  // ⚠️ Mandatory, and it already cost once: children spawn `detached: true`,
  // so a terminal SIGINT never reaches them. Consensus spawns N per round —
  // pass 0 included, which is why this is installed before the first call.
  const live = new Set<number>();
  const uninstallInterrupts = installInterruptHandlers({
    logger,
    // The live block is a second owner of the terminal (`src/ui/block.ts`), so
    // teardown has to clear it too or Ctrl+C leaves rows painted and the
    // cursor hidden. `progress.dispose()` alone only covers ora.
    progress: {
      ...progress,
      dispose: () => {
        spinner.dispose();
        progress.dispose();
      },
    },
    activePids: () => live,
    killGroup,
    checkpointInterrupted: () => undefined,
    releaseLock: () => undefined,
    exit: (code) => process.exit(code),
  });

  // Computed here, not read off the outcome: the round callback needs them
  // while the debate is still running. Same function the engine uses.
  const assigned = assignPseudonyms(reviewers);
  const aliasOf = (provider: ProviderId): string =>
    Object.entries(assigned).find(([, id]) => id === provider)?.[0] ?? provider;
  const usage: { provider: ProviderId; usage: ProviderUsage }[] = [];

  const schemaFor = (provider: ProviderId, kind: string): string | undefined => {
    const adapter = registry.get(provider);
    if (adapter === undefined) return undefined;
    if (adapter.capabilities.structuredOutput !== 'none') return undefined;
    return readFileSync(
      schemaPathFor(
        kind === 'critique_result'
          ? 'review'
          : kind === 'reconcile_result'
            ? 'reconcile'
            : kind === 'proposal_result'
              ? 'propose'
              : kind === 'agreement_result'
                ? 'agree'
                : 'criteria',
      ),
      'utf8',
    );
  };

  const runner: ConsensusRunner = async (call) => {
    const bin = resolved.get(call.provider) as string;
    const adapter = registry.get(call.provider);
    if (adapter === undefined) throw new Error(`no adapter for ${call.provider}`);
    const model =
      call.role === 'moderator'
        ? moderatorModel
        : (reviewerModels.get(call.provider) ?? null);
    const schemaPath = schemaPathFor(call.kind);
    const callId = `${call.provider}-${call.kind}-${String(call.round)}`;
    const resultFile = paths.callResult(callId, call.round);

    spinner.started(call.provider, model, call.round, call.kind);
    // Every call leaves a record, whatever the provider's schema tier: only
    // codex fills `result.json`, so without these a claude or opencode call
    // left an empty directory behind.
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    try {
      const run = runPlannerProvider({
        adapter,
        bin,
        cwd,
        model,
        schemaPath,
        resultFile,
        runId,
        logger,
        env,
        timeoutMs: CALL_TIMEOUT_MS,
        taskId: callId,
        taskTitle: `consensus ${call.kind}`,
        // §7: one posture for the whole run, chosen by the moderator.
        access: call.needsWorkspace ? 'read-write' : 'read-only',
        noTools: !call.needsWorkspace,
        ...(call.needsWorkspace && providerTools[call.provider]
          ? { tools: providerTools[call.provider] as never }
          : {}),
        onProcessSpawn: (pid) => live.add(pid),
        onProcessExit: (pid) => live.delete(pid),
        onUsage: (u) => usage.push({ provider: call.provider, usage: u }),
        onStdoutLine: (line) => stdoutLines.push(line),
        onStderrLine: (line) => stderrLines.push(line),
      });
      const answer = await run(call.prompt, 0);
      writeFile(paths.callAnswer(callId, call.round), answer);
      return answer;
    } finally {
      spinner.finished(call.provider);
      if (stdoutLines.length > 0) {
        writeFile(paths.callStdout(callId, call.round), `${stdoutLines.join('\n')}\n`);
      }
      if (stderrLines.length > 0) {
        writeFile(paths.callStderr(callId, call.round), `${stderrLines.join('\n')}\n`);
      }
    }
  };

  // Pass 0 first: the posture it returns is what the gate has to show.
  let criteria: ConsensusCriteria;
  try {
    criteria = await resolveCriteria({
      artifact,
      sourcePath,
      moderator,
      runner,
      logger,
      ...(criteriaGiven ? { criteria: criteriaGiven } : {}),
      schemaFor,
      onCallSettled: (info) => {
        if (flags.json || flags.quiet) return;
        spinner.completed(info.provider, { ok: info.ok, detail: describeCall(info) });
      },
    });
  } catch (error) {
    spinner.dispose();
    progress.dispose();
    uninstallInterrupts();
    io.stderr.write(
      `${theme.status('fail')} ${theme.fail(
        `could not set the criteria: ${error instanceof Error ? error.message : String(error)}`,
      )}\n`,
    );
    return 1;
  }

  const calls = maxRounds * (reviewers.length + 1) + (criteria.needs_draft ? 1 : 0);
  if (!flags.json) {
    io.stderr.write(
      renderGate({
        theme,
        artifact: label,
        criteria,
        moderator,
        moderatorModel,
        reviewers,
        reviewerModels,
        maxRounds,
        calls,
        cwd,
      }),
    );
  }

  let gate;
  try {
    gate = await confirmPlan({
      yes: flags.yes,
      stdinIsTty: io.stdinIsTty,
      beforePrompt: () => spinner.dispose(),
      message: 'Start the debate?',
    });
  } catch {
    // Ctrl+C at the prompt: inquirer aborts by throwing. Nothing is in flight
    // here, so this is a plain decline — the SIGINT handler owns the exit code.
    spinner.dispose();
    progress.dispose();
    uninstallInterrupts();
    logger.info('consensus.rejected', { reason: 'interrupted' });
    return 130;
  }
  if (gate.decision === 'blocked') {
    spinner.dispose();
    progress.dispose();
    uninstallInterrupts();
    logger.warn('consensus.rejected', { reason: 'non-tty' });
    io.stderr.write(`${theme.status('fail')} ${theme.fail(gate.message)}\n`);
    return 2;
  }
  if (gate.decision === 'rejected') {
    spinner.dispose();
    progress.dispose();
    uninstallInterrupts();
    logger.info('consensus.rejected', { reason: 'answered' });
    io.stderr.write(`  ${theme.note('nothing run')}\n`);
    return 0;
  }
  logger.info('consensus.confirmed', { reason: gate.reason });

  let outcome;
  try {
    outcome = await runConsensus({
      criteria,
      artifact,
      sourcePath,
      moderator,
      reviewers,
      maxRounds,
      cwd,
      runner,
      logger,
      schemaFor,
      ledgerFor: (provider, round) => ledgerFor(paths, provider, round),
      onCallSettled: (info) => {
        if (flags.json || flags.quiet) return;
        spinner.completed(info.provider, {
          ok: info.ok,
          detail: describeCall(info),
        });
      },
      onRoundSettled: async (record) => {
        persistRound({
          paths,
          record,
          reviewers,
          moderator,
          aliasOf,
        });
        await compactAll({
          paths,
          reviewers,
          moderator,
          round: record.round,
          budget: ledgerBudget,
          logger,
          compact: async (ledger, ids) =>
            runner({
              provider: moderator,
              role: 'moderator',
              kind: 'compact',
              round: record.round,
              needsWorkspace: false,
              prompt: compactPrompt({ ledger, ids, budget: ledgerBudget }),
            }),
        });
      },
    });
  } finally {
    spinner.dispose();
    progress.dispose();
    uninstallInterrupts();
  }

  writeFile(paths.criteria, `${JSON.stringify(outcome.criteria, null, 2)}\n`);

  writeFile(paths.pseudonyms, `${JSON.stringify(assigned, null, 2)}\n`);
  writeFile(paths.final, outcome.document);

  const report = {
    run_id: runId,
    artifact,
    source: sourcePath,
    artifact_kind: outcome.criteria.artifact_kind,
    needs_workspace: outcome.needsWorkspace,
    needs_draft: outcome.criteria.needs_draft,
    proposed: outcome.proposed,
    moderator,
    reviewers,
    rounds: outcome.rounds.length,
    stop_reason: outcome.stopReason,
    usage,
    document: outcome.document,
  };
  writeFile(paths.report, `${JSON.stringify(report, null, 2)}\n`);

  if (flags.json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stderr.write(
      renderConsensusReport({
        theme,
        outcome,
        usage,
        paths,
        noDiff: flags.noDiff,
        elapsedMs: Date.now() - startedAt,
      }),
    );
    // Piped only — interactively the report already prints every answer in
    // full. A redirect still gets the bare document.
    if (flags.output === undefined && !io.stdoutIsTty) {
      io.stdout.write(`${outcome.document}\n`);
    }
  }
  if (flags.output !== undefined) {
    writeFileSync(resolvePath(cwd, flags.output), `${outcome.document}\n`, 'utf8');
  }

  // A run that produced a document succeeded, ceiling or not (§2). A single
  // answer with no merge behind it is still a document.
  return outcome.rounds.some(
    (round) => round.reconcile !== null || (round.proposals?.length ?? 0) > 0,
  )
    ? 0
    : 1;
}

/**
 * What the run is about, in one line. A path when there is one; otherwise the
 * text itself, which is the only place a `--prompt` run's subject survives.
 */
export function describeArtifact(artifact: string, sourcePath: string | null): string {
  if (sourcePath !== null) return sourcePath;
  const first = artifact.trim().split('\n')[0]?.trim() ?? '';
  if (first === '') return '(prompt)';
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}

/** The half-sentence a completion line ends with. */
function describeCall(info: {
  kind: 'criteria' | 'propose' | 'agree' | 'review' | 'reconcile';
  ok: boolean;
  findings?: number;
  blocking?: number;
  changes?: number;
  agreed?: boolean;
  differences?: number;
  error?: string;
}): string {
  if (!info.ok) return info.error ?? 'failed';
  if (info.kind === 'criteria') return 'set the criteria';
  if (info.kind === 'propose') return 'answered';
  if (info.kind === 'agree') {
    if (info.agreed === true) return 'same page';
    const split = info.differences ?? 0;
    return `not yet · ${String(split)} difference${split === 1 ? '' : 's'}`;
  }
  if (info.kind === 'reconcile') {
    const changes = info.changes ?? 0;
    return `reconciled · ${String(changes)} decision${changes === 1 ? '' : 's'}`;
  }
  const findings = info.findings ?? 0;
  if (findings === 0) return 'nothing to raise';
  const blocking = info.blocking ?? 0;
  const weight = blocking > 0 ? ` (${String(blocking)} blocking)` : '';
  return `${String(findings)} finding${findings === 1 ? '' : 's'}${weight}`;
}

/** Compact every ledger that has outgrown the budget (§3.2). */
async function compactAll(options: {
  paths: ConsensusPaths;
  reviewers: readonly ProviderId[];
  moderator: ProviderId;
  round: number;
  budget: number;
  logger: Logger;
  compact: (ledger: string, ids: readonly string[]) => Promise<string>;
}): Promise<void> {
  for (const provider of options.reviewers) {
    const ledger = ledgerFor(options.paths, provider, options.round + 1);
    if (ledger === '') continue;
    const result = await compactLedger({
      ledger,
      budget: options.budget,
      compact: options.compact,
    });
    options.logger.info('consensus.ledger', {
      provider,
      round: options.round,
      chars_raw: result.charsRaw,
      chars_sent: result.charsSent,
      tier: result.tier,
    });
    if (result.tier !== 'none') {
      writeFile(options.paths.digest(provider, options.round), result.text);
      options.logger.info('consensus.compacted', {
        provider,
        round: options.round,
        tier: result.tier,
      });
    }
  }
}

export /** What the run will actually produce, in the plainest words available. */
const READING: Readonly<Record<ArtifactKind, string>> = {
  question: 'answering the question',
  prompt: 'rewriting the prompt',
  plan: 'improving the plan',
  spec: 'improving the spec',
  review: 'reviewing the work',
  idea: 'developing the idea',
};

export function renderGate(options: {
  theme: Theme;
  artifact: string;
  moderator: ProviderId;
  moderatorModel: string | null;
  reviewers: readonly ProviderId[];
  reviewerModels: ReadonlyMap<ProviderId, string | null>;
  maxRounds: number;
  calls: number;
  cwd: string;
  criteria: ConsensusCriteria;
}): string {
  const { theme } = options;
  // Green means the agents can touch nothing; yellow means they can write in
  // your tree. The one word on this line with a blast radius behind it.
  const posture = options.criteria.needs_workspace
    ? theme.warn('workspace')
    : theme.ok('tool-less');
  const lines = [
    '',
    `  ${theme.note('consensus')} · ${options.artifact} · ${posture}`,
    // ⚠️ The same text can be answered or rewritten, and the difference is the
    // whole output, and it was once left to be inferred.
    `  ${theme.note('doing')}     ${READING[options.criteria.artifact_kind]}`,

    '',
    `  ${theme.note('moderator')} ${theme.provider(options.moderator)}${options.moderatorModel ? ` ${options.moderatorModel}` : theme.note(' (provider default)')}`,
    // One line, model names only — a pinned model is the likeliest thing to be
    // wrong and this is the last place to catch it, so it is always shown.
    `  ${theme.note('reviewers')} [${options.reviewers
      .map((id) => options.reviewerModels.get(id) ?? id)
      .join(', ')}]`,
    // ⚠️ The criteria are not shown. They are the moderator's private
    // yardstick, and a producing run has none at all — consensus.md §3.6.
    '',
    `  ${theme.note('at most')}   ${String(options.calls)} more provider calls · ${String(options.maxRounds)} rounds · ${
      options.criteria.needs_draft
        ? 'stops as soon as the answers agree'
        : 'stops early when nothing blocking is left, or when a round raises nothing new'
    }`,
    '',
  ];
  // ⚠️ Only in the workspace posture, so it keeps its signal (§10).
  if (options.criteria.needs_workspace) {
    lines.push(
      `  🤖 ${String(options.reviewers.length)} agents will run unsupervised in ${theme.path(options.cwd)}`,
      `     they can write here, several at once, and nothing isolates them`,
      `     commit or stash first · not for use while developing in this tree`,
      '',
    );
  }
  return lines.join('\n');
}
