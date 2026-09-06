import {
  BLOCKING_SEVERITIES,
  type Change,
  ConsensusCriteriaSchema,
  CritiqueResultSchema,
  AgreementResultSchema,
  ProposalResultSchema,
  ReconcileResultSchema,
  type ConsensusCriteria,
  type CritiqueResult,
  type Finding,
  type ProviderId,
  type AgreementResult,
  type ReconcileResult,
} from '../manifest/index.js';
import type { Logger } from '../log/index.js';
import { stripAnsi } from '../log/index.js';
import {
  agreementPrompt,
  criteriaPrompt,
  proposalPrompt,
  reconcilePrompt,
  revisePrompt,
  reviewPrompt,
} from './prompt.js';

/**
 * The debate itself (specs/002-ai-consensus §3, §5, §6). Pure orchestration
 * over an injected `ConsensusRunner`, so every round runs offline in tests
 * against scripted answers — the seam `PlannerRunner` already established.
 *
 * Knows nothing about processes, adapters, or the filesystem. Persistence is
 * the caller's; this returns the record and lets the caller write it.
 */

/** One provider call. `kind` is only for logging and error messages. */
export type ConsensusRunner = (call: {
  provider: ProviderId;
  role: 'moderator' | 'reviewer';
  kind: 'criteria' | 'propose' | 'agree' | 'review' | 'reconcile' | 'compact';
  prompt: string;
  round: number;
  needsWorkspace: boolean;
}) => Promise<string>;

export interface RoundCritique {
  provider: ProviderId;
  /** Pseudonym shown to other reviewers (§3.3). Stable across rounds. */
  alias: string;
  result: CritiqueResult;
}

export interface RoundProposal {
  provider: ProviderId;
  /** Pseudonym the others see. Never their provider id. */
  alias: string;
  document: string;
  notes: string[];
}

export interface RoundRecord {
  round: number;
  critiques: RoundCritique[];
  /** A producing run: what each reviewer answered this round. */
  proposals?: RoundProposal[];
  /** A producing run: whether the moderator found them saying the same thing. */
  agreement?: AgreementResult | null;
  /** Moderator edits that cite no finding. Reported, never silently kept. */
  unsourced?: Change[];
  /** Accepted changes naming no criterion of this run. Recorded, never applied. */
  dropped?: Change[];
  /** Providers whose call failed, with why. The round proceeds on the rest. */
  failed: { provider: ProviderId; message: string }[];
  reconcile: ReconcileResult | null;
  document: string;
}

export type StopReason =
  'converged' | 'split' | 'stalled' | 'ceiling' | 'no_reviewers' | 'no_reconcile';

export interface ConsensusOutcome {
  criteria: ConsensusCriteria;
  needsWorkspace: boolean;
  rounds: RoundRecord[];
  document: string;
  /** True when the reviewers produced answers rather than critiques. */
  proposed: boolean;
  stopReason: StopReason;
  /** Alias -> real provider id. Written to the run directory, never to a prompt. */
  pseudonyms: Record<string, ProviderId>;
}

export interface ConsensusOptions {
  artifact: string;
  sourcePath: string | null;
  moderator: ProviderId;
  reviewers: readonly ProviderId[];
  maxRounds: number;
  cwd: string;
  runner: ConsensusRunner;
  logger: Logger;
  /** Set to skip pass 0. `--kind` supplies both the kind and the posture. */
  criteria?: ConsensusCriteria;
  /** Rendered ledger for a reviewer, or `''`. Called once per reviewer per round. */
  ledgerFor?: (provider: ProviderId, round: number) => string;
  /**
   * Fires once per provider call, after its answer is parsed. The terminal's
   * completion line is written from here — the block only ever holds what is
   * still running, so what finished has to be reported separately.
   */
  onCallSettled?: (info: {
    provider: ProviderId;
    role: 'moderator' | 'reviewer';
    kind: 'criteria' | 'propose' | 'agree' | 'review' | 'reconcile';
    round: number;
    ok: boolean;
    findings?: number;
    blocking?: number;
    changes?: number;
    agreed?: boolean;
    differences?: number;
    error?: string;
  }) => void;
  /** Called after each round settles, so the caller can persist and compact. */
  onRoundSettled?: (
    record: RoundRecord,
    outcome: Pick<ConsensusOutcome, 'criteria'>,
  ) => Promise<void> | void;
  /** Schema documents for providers that enforce none. Keyed by contract name. */
  schemaFor?: (provider: ProviderId, kind: string) => string | undefined;
}

/**
 * A model that returned the schema instead of an instance. Both are JSON
 * objects, so zod reports a wall of unrecognized keys and names nothing the
 * reader can act on.
 */
export function isSchemaEcho(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return '$schema' in record || ('properties' in record && 'required' in record);
}

/**
 * The CLI's own error envelope, reaching the parser because the provider never
 * produced an answer at all. Measured 2026-09-06: claude spent six turns on
 * tool calls, hit `stop_reason: "tool_use"`, and its envelope parsed as a
 * critique missing every field — reported as `Invalid literal value, expected
 * "1"`, which names nothing the reader can do anything about.
 */
export function providerErrorIn(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record['is_error'] !== true && !('stop_reason' in record)) return null;
  const stop = record['stop_reason'];
  const turns = record['num_turns'];
  const detail = [
    typeof stop === 'string' ? `stop_reason: ${stop}` : null,
    typeof turns === 'number' ? `${String(turns)} turns` : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
  return detail === ''
    ? 'the provider errored before answering'
    : `the provider errored before answering (${detail})`;
}

/** Why a payload could not be read, in words worth printing. */
export function describeParseFailure(payload: unknown, fallback: string): string {
  if (isSchemaEcho(payload)) return 'returned the schema instead of an answer';
  return providerErrorIn(payload) ?? fallback;
}

/**
 * Interrogatives that open a question. Deliberately broad — the cost of a
 * false positive is a question answered instead of reworded, which is what
 * almost everyone wanted anyway.
 */
const INTERROGATIVES = new Set([
  'who',
  'what',
  'when',
  'where',
  'why',
  'how',
  'which',
  'whose',
  'whom',
  'will',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'shall',
  'may',
  'might',
  'has',
  'have',
  'had',
  'am',
]);

/**
 * A single-line artifact that asks something.
 *
 * ⚠️ Deterministic on purpose. Whether your question gets answered or reworded
 * is the entire output, and a model should not get a vote: measured
 * 2026-09-06, the same input was classified `prompt` on one run and answered
 * on another. Nobody asks a question hoping to have it rewritten — that is
 * `--kind prompt`, which still overrides this.
 */
export function looksLikeQuestion(artifact: string): boolean {
  const text = artifact.trim();
  if (text === '' || text.includes('\n')) return false;
  if (text.endsWith('?')) return true;
  const first =
    text
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z]/g, '') ?? '';
  return INTERROGATIVES.has(first);
}

/** Rung order matches `parsePlanDraft`: verbatim JSON, then the last fenced block. */
export function parseDocument(raw: string): unknown | null {
  const text = stripAnsi(raw).trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the fenced rung
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

/** `Reviewer A`, `Reviewer B`, … assigned once and stable for the run (§3.3). */
export function assignPseudonyms(
  reviewers: readonly ProviderId[],
): Record<string, ProviderId> {
  const map: Record<string, ProviderId> = {};
  reviewers.forEach((provider, index) => {
    map[`Reviewer ${String.fromCharCode(65 + index)}`] = provider;
  });
  return map;
}

/**
 * `f1` from claude and `f1` from codex are different findings. Baya prefixes
 * on read; no model ever sees or writes the prefix.
 */
export function namespaceFindings(
  provider: ProviderId,
  findings: readonly Finding[],
): Finding[] {
  return findings.map((finding) => ({ ...finding, id: `${provider}:${finding.id}` }));
}

/**
 * Baya's own stop condition (§6). A model's `converged` is advisory and is
 * never consulted here — asked whether it is done, a model says yes.
 */
/**
 * Changes the moderator made that cite no finding — its own voice, where it is
 * meant to have none (§3.5). Detected rather than prevented: the edit is
 * already in the document by the time it is read back, so the honest move is
 * to name it, not to pretend it did not happen.
 */
export function unsourcedChanges(reconcile: ReconcileResult | null): Change[] {
  if (reconcile === null) return [];
  return reconcile.changes.filter((change) => change.finding_ids.length === 0);
}

export function hasBlockingFindings(critiques: readonly RoundCritique[]): boolean {
  return critiques.some((critique) =>
    critique.result.findings.some((finding) =>
      BLOCKING_SEVERITIES.includes(finding.severity),
    ),
  );
}

/** Every finding raised in the run, by its Baya-namespaced id. */
export function findingIndex(rounds: readonly RoundRecord[]): Map<string, Finding> {
  const index = new Map<string, Finding>();
  for (const round of rounds) {
    for (const critique of round.critiques) {
      for (const finding of critique.result.findings) index.set(finding.id, finding);
    }
  }
  return index;
}

/**
 * Changes the moderator accepted while naming a criterion this run does not
 * have — invented, or borrowed from somewhere the criteria are not.
 *
 * ⚠️ The last deterministic guard on scope. The criteria never reach a
 * reviewer, so a finding cannot be checked against them; what can be checked
 * is the moderator's own declaration of which criterion it served. Measured
 * 2026-09-06: a reviewer's global instructions file supplied a finding
 * ("must open with a TL;DR"), the moderator accepted it, and the answer
 * changed — with nothing in the record saying why.
 */
export function offCriteria(
  criteria: ConsensusCriteria,
  reconcile: ReconcileResult | null,
): Change[] {
  if (reconcile === null) return [];
  const known = new Set(criteria.criteria.map((criterion) => criterion.id));
  return reconcile.changes.filter(
    (change) => change.action === 'accepted' && !known.has(change.criterion_id),
  );
}

/** The reconcile as Baya will apply it, with off-criteria acceptances dropped. */
export function onCriteria(
  criteria: ConsensusCriteria,
  reconcile: ReconcileResult,
): ReconcileResult {
  const stray = new Set(offCriteria(criteria, reconcile));
  if (stray.size === 0) return reconcile;
  return {
    ...reconcile,
    changes: reconcile.changes.filter((change) => !stray.has(change)),
  };
}

/** Criterion ids the moderator accepted a change for, that round. */
export function appliedCriteria(record: RoundRecord | undefined): Set<string> {
  const ids = new Set<string>();
  if (record?.reconcile == null) return ids;
  for (const change of record.reconcile.changes) {
    if (change.action === 'accepted' && change.criterion_id !== '') {
      ids.add(change.criterion_id);
    }
  }
  return ids;
}

/**
 * Criteria the moderator accepted a fix for last round and is accepting a fix
 * for again, with nothing else moving. Measured 2026-09-06: one unsatisfiable
 * criterion produced every finding in rounds 2 and 3 of a three-round run.
 */
export function stalledCriteria(
  previous: RoundRecord | undefined,
  reconcile: ReconcileResult | null,
  blocking: boolean,
): string[] {
  if (!blocking || reconcile === null) return [];
  const now = new Set(
    reconcile.changes
      .filter((change) => change.action === 'accepted' && change.criterion_id !== '')
      .map((change) => change.criterion_id),
  );
  if (now.size === 0) return [];
  const before = appliedCriteria(previous);
  const repeated = [...now].filter((id) => before.has(id));
  // A criterion touched for the first time is progress, not a loop.
  return repeated.length === now.size ? repeated.sort() : [];
}

/** One reviewer, one round of a producing run. */
async function askOne(
  options: ConsensusOptions,
  provider: ProviderId,
  alias: string,
  round: number,
  needsWorkspace: boolean,
  prompt: string,
): Promise<{ provider: ProviderId; proposal?: RoundProposal; error?: string }> {
  try {
    const raw = await options.runner({
      provider,
      role: 'reviewer',
      kind: 'propose',
      round,
      needsWorkspace,
      prompt,
    });
    const payload = parseDocument(raw);
    const parsed = ProposalResultSchema.safeParse(payload);
    if (!parsed.success) {
      const why = describeParseFailure(
        payload,
        parsed.error.issues[0]?.message ?? 'unparseable answer',
      );
      options.onCallSettled?.({
        provider,
        role: 'reviewer',
        kind: 'propose',
        round,
        ok: false,
        error: why,
      });
      return { provider, error: why };
    }
    options.onCallSettled?.({
      provider,
      role: 'reviewer',
      kind: 'propose',
      round,
      ok: true,
    });
    return {
      provider,
      proposal: {
        provider,
        alias,
        document: parsed.data.document,
        notes: parsed.data.notes,
      },
    };
  } catch (error) {
    return { provider, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The moderator's only call in a producing run.
 *
 * ⚠️ Returns whether the answers say the same thing, and nothing else. It has
 * no document to return and no winner to pick — §3.6.
 */
async function askAgreement(
  options: ConsensusOptions,
  round: number,
  needsWorkspace: boolean,
  proposals: readonly RoundProposal[],
): Promise<AgreementResult | null> {
  try {
    const raw = await options.runner({
      provider: options.moderator,
      role: 'moderator',
      kind: 'agree',
      round,
      needsWorkspace,
      prompt: agreementPrompt({
        artifact: options.artifact,
        round,
        answers: proposals.map((proposal) => ({
          alias: proposal.alias,
          document: proposal.document,
        })),
        needsWorkspace,
        cwd: options.cwd,
        ...(options.schemaFor?.(options.moderator, 'agreement_result') !== undefined
          ? {
              schema: options.schemaFor(options.moderator, 'agreement_result') as string,
            }
          : {}),
      }),
    });
    const payload = parseDocument(raw);
    const parsed = AgreementResultSchema.safeParse(payload);
    if (parsed.success) {
      options.onCallSettled?.({
        provider: options.moderator,
        role: 'moderator',
        kind: 'agree',
        round,
        ok: true,
        agreed: parsed.data.agreed,
        differences: parsed.data.differences.length,
      });
      return parsed.data;
    }
    const why = describeParseFailure(
      payload,
      parsed.error.issues[0]?.message ?? 'unparseable agreement',
    );
    options.onCallSettled?.({
      provider: options.moderator,
      role: 'moderator',
      kind: 'agree',
      round,
      ok: false,
      error: why,
    });
    options.logger.warn('consensus.agreement.failed', { round, message: why });
  } catch (error) {
    options.logger.warn('consensus.agreement.failed', {
      round,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

/**
 * Every answer, side by side, when the reviewers never came together.
 *
 * ⚠️ Baya prints all of them rather than choosing. Choosing is exactly the
 * power the moderator does not have, and it does not acquire it by running
 * out of rounds — §3.6.
 */
export function sideBySide(proposals: readonly RoundProposal[]): string {
  return proposals
    .map((proposal) => `## ${proposal.provider}\n\n${proposal.document.trim()}\n`)
    .join('\n');
}

/**
 * A producing run: the artifact asks for something, so the reviewers answer it
 * and the moderator only ever reports whether they are on the same page.
 */
export async function runAgreementLoop(
  options: ConsensusOptions,
  criteria: ConsensusCriteria,
  pseudonyms: Record<string, ProviderId>,
): Promise<ConsensusOutcome> {
  const needsWorkspace = criteria.needs_workspace;
  const aliasOf = new Map<ProviderId, string>(
    Object.entries(pseudonyms).map(([alias, provider]) => [provider, alias]),
  );
  const rounds: RoundRecord[] = [];
  let previous: RoundProposal[] = [];
  let differences: string[] = [];
  let document = options.artifact;
  let stopReason: StopReason = 'ceiling';

  for (let round = 1; round <= options.maxRounds; round += 1) {
    options.logger.info('consensus.round.started', {
      round,
      reviewers: options.reviewers.length,
    });

    const lastOf = new Map(previous.map((proposal) => [proposal.provider, proposal]));
    const settled = await Promise.all(
      options.reviewers.map((provider) => {
        const alias = aliasOf.get(provider) ?? provider;
        const mine = lastOf.get(provider);
        const prompt =
          mine === undefined
            ? proposalPrompt({
                artifact: options.artifact,
                needsWorkspace,
                cwd: options.cwd,
                reviewerCount: options.reviewers.length,
                ...(options.schemaFor?.(provider, 'proposal_result') !== undefined
                  ? { schema: options.schemaFor(provider, 'proposal_result') as string }
                  : {}),
              })
            : revisePrompt({
                artifact: options.artifact,
                needsWorkspace,
                cwd: options.cwd,
                reviewerCount: options.reviewers.length,
                round,
                mine: mine.document,
                others: previous
                  .filter((proposal) => proposal.provider !== provider)
                  .map((proposal) => ({
                    alias: proposal.alias,
                    document: proposal.document,
                  })),
                differences,
                ...(options.schemaFor?.(provider, 'proposal_result') !== undefined
                  ? { schema: options.schemaFor(provider, 'proposal_result') as string }
                  : {}),
              });
        return askOne(options, provider, alias, round, needsWorkspace, prompt);
      }),
    );

    const proposals: RoundProposal[] = [];
    const failed: RoundRecord['failed'] = [];
    for (const entry of settled) {
      if (entry.proposal !== undefined) proposals.push(entry.proposal);
      else if (entry.error !== undefined) {
        failed.push({ provider: entry.provider, message: entry.error });
        options.logger.warn('consensus.reviewer.failed', {
          provider: entry.provider,
          round,
          message: entry.error,
        });
      }
    }

    if (proposals.length === 0) {
      rounds.push({ round, critiques: [], proposals, failed, reconcile: null, document });
      stopReason = 'no_reviewers';
      break;
    }

    // One answer agrees with itself. Nothing to compare, nothing to spend.
    const agreement =
      proposals.length === 1
        ? null
        : await askAgreement(options, round, needsWorkspace, proposals);
    const agreed = proposals.length === 1 || agreement?.agreed === true;

    /**
     * ⚠️ Agreed means the answers say the same thing, so any of them is the
     * answer. Baya takes the first in the order the user named their
     * reviewers — predictable, and never the moderator's pick.
     */
    document = agreed ? (proposals[0] as RoundProposal).document : sideBySide(proposals);

    const record: RoundRecord = {
      round,
      critiques: [],
      proposals,
      agreement,
      failed,
      reconcile: null,
      document,
    };
    rounds.push(record);
    options.logger.info('consensus.agreement', {
      round,
      answers: proposals.length,
      agreed,
      differences: agreement?.differences.length ?? 0,
    });
    options.logger.info('consensus.round.completed', {
      round,
      proposals: proposals.length,
      failed: failed.length,
    });
    await options.onRoundSettled?.(record, { criteria });

    if (agreed) {
      stopReason = 'converged';
      break;
    }
    if (agreement === null) {
      stopReason = 'no_reconcile';
      break;
    }
    // Nobody moved and the moderator sees the same split: another round buys
    // the same answers again.
    const sameSplit =
      differences.length > 0 &&
      differences.length === agreement.differences.length &&
      differences.every((item, index) => item === agreement.differences[index]);
    const sameAnswers =
      previous.length === proposals.length &&
      proposals.every(
        (proposal, index) => proposal.document === previous[index]?.document,
      );
    if (sameSplit && sameAnswers) {
      options.logger.info('consensus.stalled', { round, criteria: [] });
      stopReason = 'stalled';
      break;
    }
    previous = proposals;
    differences = agreement.differences;
    if (round === options.maxRounds) stopReason = 'split';
  }

  options.logger.info('consensus.converged', {
    reason: stopReason,
    rounds: rounds.length,
  });

  return {
    criteria,
    needsWorkspace,
    rounds,
    document,
    proposed: true,
    stopReason,
    pseudonyms,
  };
}

/**
 * Pass 0, callable on its own so the CLI can put the criteria and the access
 * posture in front of the user **before** the gate. The posture decides both
 * the blast radius and most of the cost, and it is not known until this runs —
 * a gate shown before it would be asking about a run nobody can see yet.
 */
export async function resolveCriteria(
  options: Pick<
    ConsensusOptions,
    | 'artifact'
    | 'sourcePath'
    | 'moderator'
    | 'runner'
    | 'logger'
    | 'criteria'
    | 'schemaFor'
    | 'onCallSettled'
  >,
): Promise<ConsensusCriteria> {
  if (options.criteria !== undefined) return options.criteria;

  const raw = await options.runner({
    provider: options.moderator,
    role: 'moderator',
    kind: 'criteria',
    round: 0,
    needsWorkspace: false,
    prompt: criteriaPrompt({
      artifact: options.artifact,
      sourcePath: options.sourcePath,
      // Settled here, not by the model: §Question or document.
      ...(looksLikeQuestion(options.artifact) ? { kindHint: 'question' as const } : {}),
      ...(options.schemaFor?.(options.moderator, 'consensus_criteria') !== undefined
        ? { schema: options.schemaFor(options.moderator, 'consensus_criteria') as string }
        : {}),
    }),
  });

  const parsed = ConsensusCriteriaSchema.safeParse(parseDocument(raw));
  if (parsed.success) {
    // The model does not get a vote on this one; see `looksLikeQuestion`.
    const asking = looksLikeQuestion(options.artifact);
    const forced =
      asking && (parsed.data.artifact_kind !== 'question' || !parsed.data.needs_draft)
        ? { ...parsed.data, artifact_kind: 'question' as const, needs_draft: true }
        : parsed.data;
    if (forced !== parsed.data) {
      options.logger.info('consensus.kind.forced', {
        from: parsed.data.artifact_kind,
        to: 'question',
        needs_draft: true,
      });
    }
    options.onCallSettled?.({
      provider: options.moderator,
      role: 'moderator',
      kind: 'criteria',
      round: 0,
      ok: true,
    });
    return forced;
  }
  options.onCallSettled?.({
    provider: options.moderator,
    role: 'moderator',
    kind: 'criteria',
    round: 0,
    ok: false,
    error: 'unreadable, using defaults',
  });

  // ⚠️ A wrong `false` costs the debate its evidence, silently. §7.
  options.logger.warn('consensus.criteria.fallback', {
    reason: parsed.error.issues[0]?.message ?? 'unparseable',
  });
  return {
    baya: '1',
    kind: 'consensus_criteria',
    artifact_kind: 'spec',
    needs_workspace: true,
    needs_draft: false,
    criteria: [
      { id: 'correctness', question: 'What here is wrong, missing, or unworkable?' },
      { id: 'risk', question: 'What fails first under real conditions?' },
    ],
  };
}

export async function runConsensus(options: ConsensusOptions): Promise<ConsensusOutcome> {
  const pseudonyms = assignPseudonyms(options.reviewers);
  const aliasOf = new Map<ProviderId, string>(
    Object.entries(pseudonyms).map(([alias, provider]) => [provider, alias]),
  );

  const criteria = await resolveCriteria(options);
  const needsWorkspace = criteria.needs_workspace;
  options.logger.info('consensus.criteria', {
    artifact_kind: criteria.artifact_kind,
    needs_workspace: needsWorkspace,
    criteria: criteria.criteria.length,
  });
  options.logger.info('consensus.posture', {
    posture: needsWorkspace ? 'workspace' : 'tool-less',
  });

  const rounds: RoundRecord[] = [];
  let document = options.artifact;
  let stopReason: StopReason = 'ceiling';

  /**
   * Round 1 answers rather than critiques when the artifact only asks for
   * something. The request then leaves the document, so every later prompt
   * carries it separately.
   */
  /**
   * Two different jobs, and only one of them is a review. When the artifact
   * asks for something, the reviewers produce it and the moderator only ever
   * reports whether they agree — §3.6.
   */
  if (criteria.needs_draft) {
    return runAgreementLoop(options, criteria, pseudonyms);
  }
  const ask = null;

  for (let round = 1; round <= options.maxRounds; round += 1) {
    options.logger.info('consensus.round.started', {
      round,
      reviewers: options.reviewers.length,
    });

    const settled = await Promise.all(
      options.reviewers.map(async (provider) => {
        try {
          const raw = await options.runner({
            provider,
            role: 'reviewer',
            kind: 'review',
            round,
            needsWorkspace,
            prompt: reviewPrompt({
              artifact: document,
              ask,
              criteria,
              round,
              ledger: options.ledgerFor?.(provider, round) ?? '',
              needsWorkspace,
              cwd: options.cwd,
              reviewerCount: options.reviewers.length,
              ...(options.schemaFor?.(provider, 'critique_result') !== undefined
                ? { schema: options.schemaFor(provider, 'critique_result') as string }
                : {}),
            }),
          });
          const payload = parseDocument(raw);
          const parsed = CritiqueResultSchema.safeParse(payload);
          if (!parsed.success) {
            const why = describeParseFailure(
              payload,
              parsed.error.issues[0]?.message ?? 'unparseable critique',
            );
            options.onCallSettled?.({
              provider,
              role: 'reviewer',
              kind: 'review',
              round,
              ok: false,
              error: why,
            });
            return { provider, error: why };
          }
          options.onCallSettled?.({
            provider,
            role: 'reviewer',
            kind: 'review',
            round,
            ok: true,
            findings: parsed.data.findings.length,
            blocking: parsed.data.findings.filter((finding) =>
              BLOCKING_SEVERITIES.includes(finding.severity),
            ).length,
          });
          return {
            provider,
            critique: {
              provider,
              alias: aliasOf.get(provider) ?? provider,
              result: {
                ...parsed.data,
                findings: namespaceFindings(provider, parsed.data.findings),
              },
            } satisfies RoundCritique,
          };
        } catch (error) {
          return {
            provider,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const critiques: RoundCritique[] = [];
    const failed: RoundRecord['failed'] = [];
    for (const entry of settled) {
      if ('critique' in entry && entry.critique !== undefined) {
        critiques.push(entry.critique);
      } else if ('error' in entry) {
        failed.push({ provider: entry.provider, message: entry.error });
        options.logger.warn('consensus.reviewer.failed', {
          provider: entry.provider,
          round,
          message: entry.error,
        });
      }
    }

    // Never spend a reconcile call on nothing. The last good draft stands.
    if (critiques.length === 0) {
      rounds.push({ round, critiques, failed, reconcile: null, document });
      stopReason = 'no_reviewers';
      break;
    }

    /**
     * Nobody raised anything, so there is nothing to apply and the document
     * cannot change. Reconciling would spend the run's most expensive seat to
     * be told so: measured 2026-09-06, a final round returned zero findings
     * from all three reviewers and the reconcile came back with zero changes
     * and a byte-identical document.
     */
    if (critiques.every((critique) => critique.result.findings.length === 0)) {
      const record: RoundRecord = {
        round,
        critiques,
        failed,
        reconcile: null,
        document,
      };
      rounds.push(record);
      options.logger.info('consensus.round.completed', {
        round,
        critiques: critiques.length,
        failed: failed.length,
        reconcile_skipped: true,
      });
      await options.onRoundSettled?.(record, { criteria });
      stopReason = 'converged';
      break;
    }

    let reconcile: ReconcileResult | null = null;
    try {
      const raw = await options.runner({
        provider: options.moderator,
        role: 'moderator',
        kind: 'reconcile',
        round,
        needsWorkspace,
        prompt: reconcilePrompt({
          artifact: document,
          ask,
          criteria,
          round,
          critiques: critiques.map((entry) => ({
            provider: entry.provider,
            position: entry.result.position,
            findings: entry.result.findings,
          })),
          ledger: options.ledgerFor?.(options.moderator, round) ?? '',
          needsWorkspace,
          cwd: options.cwd,
          ...(options.schemaFor?.(options.moderator, 'reconcile_result') !== undefined
            ? {
                schema: options.schemaFor(
                  options.moderator,
                  'reconcile_result',
                ) as string,
              }
            : {}),
        }),
      });
      const payload = parseDocument(raw);
      const parsed = ReconcileResultSchema.safeParse(payload);
      if (parsed.success) {
        reconcile = parsed.data;
        options.onCallSettled?.({
          provider: options.moderator,
          role: 'moderator',
          kind: 'reconcile',
          round,
          ok: true,
          changes: parsed.data.changes.length,
        });
      } else {
        const why = describeParseFailure(
          payload,
          parsed.error.issues[0]?.message ?? 'unparseable',
        );
        options.onCallSettled?.({
          provider: options.moderator,
          role: 'moderator',
          kind: 'reconcile',
          round,
          ok: false,
          error: why,
        });
        options.logger.warn('consensus.reconcile.failed', { round, message: why });
      }
    } catch (error) {
      options.logger.warn('consensus.reconcile.failed', {
        round,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    /**
     * ⚠️ Dropped before Baya applies them, not merely flagged. The criteria
     * never reach a reviewer, so a finding cannot be checked against them —
     * what can be is the moderator's own declaration of which criterion each
     * decision served. Measured 2026-09-06: a reviewer's global instructions
     * file supplied a finding, the moderator accepted it, and the answer grew
     * a section nobody asked for.
     */
    const stray = offCriteria(criteria, reconcile);
    if (stray.length > 0) {
      options.logger.warn('consensus.offcriteria', {
        round,
        count: stray.length,
        changes: stray.map((change) => ({
          criterion_id: change.criterion_id,
          rationale: change.rationale,
        })),
      });
    }
    reconcile = reconcile === null ? null : onCriteria(criteria, reconcile);

    if (reconcile !== null) {
      const unsourced = unsourcedChanges(reconcile);
      if (unsourced.length > 0) {
        options.logger.warn('consensus.moderator.unsourced', {
          round,
          count: unsourced.length,
          rationales: unsourced.map((change) => change.rationale),
        });
      }
      document = reconcile.document;
      options.logger.info('consensus.reconciled', {
        round,
        accepted: reconcile.changes.filter((c) => c.action === 'accepted').length,
        rejected: reconcile.changes.filter((c) => c.action === 'rejected').length,
        deferred: reconcile.changes.filter((c) => c.action === 'deferred').length,
        unresolved: reconcile.unresolved.length,
        converged_claim: reconcile.converged,
      });
    }

    const record: RoundRecord = {
      round,
      critiques,
      failed,
      reconcile,
      document,
      unsourced: unsourcedChanges(reconcile),
      dropped: stray,
    };
    rounds.push(record);
    options.logger.info('consensus.round.completed', {
      round,
      critiques: critiques.length,
      failed: failed.length,
    });
    await options.onRoundSettled?.(record, { criteria });

    // A round whose moderator produced nothing cannot be built on.
    if (reconcile === null) {
      stopReason = 'no_reconcile';
      break;
    }
    if (!hasBlockingFindings(critiques)) {
      stopReason = 'converged';
      break;
    }
    // Reconciled first, so this round's findings still land in the document.
    const stalled = stalledCriteria(
      rounds[rounds.length - 2],
      reconcile,
      hasBlockingFindings(critiques),
    );
    if (stalled.length > 0) {
      options.logger.info('consensus.stalled', { round, criteria: stalled });
      stopReason = 'stalled';
      break;
    }
  }

  options.logger.info('consensus.converged', {
    reason: stopReason,
    rounds: rounds.length,
  });

  return {
    criteria,
    needsWorkspace,
    rounds,
    document,
    proposed: false,
    stopReason,
    pseudonyms,
  };
}
