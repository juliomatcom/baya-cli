import type {
  Change,
  Finding,
  FindingSeverity,
  ProviderId,
  ReconcileResult,
} from '../manifest/index.js';
import type { AgreementResult } from '../manifest/index.js';
import type { RoundCritique, RoundProposal } from './engine.js';

/**
 * A reviewer's own record of the debate (specs/002-ai-consensus §3.1).
 *
 * Baya writes it; the model never does. Every line is derived from a document
 * the provider already produced, which is what keeps it inside
 * `execution.md` §Memory's rule — nothing here is self-reported into existence.
 *
 * ⚠️ Rival findings are anonymized (§3.2). Real provider ids stay in the JSON
 * records and the report; only the models are kept from seeing them.
 */

export interface LedgerSection {
  round: number;
  /** Rendered Markdown, appended verbatim to `ledger.md`. */
  text: string;
  /** Every finding id the section mentions — the set compaction must preserve. */
  ids: string[];
}

export interface BuildSectionOptions {
  provider: ProviderId;
  round: number;
  critiques: readonly RoundCritique[];
  reconcile: ReconcileResult | null;
  /** Alias per provider, stable for the run. */
  aliasOf: (provider: ProviderId) => string;
}

function verdictsFor(
  ids: ReadonlySet<string>,
  changes: readonly Change[],
): { change: Change; mine: string[] }[] {
  const out: { change: Change; mine: string[] }[] = [];
  for (const change of changes) {
    const mine = change.finding_ids.filter((id) => ids.has(id));
    if (mine.length > 0) out.push({ change, mine });
  }
  return out;
}

function severityRank(severity: FindingSeverity): number {
  return ['blocker', 'major', 'minor', 'nit'].indexOf(severity);
}

function renderFinding(finding: Finding): string {
  const location = finding.location === null ? '' : ` (${finding.location})`;
  return `- \`${finding.id}\` **${finding.severity}** ${finding.claim}${location}`;
}

/**
 * A producing round: the reviewer answered rather than critiqued, so the
 * critique shape has nothing to say about it.
 *
 * ⚠️ Written because it was not. Measured 2026-09-06: a producing run left
 * every reviewer a ledger reading "you did not complete this round — your
 * call failed" while all three had answered, and dropped the `notes` saying
 * why each held or moved.
 */
export function buildAnswerSection(options: {
  provider: ProviderId;
  round: number;
  proposals: readonly RoundProposal[];
  agreement: AgreementResult | null;
}): LedgerSection {
  const mine = options.proposals.find((entry) => entry.provider === options.provider);
  const lines: string[] = [`## Round ${String(options.round)}`, ''];

  if (mine === undefined) {
    lines.push('You did not answer this round — your call failed.', '');
  } else {
    lines.push(`You answered. See \`round-${String(options.round)}.answer.md\`.`, '');
    if (mine.notes.length > 0) {
      lines.push('### Why you said it', '');
      for (const note of mine.notes) lines.push(`- ${note}`);
      lines.push('');
    }
  }

  if (options.agreement === null) {
    lines.push('Nobody compared the answers this round.', '');
  } else if (options.agreement.agreed) {
    lines.push('Everyone was saying the same thing. The run ended here.', '');
  } else {
    lines.push('### Not yet agreed', '');
    if (options.agreement.differences.length === 0) {
      lines.push('No differences were named.', '');
    } else {
      for (const item of options.agreement.differences) lines.push(`- ${item}`);
      lines.push('');
    }
  }

  return { round: options.round, text: lines.join('\n'), ids: [] };
}

/** The section appended to one reviewer's ledger after a round settles. */
export function buildReviewerSection(options: BuildSectionOptions): LedgerSection {
  const mine = options.critiques.find((entry) => entry.provider === options.provider);
  const lines: string[] = [`## Round ${String(options.round)}`, ''];
  const ids: string[] = [];

  if (mine === undefined) {
    lines.push(
      'You did not complete this round — your call failed. The draft moved on',
      'without your input. What follows is where it stands now.',
      '',
    );
  } else {
    if (mine.result.position.trim() !== '') {
      lines.push('### Your position', '', mine.result.position.trim(), '');
    }
    lines.push('### What you raised', '');
    if (mine.result.findings.length === 0) {
      lines.push('Nothing.', '');
    } else {
      const sorted = [...mine.result.findings].sort(
        (a, b) => severityRank(a.severity) - severityRank(b.severity),
      );
      for (const finding of sorted) {
        lines.push(renderFinding(finding));
        ids.push(finding.id);
      }
      lines.push('');
    }
  }

  const own = new Set(ids);
  const changes = options.reconcile?.changes ?? [];

  if (own.size > 0) {
    const verdicts = verdictsFor(own, changes);
    lines.push('### What the moderator decided', '');
    if (verdicts.length === 0) {
      lines.push('Your findings drew no explicit decision this round.', '');
    } else {
      for (const { change, mine: matched } of verdicts) {
        const others = change.finding_ids.filter((id) => !own.has(id)).length;
        const shared =
          others > 0
            ? ` — merged with ${String(others)} finding${others === 1 ? '' : 's'} from other reviewers`
            : '';
        lines.push(
          `- ${matched.map((id) => `\`${id}\``).join(', ')} → **${change.action}**${shared}`,
          `  ${change.rationale}`,
        );
      }
      lines.push('');
    }
  }

  // ⚠️ Anonymized: aliases, never provider ids. §3.2.
  const rivals = options.critiques.filter((entry) => entry.provider !== options.provider);
  if (rivals.length > 0) {
    lines.push('### What others argued', '');
    for (const rival of rivals) {
      const alias = options.aliasOf(rival.provider);
      if (rival.result.findings.length === 0) {
        lines.push(`- ${alias} raised nothing.`);
        continue;
      }
      for (const finding of rival.result.findings) {
        lines.push(`- ${alias}: **${finding.severity}** ${finding.claim}`);
      }
    }
    lines.push('');
  }

  if (options.reconcile !== null && options.reconcile.unresolved.length > 0) {
    lines.push('### Still unresolved', '');
    for (const item of options.reconcile.unresolved) {
      lines.push(`- ${item.claim}`);
    }
    lines.push('');
  }

  return { round: options.round, text: lines.join('\n'), ids };
}

/** The moderator's own record, so round 2 cannot silently reverse round 1. */
export function buildModeratorSection(
  round: number,
  reconcile: ReconcileResult | null,
  agreement?: AgreementResult | null,
): LedgerSection {
  const lines: string[] = [`## Round ${String(round)}`, ''];
  const ids: string[] = [];

  // A producing round: the moderator decided nothing, it only compared.
  if (agreement != null) {
    lines.push(
      agreement.agreed
        ? 'The answers were saying the same thing.'
        : 'The answers were not yet saying the same thing.',
      '',
    );
    if (agreement.differences.length > 0) {
      for (const item of agreement.differences) lines.push(`- ${item}`);
      lines.push('');
    }
    return { round, text: lines.join('\n'), ids };
  }

  if (reconcile === null) {
    lines.push('This round produced no reconciled document.', '');
    return { round, text: lines.join('\n'), ids };
  }

  for (const change of reconcile.changes) {
    lines.push(
      `- **${change.action}** ${change.finding_ids.map((id) => `\`${id}\``).join(', ')}`,
      `  ${change.rationale}`,
    );
    ids.push(...change.finding_ids);
  }
  if (reconcile.changes.length === 0) lines.push('No decisions recorded.');
  lines.push('');

  if (reconcile.unresolved.length > 0) {
    lines.push('### Left unresolved', '');
    for (const item of reconcile.unresolved) lines.push(`- ${item.claim}`);
    lines.push('');
  }

  return { round, text: lines.join('\n'), ids };
}

/**
 * Tier-1 compaction (§3.2): field selection, not summarization. Free, and it
 * cannot lose a position because it only ever drops detail lines.
 *
 * Keeps the most recent round whole — that is the one being argued about — and
 * reduces every earlier round to its claim and verdict lines.
 */
export function projectLedger(ledger: string): string {
  const sections = splitRounds(ledger);
  if (sections.length <= 1) return ledger;

  const last = sections[sections.length - 1] as string;
  const earlier = sections.slice(0, -1).map((section) => {
    const kept = section
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('## ') ||
          line.startsWith('- ') ||
          line.startsWith('### What the moderator decided'),
      );
    return kept.join('\n');
  });
  return [...earlier, last].join('\n\n').trimEnd();
}

/** Splits on `## Round n` headings, keeping each heading with its body. */
export function splitRounds(ledger: string): string[] {
  const parts = ledger.split(/\n(?=## Round )/g).filter((part) => part.trim() !== '');
  return parts;
}

/** Every finding id a ledger mentions. Compaction must preserve this set. */
export function findingIdsIn(ledger: string): string[] {
  const ids = new Set<string>();
  for (const match of ledger.matchAll(/`([a-z]+:[A-Za-z0-9_-]+)`/g)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort();
}
