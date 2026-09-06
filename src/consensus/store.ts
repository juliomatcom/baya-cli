import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderId } from '../manifest/index.js';
import type { RoundRecord } from './engine.js';
import {
  buildAnswerSection,
  buildModeratorSection,
  buildReviewerSection,
  findingIdsIn,
  projectLedger,
} from './ledger.js';
import type { ConsensusPaths } from './paths.js';

/**
 * Writes a round to disk as it settles (specs/002-ai-consensus §5.5, §8).
 *
 * ⚠️ Raw records are immutable for the life of the run. `ledger.md` is
 * append-only; compaction never rewrites it, it writes `digest-<n>.md`
 * alongside and the prompt reads that instead.
 */

export const DEFAULT_LEDGER_BUDGET = 8000;

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function append(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, contents, 'utf8');
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export interface PersistRoundOptions {
  paths: ConsensusPaths;
  record: RoundRecord;
  reviewers: readonly ProviderId[];
  moderator: ProviderId;
  aliasOf: (provider: ProviderId) => string;
}

/** Persist one settled round: raw critiques, the reconcile, and every ledger. */
export function persistRound(options: PersistRoundOptions): void {
  const { paths, record } = options;

  for (const critique of record.critiques) {
    write(
      paths.critique(critique.provider, record.round),
      `${JSON.stringify(critique.result, null, 2)}\n`,
    );
  }

  // ⚠️ Kept verbatim, per round. The whole point of a producing run is what
  // each model actually said; a merged or chosen document is no substitute.
  for (const proposal of record.proposals ?? []) {
    write(paths.proposal(proposal.provider, record.round), proposal.document);
  }

  if (record.agreement != null) {
    write(
      paths.agreement(record.round),
      `${JSON.stringify(record.agreement, null, 2)}\n`,
    );
  }

  if (record.reconcile !== null) {
    write(
      paths.reconcile(record.round),
      `${JSON.stringify(record.reconcile, null, 2)}\n`,
    );
  }

  // A producing round has no critiques and no reconcile; the critique shape
  // would tell every reviewer its call failed.
  const answering = record.proposals !== undefined;
  for (const provider of options.reviewers) {
    const section = answering
      ? buildAnswerSection({
          provider,
          round: record.round,
          proposals: record.proposals ?? [],
          agreement: record.agreement ?? null,
        })
      : buildReviewerSection({
          provider,
          round: record.round,
          critiques: record.critiques,
          reconcile: record.reconcile,
          aliasOf: options.aliasOf,
        });
    append(paths.ledger(provider), `${section.text}\n`);
  }

  const moderator = buildModeratorSection(
    record.round,
    record.reconcile,
    record.agreement ?? null,
  );
  append(paths.moderatorLedger, `${moderator.text}\n`);
}

export interface CompactionResult {
  /** What the next prompt should carry. */
  text: string;
  tier: 'none' | 'projection' | 'moderator';
  charsRaw: number;
  charsSent: number;
}

/**
 * Bring one ledger inside budget (§3.2). Tier 1 is field projection, free and
 * lossless on positions. Tier 2 asks the moderator, and is **verified**: every
 * finding id present before must be present after, or the answer is discarded.
 */
export async function compactLedger(options: {
  ledger: string;
  budget: number;
  compact?: (ledger: string, ids: readonly string[]) => Promise<string>;
}): Promise<CompactionResult> {
  const charsRaw = options.ledger.length;
  if (charsRaw <= options.budget) {
    return { text: options.ledger, tier: 'none', charsRaw, charsSent: charsRaw };
  }

  const projected = projectLedger(options.ledger);
  if (projected.length <= options.budget || options.compact === undefined) {
    return {
      text: projected,
      tier: 'projection',
      charsRaw,
      charsSent: projected.length,
    };
  }

  const ids = findingIdsIn(projected);
  const shortened = await options.compact(projected, ids);
  const kept = new Set(findingIdsIn(shortened));
  const lost = ids.filter((id) => !kept.has(id));
  if (lost.length > 0 || shortened.trim() === '') {
    // A model may shorten an argument; it may not lose a position.
    return {
      text: projected,
      tier: 'projection',
      charsRaw,
      charsSent: projected.length,
    };
  }
  return {
    text: shortened,
    tier: 'moderator',
    charsRaw,
    charsSent: shortened.length,
  };
}

/** The ledger a reviewer's next prompt should carry, digest first. */
export function ledgerFor(
  paths: ConsensusPaths,
  provider: ProviderId,
  round: number,
): string {
  for (let earlier = round - 1; earlier >= 1; earlier -= 1) {
    const digest = readIfPresent(paths.digest(provider, earlier));
    if (digest.trim() !== '') return digest;
  }
  return readIfPresent(paths.ledger(provider));
}

export { readIfPresent, write as writeFile, append as appendFile };
