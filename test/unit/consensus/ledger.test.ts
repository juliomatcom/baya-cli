import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAnswerSection,
  buildModeratorSection,
  buildReviewerSection,
  findingIdsIn,
  projectLedger,
} from '../../../src/consensus/ledger.js';
import { consensusPaths } from '../../../src/consensus/paths.js';
import {
  compactLedger,
  ledgerFor,
  persistRound,
  writeFile,
} from '../../../src/consensus/store.js';
import type { RoundCritique } from '../../../src/consensus/engine.js';
import type { ProviderId, ReconcileResult } from '../../../src/manifest/index.js';

function critique(provider: ProviderId, alias: string, ids: string[]): RoundCritique {
  return {
    provider,
    alias,
    result: {
      baya: '1',
      kind: 'critique_result',
      round: 1,
      position: `${provider} thinks it is close`,
      findings: ids.map((id) => ({
        id: `${provider}:${id}`,
        severity: 'major' as const,
        claim: `claim ${id}`,
        evidence: 'e',
        suggestion: '',
        location: null,
      })),
      notes: [],
    },
  };
}

const reconcile: ReconcileResult = {
  baya: '1',
  kind: 'reconcile_result',
  round: 1,
  document: '# V2',
  changes: [
    {
      finding_ids: ['claude:f1', 'codex:f1'],
      criterion_id: 'c1',
      action: 'accepted',
      rationale: 'Both saw the same gap.',
    },
    {
      finding_ids: ['claude:f2'],
      criterion_id: 'c1',
      action: 'rejected',
      rationale: 'Out of scope.',
    },
  ],
  unresolved: [{ claim: 'naming', providers: ['codex'], rationale: 'taste' }],
  converged: false,
};

const critiques = [
  critique('claude', 'Reviewer A', ['f1', 'f2']),
  critique('codex', 'Reviewer B', ['f1']),
];
const aliasOf = (p: ProviderId): string => (p === 'claude' ? 'Reviewer A' : 'Reviewer B');

describe('buildReviewerSection', () => {
  const section = buildReviewerSection({
    provider: 'claude',
    round: 1,
    critiques,
    reconcile,
    aliasOf,
  });

  it("records the reviewer's own findings and verdicts with rationale", () => {
    expect(section.text).toContain('claude:f1');
    expect(section.text).toContain('**accepted**');
    expect(section.text).toContain('Both saw the same gap.');
    expect(section.text).toContain('Out of scope.');
  });

  it('reports how many others were merged in, without naming them', () => {
    expect(section.text).toContain('merged with 1 finding from other reviewers');
  });

  it('shows rivals only under their alias — never a provider id', () => {
    expect(section.text).toContain('Reviewer B');
    expect(section.text).not.toContain('codex:');
    expect(section.text).not.toMatch(/\bcodex\b/);
  });

  it('carries the unresolved disagreements forward', () => {
    expect(section.text).toContain('Still unresolved');
  });

  it('collects the ids compaction must preserve', () => {
    expect(section.ids).toEqual(['claude:f1', 'claude:f2']);
  });

  it('tells a reviewer that missed a round it missed it', () => {
    const missed = buildReviewerSection({
      provider: 'copilot',
      round: 2,
      critiques,
      reconcile,
      aliasOf,
    });
    expect(missed.text).toContain('did not complete this round');
    expect(missed.ids).toEqual([]);
  });
});

describe('buildModeratorSection', () => {
  it('records every decision it made', () => {
    const section = buildModeratorSection(1, reconcile);
    expect(section.text).toContain('**accepted**');
    expect(section.text).toContain('**rejected**');
    expect(section.ids).toContain('claude:f2');
  });

  it('says so when a round produced nothing', () => {
    expect(buildModeratorSection(2, null).text).toContain('no reconciled document');
  });
});

describe('projectLedger', () => {
  const ledger = [
    '## Round 1',
    '',
    '### Your position',
    '',
    'a long stance that should be dropped from an old round',
    '',
    '- `claude:f1` **major** claim f1',
    '',
    '## Round 2',
    '',
    '### Your position',
    '',
    'the current stance, kept whole',
    '',
    '- `claude:f9` **major** claim f9',
  ].join('\n');

  it('keeps the most recent round whole', () => {
    expect(projectLedger(ledger)).toContain('the current stance, kept whole');
  });

  it('drops prose from superseded rounds but never their findings', () => {
    const out = projectLedger(ledger);
    expect(out).not.toContain('should be dropped');
    expect(out).toContain('claude:f1');
  });

  it('leaves a single-round ledger untouched', () => {
    expect(projectLedger('## Round 1\n\nonly')).toBe('## Round 1\n\nonly');
  });
});

describe('findingIdsIn', () => {
  it('finds namespaced ids and ignores other backticked text', () => {
    expect(findingIdsIn('`claude:f1` and `codex:f2` and `plain`')).toEqual([
      'claude:f1',
      'codex:f2',
    ]);
  });
});

describe('compactLedger', () => {
  const long = `## Round 1\n\nprose\n\n- \`claude:f1\` **major** a\n\n## Round 2\n\n${'x'.repeat(200)}\n\n- \`claude:f2\` **major** b`;

  it('does nothing when the ledger is inside budget', async () => {
    const out = await compactLedger({ ledger: long, budget: 10_000 });
    expect(out.tier).toBe('none');
    expect(out.text).toBe(long);
  });

  it('projects first, without a model call', async () => {
    const out = await compactLedger({ ledger: long, budget: 250 });
    expect(out.tier).toBe('projection');
    expect(out.charsSent).toBeLessThan(out.charsRaw);
  });

  it('accepts a moderator compaction that preserves every id', async () => {
    const out = await compactLedger({
      ledger: long,
      budget: 20,
      compact: () => Promise.resolve('short `claude:f1` `claude:f2`'),
    });
    expect(out.tier).toBe('moderator');
  });

  it('discards a compaction that loses an id and falls back to projection', async () => {
    const out = await compactLedger({
      ledger: long,
      budget: 20,
      compact: () => Promise.resolve('short `claude:f1`'),
    });
    expect(out.tier).toBe('projection');
    expect(out.text).toContain('claude:f2');
  });

  it('discards an empty compaction', async () => {
    const out = await compactLedger({
      ledger: long,
      budget: 20,
      compact: () => Promise.resolve('   '),
    });
    expect(out.tier).toBe('projection');
  });
});

describe('persistRound', () => {
  it('writes raw critiques, the reconcile, and one ledger per participant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baya-consensus-'));
    const paths = consensusPaths(dir, 'run-1');
    persistRound({
      paths,
      record: { round: 1, critiques, failed: [], reconcile, document: '# V2' },
      reviewers: ['claude', 'codex'],
      moderator: 'claude',
      aliasOf,
    });

    expect(JSON.parse(readFileSync(paths.critique('claude', 1), 'utf8')).kind).toBe(
      'critique_result',
    );
    expect(JSON.parse(readFileSync(paths.reconcile(1), 'utf8')).document).toBe('# V2');
    expect(readFileSync(paths.ledger('codex'), 'utf8')).toContain('Round 1');
    expect(readFileSync(paths.moderatorLedger, 'utf8')).toContain('**accepted**');
  });

  it('appends across rounds rather than rewriting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baya-consensus-'));
    const paths = consensusPaths(dir, 'run-1');
    const record = { critiques, failed: [], reconcile, document: '# V2' };
    persistRound({
      paths,
      record: { ...record, round: 1 },
      reviewers: ['claude'],
      moderator: 'claude',
      aliasOf,
    });
    persistRound({
      paths,
      record: { ...record, round: 2 },
      reviewers: ['claude'],
      moderator: 'claude',
      aliasOf,
    });
    const ledger = readFileSync(paths.ledger('claude'), 'utf8');
    expect(ledger).toContain('## Round 1');
    expect(ledger).toContain('## Round 2');
  });
});

describe('ledgerFor', () => {
  it('prefers a digest over the full ledger when one exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baya-consensus-'));
    const paths = consensusPaths(dir, 'run-1');
    persistRound({
      paths,
      record: { round: 1, critiques, failed: [], reconcile, document: '# V2' },
      reviewers: ['claude'],
      moderator: 'claude',
      aliasOf,
    });
    expect(ledgerFor(paths, 'claude', 2)).toContain('## Round 1');

    writeFile(paths.digest('claude', 1), 'compacted view');
    expect(ledgerFor(paths, 'claude', 2)).toBe('compacted view');
  });

  it('returns empty for a reviewer with no history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baya-consensus-'));
    expect(ledgerFor(consensusPaths(dir, 'r'), 'claude', 2)).toBe('');
  });
});

/**
 * A producing round: the reviewer answered, so the critique shape has nothing
 * true to say about it. Measured 2026-09-06, it said the opposite.
 */
describe('buildAnswerSection', () => {
  const proposals = [
    {
      provider: 'codex' as const,
      alias: 'Reviewer A',
      document: '5 minutes.',
      notes: ['Held: the scaling is one worker per table.'],
    },
  ];

  it('records that the reviewer answered, and why', () => {
    const section = buildAnswerSection({
      provider: 'codex',
      round: 2,
      proposals,
      agreement: { agreed: true, differences: [] } as never,
    });
    expect(section.text).toContain('You answered');
    expect(section.text).toContain('Held: the scaling is one worker per table.');
    expect(section.text).not.toContain('your call failed');
  });

  it('says a reviewer failed only when it actually did', () => {
    const section = buildAnswerSection({
      provider: 'claude',
      round: 1,
      proposals,
      agreement: null,
    });
    expect(section.text).toContain('your call failed');
  });

  it('carries the differences forward when they did not agree', () => {
    const section = buildAnswerSection({
      provider: 'codex',
      round: 1,
      proposals,
      agreement: {
        agreed: false,
        differences: ['whether they work in parallel'],
      } as never,
    });
    expect(section.text).toContain('whether they work in parallel');
  });
});
