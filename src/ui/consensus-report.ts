import type { ProviderId } from '../manifest/index.js';
import type { ProviderUsage } from '../providers/index.js';
import type { Change, Finding } from '../manifest/index.js';
import type {
  ConsensusOutcome,
  RoundProposal,
  RoundRecord,
} from '../consensus/engine.js';
import { findingIndex } from '../consensus/engine.js';
import { agreementOf } from '../consensus/prompt.js';
import type { ConsensusPaths } from '../consensus/paths.js';
import { DEFAULT_WIDTH, firstLine, formatCost, formatTokens, wrap } from './text.js';
import type { Theme } from './theme.js';

/**
 * What a debate cost and what it settled (specs/002-ai-consensus §10).
 *
 * `changes[]` is the diff: it says what moved and why, which is strictly more
 * than a textual diff would. Rejected findings and open disagreements are
 * printed, not dropped — the disagreement is often the most useful output.
 */
export interface ConsensusReportOptions {
  theme: Theme;
  outcome: ConsensusOutcome;
  usage: readonly { provider: ProviderId; usage: ProviderUsage }[];
  paths: ConsensusPaths;
  noDiff?: boolean;
  width?: number;
}

const ACTION_STATUS: Record<string, 'ok' | 'skip' | 'warn'> = {
  accepted: 'ok',
  rejected: 'skip',
  deferred: 'warn',
};

const ACTION_WORD: Record<string, string> = {
  accepted: 'applied',
  rejected: 'declined',
  deferred: 'deferred',
};

const STOP_REASON: Record<string, string> = {
  converged: 'converged — nothing blocking left',
  split: 'no agreement — every answer is printed, none is chosen',
  stalled: 'stalled — the same criteria blocked twice with nothing new raised',
  ceiling: 'hit the round ceiling with findings still open',
  no_reviewers: 'every reviewer failed; the last good draft stands',
  no_reconcile: 'the moderator produced no document',
};

const LABEL = 10;

/** Indented, wrapped, with the first row carrying the label. */
function labelled(label: string, body: string, width: number, indent = 4): string[] {
  const rows = wrap(body, width - indent - LABEL);
  const pad = ' '.repeat(indent);
  return rows.map(
    (row, index) =>
      `${pad}${index === 0 ? label.padEnd(LABEL) : ' '.repeat(LABEL)}${row}`,
  );
}

/** The moderator's reasoning, arrowed on the first row and hung under it. */
function reason(arrow: string, text: string, width: number): string[] {
  return wrap(text, width - 10).map(
    (row, index) => `        ${index === 0 ? arrow : ' '} ${row}`,
  );
}

/**
 * What each reviewer actually argued, in its own words. `position` is the one
 * place a reviewer states a view rather than a defect, and it was on disk and
 * nowhere else — the report said what changed but never why anyone thought so.
 */
function renderPositions(
  options: ConsensusReportOptions,
  last: RoundRecord | undefined,
  width: number,
): string[] {
  const { theme } = options;
  const stated = (last?.critiques ?? []).filter(
    (critique) => critique.result.position.trim() !== '',
  );
  if (stated.length === 0) return [];
  const lines = [`  ${theme.note('positions')}`, ''];
  for (const critique of stated) {
    lines.push(
      ...labelled(theme.provider(critique.provider), critique.result.position, width),
    );
  }
  lines.push('');
  return lines;
}

/**
 * A producing run: who answered what, and whether the moderator found them
 * saying the same thing.
 *
 * ⚠️ No answer is ranked or marked best. The moderator never had that power
 * and the report does not hand it one — consensus.md §The moderator only asks.
 */
function renderAnswers(
  options: ConsensusReportOptions,
  last: RoundRecord | undefined,
  width: number,
): string[] {
  const { theme, outcome } = options;
  const proposals = last?.proposals ?? [];
  if (proposals.length === 0) return [];

  const agreed = outcome.stopReason === 'converged';
  const lines = [
    `  ${agreed ? theme.ok('same page') : theme.warn('not the same page')}`,
    '',
  ];

  for (const proposal of proposals) {
    lines.push(
      ...labelled(theme.provider(proposal.provider), firstLine(proposal.document), width),
    );
  }
  lines.push('');

  const differences = last?.agreement?.differences ?? [];
  if (differences.length > 0) {
    lines.push(`  ${theme.warn('they differ on')}`, '');
    for (const item of differences) {
      lines.push(`    ${theme.status('warn')} ${wrap(item, width - 6).join('\n      ')}`);
    }
    lines.push('');
  }

  lines.push(
    agreed
      ? `  ${theme.note('printed')}   the answer they agreed on, in ${theme.provider(
          (proposals[0] as RoundProposal).provider,
        )}'s words`
      : `  ${theme.note('printed')}   every answer, side by side — none is chosen`,
    '',
  );
  return lines;
}

/**
 * Every decision, with the finding behind it. A rationale alone says what the
 * moderator did; the claim beside it says what it was answering, which is the
 * half that explains why one argument beat another.
 */
function renderDecisions(options: ConsensusReportOptions, width: number): string[] {
  const { theme, outcome } = options;
  const index = findingIndex(outcome.rounds);
  const multi = outcome.rounds.length > 1;
  const lines: string[] = [];

  const claimsOf = (change: Change): Finding[] =>
    change.finding_ids
      .map((id) => index.get(id))
      .filter((finding): finding is Finding => finding !== undefined);

  for (const round of outcome.rounds) {
    const changes = round.reconcile?.changes ?? [];
    const unresolved = round.reconcile?.unresolved ?? [];
    if (changes.length === 0 && unresolved.length === 0) continue;

    lines.push(
      multi
        ? `  ${theme.note('decisions')} ${theme.note(`round ${String(round.round)}`)}`
        : `  ${theme.note('decisions')}`,
      '',
    );

    for (const change of changes) {
      const findings = claimsOf(change);
      const providers = agreementOf(change);
      // The agreement count falls out of the protocol; nothing clusters.
      const agreed =
        providers.length > 1 ? theme.note(` · ${String(providers.length)} agreed`) : '';
      const who = providers.length > 0 ? providers.join(', ') : 'the moderator';
      lines.push(
        `    ${theme.status(ACTION_STATUS[change.action] ?? 'warn')} ${theme.note(
          ACTION_WORD[change.action] ?? change.action,
        )} ${who}${agreed}`,
      );
      const claim = findings[0]?.claim;
      if (claim !== undefined) {
        for (const row of wrap(claim, width - 8)) lines.push(`        ${row}`);
      }
      lines.push(...reason(theme.note('→'), change.rationale, width));
      lines.push('');
    }

    for (const item of unresolved) {
      const who = item.providers.length > 0 ? ` (${item.providers.join(', ')})` : '';
      lines.push(`    ${theme.status('warn')} ${theme.warn('unsettled')}${who}`);
      for (const row of wrap(item.claim, width - 8)) lines.push(`        ${row}`);
      if (item.rationale.trim() !== '') {
        lines.push(...reason(theme.note('→'), item.rationale, width));
      }
      lines.push('');
    }
  }
  return lines;
}

export function renderConsensusReport(options: ConsensusReportOptions): string {
  const { theme, outcome } = options;
  const lines: string[] = [
    '',
    `  ${theme.note('consensus')} · ${outcome.criteria.artifact_kind} · ${String(outcome.rounds.length)} round${outcome.rounds.length === 1 ? '' : 's'}`,
  ];
  lines.push(
    `  ${theme.note(STOP_REASON[outcome.stopReason] ?? outcome.stopReason)}`,
    '',
  );

  const width = options.width ?? DEFAULT_WIDTH;
  const last = outcome.rounds[outcome.rounds.length - 1];

  if (options.noDiff !== true) {
    if (outcome.proposed) {
      lines.push(...renderAnswers(options, last, width));
    } else {
      lines.push(...renderPositions(options, last, width));
      lines.push(...renderDecisions(options, width));
    }
  }

  /**
   * ⚠️ Accepted by the moderator, discarded by Baya. Printed rather than
   * silently dropped: the usual cause is a reviewer's own environment, but it
   * can also be the moderator naming a criterion that should have existed.
   */
  const dropped = outcome.rounds.flatMap((round) => round.dropped ?? []);
  if (options.noDiff !== true && dropped.length > 0) {
    lines.push(`  ${theme.warn('discarded')}`, '');
    for (const change of dropped) {
      const named = change.criterion_id === '' ? 'no criterion' : change.criterion_id;
      lines.push(`    ${theme.status('skip')} ${theme.note(named)}`);
      for (const row of wrap(change.rationale, width - 8)) lines.push(`        ${row}`);
    }
    lines.push(
      `        ${theme.note('serves no criterion of this run — see consensus.md')}`,
      '',
    );
  }

  // ⚠️ The moderator has no voice of its own (consensus.md §The moderator).
  // An edit citing no finding is it speaking anyway, and it is named here.
  const unsourced = outcome.rounds.flatMap((round) => round.unsourced ?? []);
  if (unsourced.length > 0) {
    lines.push(`  ${theme.warn('moderator edits nobody asked for')}`, '');
    for (const change of unsourced) {
      lines.push(`    ${theme.status('warn')} ${change.rationale}`);
    }
    lines.push('');
  }

  const failed = outcome.rounds.flatMap((round) => round.failed);
  if (failed.length > 0) {
    lines.push(`  ${theme.fail('reviewers that failed')}`, '');
    for (const entry of failed) {
      lines.push(
        `    ${theme.status('fail')} ${theme.provider(entry.provider)} ${entry.message}`,
      );
    }
    lines.push('');
  }

  // Pass 0 and every compaction call are counted like any other. §11.
  const totals = new Map<ProviderId, ProviderUsage>();
  for (const entry of options.usage) {
    const current = totals.get(entry.provider) ?? {};
    totals.set(entry.provider, {
      cost_usd: (current.cost_usd ?? 0) + (entry.usage.cost_usd ?? 0),
      input_tokens: (current.input_tokens ?? 0) + (entry.usage.input_tokens ?? 0),
      output_tokens: (current.output_tokens ?? 0) + (entry.usage.output_tokens ?? 0),
    });
  }
  if (totals.size > 0) {
    lines.push(`  ${theme.note('spend')}`, '');
    let cost = 0;
    let tokens = 0;
    for (const [provider, usage] of totals) {
      cost += usage.cost_usd ?? 0;
      tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      const each = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      lines.push(
        `    ${theme.provider(provider.padEnd(9))} ${formatTokens(each)}${usage.cost_usd ? ` · ${formatCost(usage.cost_usd)}` : ''}`,
      );
    }
    lines.push(
      '',
      `    ${theme.note('total'.padEnd(9))} ${formatTokens(tokens)}${cost > 0 ? ` · ${formatCost(cost)}` : ''}`,
      '',
    );
  }

  lines.push(`  ${theme.note('record')}   ${theme.path(options.paths.runDir)}`, '');
  return lines.join('\n');
}
