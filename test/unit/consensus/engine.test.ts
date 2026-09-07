import {
  assignPseudonyms,
  appliedCriteria,
  hasBlockingFindings,
  isSchemaEcho,
  offCriteria,
  onCriteria,
  looksLikeQuestion,
  describeParseFailure,
  namespaceFindings,
  parseDocument,
  providerErrorIn,
  stalledCriteria,
  unsourcedChanges,
  runConsensus,
  type ConsensusRunner,
  type RoundCritique,
} from '../../../src/consensus/engine.js';
import type { Finding, ProviderId } from '../../../src/manifest/index.js';
import { captureLogger } from '../../helpers/logger.js';

const criteriaDoc = JSON.stringify({
  baya: '1',
  kind: 'consensus_criteria',
  artifact_kind: 'spec',
  needs_workspace: false,
  needs_draft: false,
  criteria: [
    { id: 'c1', question: 'Is it right?' },
    { id: 'c2', question: 'Does it hold up?' },
  ],
});

function critique(severity: string, id = 'f1'): string {
  return JSON.stringify({
    baya: '1',
    kind: 'critique_result',
    round: 1,
    position: 'p',
    findings: [
      {
        id,
        severity,
        claim: 'c',
        evidence: 'e',
        suggestion: '',
        location: null,
      },
    ],
    notes: [],
  });
}

function agreement(agreed: boolean, differences: string[] = []): string {
  return JSON.stringify({
    baya: '1',
    kind: 'agreement_result',
    round: 1,
    agreed,
    differences,
    notes: [],
  });
}

function proposal(document: string): string {
  return JSON.stringify({
    baya: '1',
    kind: 'proposal_result',
    document,
    notes: [],
  });
}

const cleanCritique = JSON.stringify({
  baya: '1',
  kind: 'critique_result',
  round: 2,
  position: 'fine now',
  findings: [],
  notes: [],
});

function reconcile(document: string, converged = false, criterion = 'c1'): string {
  return JSON.stringify({
    baya: '1',
    kind: 'reconcile_result',
    round: 1,
    document,
    changes: [
      {
        finding_ids: ['claude:f1'],
        criterion_id: criterion,
        action: 'accepted',
        rationale: 'right',
      },
    ],
    unresolved: [],
    converged,
  });
}

function scripted(answers: string[]): ConsensusRunner {
  let index = 0;
  return () => Promise.resolve(answers[index++] ?? '');
}

const base = {
  artifact: '# Draft',
  sourcePath: './a.md',
  moderator: 'claude' as ProviderId,
  reviewers: ['claude', 'codex'] as ProviderId[],
  maxRounds: 3,
  cwd: '/work',
};

describe('parseDocument', () => {
  it('parses verbatim JSON', () => {
    expect(parseDocument('{"a":1}')).toEqual({ a: 1 });
  });

  it('takes the last fenced block, not the first', () => {
    const raw = '```json\n{"a":1}\n```\ntext\n```json\n{"a":2}\n```';
    expect(parseDocument(raw)).toEqual({ a: 2 });
  });

  it('returns null on prose', () => {
    expect(parseDocument('no json here')).toBeNull();
  });
});

describe('looksLikeQuestion', () => {
  it.each([
    'who created bitcoin',
    'will a human land in Mars before 2030? Why?',
    'Should we abstract this class?',
    'How do I shard this table',
  ])('treats %s as a question', (text) => {
    expect(looksLikeQuestion(text)).toBe(true);
  });

  it.each([
    'Refactor the auth module',
    'Write a haiku about Mars',
    '# Spec\n\nA multi-line document ending in a question?',
    '',
  ])('leaves %s alone', (text) => {
    expect(looksLikeQuestion(text)).toBe(false);
  });
});

describe('offCriteria and onCriteria', () => {
  const criteria = { criteria: [{ id: 'c1', question: 'q' }] } as never;

  const reconcileWith = (ids: string[], action = 'accepted'): never =>
    ({
      document: '#',
      changes: ids.map((criterion, index) => ({
        finding_ids: [`claude:f${String(index)}`],
        criterion_id: criterion,
        action,
        rationale: 'r',
      })),
      unresolved: [],
      converged: false,
    }) as never;

  it('names an accepted change serving a criterion nobody set', () => {
    expect(
      offCriteria(criteria, reconcileWith(['c1', 'house-style'])).map(
        (change) => change.criterion_id,
      ),
    ).toEqual(['house-style']);
  });

  it('treats an empty criterion_id as off-criteria', () => {
    expect(offCriteria(criteria, reconcileWith(['']))).toHaveLength(1);
  });

  /** A rejection changes nothing, so its criterion never has to be real. */
  it('leaves a rejected change alone whatever it names', () => {
    expect(offCriteria(criteria, reconcileWith(['house-style'], 'rejected'))).toEqual([]);
  });

  it('drops the off-criteria change before Baya applies the reconcile', () => {
    const reconcile = reconcileWith(['c1', 'house-style']);
    const applied = onCriteria(criteria, reconcile);
    expect(applied.changes.map((change) => change.criterion_id)).toEqual(['c1']);
    // The raw reconcile is untouched: the record still holds what was said.
    expect((reconcile as { changes: unknown[] }).changes).toHaveLength(2);
  });
});

describe('stalledCriteria', () => {
  const applied = (ids: string[]): never =>
    ({
      document: '#',
      changes: ids.map((criterion) => ({
        finding_ids: ['claude:f1'],
        criterion_id: criterion,
        action: 'accepted',
        rationale: 'r',
      })),
      unresolved: [],
      converged: false,
    }) as never;

  const roundOf = (ids: string[]): Parameters<typeof appliedCriteria>[0] =>
    ({
      round: 1,
      critiques: [],
      failed: [],
      reconcile: applied(ids),
      document: '#',
    }) as never;

  it('reads the criteria the moderator accepted a fix for', () => {
    expect([...appliedCriteria(roundOf(['c1', 'c2']))].sort()).toEqual(['c1', 'c2']);
  });

  it('fires when every criterion fixed this round was fixed last round too', () => {
    expect(stalledCriteria(roundOf(['c1']), applied(['c1']), true)).toEqual(['c1']);
  });

  it('holds off while any criterion is being fixed for the first time', () => {
    expect(stalledCriteria(roundOf(['c1']), applied(['c1', 'c2']), true)).toEqual([]);
  });

  it('never fires when nothing blocking is left — that is convergence', () => {
    expect(stalledCriteria(roundOf(['c1']), applied(['c1']), false)).toEqual([]);
  });

  it('never fires on the first round', () => {
    expect(stalledCriteria(undefined, applied(['c1']), true)).toEqual([]);
  });
});

describe('isSchemaEcho', () => {
  it('recognizes a returned JSON Schema by its meta pointer', () => {
    expect(
      isSchemaEcho({ $schema: 'https://json-schema.org/draft/2020-12/schema' }),
    ).toBe(true);
  });

  it('recognizes one that dropped the meta pointer but kept the shape', () => {
    expect(isSchemaEcho({ properties: {}, required: [] })).toBe(true);
  });

  it('does not fire on a real answer', () => {
    expect(isSchemaEcho({ baya: '1', kind: 'critique_result', findings: [] })).toBe(
      false,
    );
  });

  it('does not fire on a non-object', () => {
    expect(isSchemaEcho(null)).toBe(false);
    expect(isSchemaEcho('text')).toBe(false);
  });
});

describe('providerErrorIn', () => {
  it("names claude's tool-loop exhaustion instead of a zod key", () => {
    expect(
      providerErrorIn({ is_error: true, stop_reason: 'tool_use', num_turns: 6 }),
    ).toBe('the provider errored before answering (stop_reason: tool_use, 6 turns)');
  });

  it('recognizes an envelope carrying only a stop reason', () => {
    expect(providerErrorIn({ stop_reason: 'max_tokens' })).toContain('max_tokens');
  });

  it('stays silent on a real answer', () => {
    expect(providerErrorIn({ baya: '1', kind: 'critique_result' })).toBeNull();
  });
});

describe('describeParseFailure', () => {
  it('prefers the schema echo, then the provider error, then the zod message', () => {
    expect(describeParseFailure({ $schema: 'x' }, 'zod')).toContain('the schema');
    expect(describeParseFailure({ is_error: true }, 'zod')).toContain('errored');
    expect(describeParseFailure({ baya: '2' }, 'zod')).toBe('zod');
  });
});

describe('pseudonyms and namespacing', () => {
  it('assigns stable aliases in reviewer order', () => {
    expect(assignPseudonyms(['codex', 'claude'])).toEqual({
      'Reviewer A': 'codex',
      'Reviewer B': 'claude',
    });
  });

  it('prefixes finding ids so two reviewers cannot collide', () => {
    const raw = [{ id: 'f1' }, { id: 'f2' }] as Finding[];
    expect(namespaceFindings('codex', raw).map((f) => f.id)).toEqual([
      'codex:f1',
      'codex:f2',
    ]);
  });
});

describe('unsourcedChanges', () => {
  const withChanges = (changes: unknown[]): never => ({ changes }) as never;

  it('flags a change that cites no finding — the moderator speaking', () => {
    const out = unsourcedChanges(
      withChanges([
        { finding_ids: [], action: 'accepted', rationale: 'I thought it read better' },
        { finding_ids: ['claude:f1'], action: 'accepted', rationale: 'fair' },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.rationale).toBe('I thought it read better');
  });

  it('is empty when every change is sourced', () => {
    expect(
      unsourcedChanges(
        withChanges([{ finding_ids: ['codex:f1'], action: 'rejected', rationale: 'no' }]),
      ),
    ).toEqual([]);
  });

  it('is empty when there was no reconcile at all', () => {
    expect(unsourcedChanges(null)).toEqual([]);
  });
});

describe('hasBlockingFindings', () => {
  const make = (severity: string): RoundCritique =>
    ({
      provider: 'claude',
      alias: 'Reviewer A',
      result: { findings: [{ severity }] },
    }) as unknown as RoundCritique;

  it.each([
    ['blocker', true],
    ['major', true],
    ['minor', false],
    ['nit', false],
  ])('%s keeps the debate open: %s', (severity, expected) => {
    expect(hasBlockingFindings([make(severity)])).toBe(expected);
  });

  it('is false when nobody raised anything', () => {
    expect(hasBlockingFindings([])).toBe(false);
  });
});

describe('runConsensus', () => {
  it('stops as soon as no reviewer raises a blocker or major', async () => {
    const { logger } = captureLogger();
    const out = await runConsensus({
      ...base,
      logger,
      runner: scripted([
        criteriaDoc,
        critique('minor'),
        critique('nit'),
        reconcile('# V2'),
      ]),
    });
    expect(out.stopReason).toBe('converged');
    expect(out.rounds).toHaveLength(1);
    expect(out.document).toBe('# V2');
  });

  it('runs another round while a major stands, then converges', async () => {
    const { logger } = captureLogger();
    const out = await runConsensus({
      ...base,
      logger,
      runner: scripted([
        criteriaDoc,
        critique('major'),
        critique('major'),
        reconcile('# V2'),
        cleanCritique,
        cleanCritique,
      ]),
    });
    expect(out.rounds).toHaveLength(2);
    expect(out.stopReason).toBe('converged');
    // Round 2 raised nothing, so no reconcile ran and round 1's draft stands.
    expect(out.document).toBe('# V2');
  });

  it("ignores the model's own converged claim", async () => {
    const { logger } = captureLogger();
    const out = await runConsensus({
      ...base,
      maxRounds: 2,
      logger,
      runner: scripted([
        criteriaDoc,
        critique('blocker'),
        critique('blocker'),
        reconcile('# V2', true),
        critique('blocker'),
        critique('blocker'),
        reconcile('# V3', true),
      ]),
    });
    // Two rounds ran: `converged: true` on round 1 did not end the debate.
    expect(out.rounds).toHaveLength(2);
    expect(out.stopReason).not.toBe('converged');
  });

  it('asks the reviewers and only asks the moderator whether they agree', async () => {
    const captured = captureLogger();
    const calls: { kind: string; round: number }[] = [];
    const answers = [
      criteriaDoc.replace('"needs_draft":false', '"needs_draft":true'),
      proposal('Five minutes.'),
      proposal('Five minutes, one worker per table.'),
      agreement(true),
    ];
    let index = 0;
    const out = await runConsensus({
      ...base,
      maxRounds: 3,
      logger: captured.logger,
      runner: (call) => {
        calls.push({ kind: call.kind, round: call.round });
        return Promise.resolve(answers[index++] ?? '');
      },
    });
    expect(calls.map((call) => call.kind)).toEqual([
      'criteria',
      'propose',
      'propose',
      'agree',
    ]);
    expect(out.stopReason).toBe('converged');
    // Agreed means any of them is the answer; Baya takes the first named.
    expect(out.document).toBe('Five minutes.');
    expect(out.proposed).toBe(true);
  });

  it('revises and re-asks while they are not on the same page', async () => {
    const captured = captureLogger();
    const calls: string[] = [];
    const answers = [
      criteriaDoc.replace('"needs_draft":false', '"needs_draft":true'),
      proposal('Five minutes.'),
      proposal('One hundred minutes.'),
      agreement(false, ['how the rate scales']),
      proposal('Five minutes.'),
      proposal('Five minutes, I was wrong about the scaling.'),
      agreement(true),
    ];
    let index = 0;
    const out = await runConsensus({
      ...base,
      maxRounds: 3,
      logger: captured.logger,
      runner: (call) => {
        calls.push(call.kind);
        return Promise.resolve(answers[index++] ?? '');
      },
    });
    expect(calls).toEqual([
      'criteria',
      'propose',
      'propose',
      'agree',
      'propose',
      'propose',
      'agree',
    ]);
    expect(out.rounds).toHaveLength(2);
    expect(out.stopReason).toBe('converged');
  });

  it('prints every answer and picks none when they never agree', async () => {
    const captured = captureLogger();
    const out = await runConsensus({
      ...base,
      maxRounds: 2,
      logger: captured.logger,
      runner: scripted([
        criteriaDoc.replace('"needs_draft":false', '"needs_draft":true'),
        proposal('Five minutes.'),
        proposal('One hundred minutes.'),
        agreement(false, ['how the rate scales']),
        proposal('Still five.'),
        proposal('Still one hundred.'),
        agreement(false, ['how the rate scales', 'whether the workers are parallel']),
      ]),
    });
    expect(out.stopReason).toBe('split');
    expect(out.document).toContain('Still five.');
    expect(out.document).toContain('Still one hundred.');
  });

  it('spends nothing asking whether a lone answer agrees with itself', async () => {
    const captured = captureLogger();
    const kinds: string[] = [];
    const answers = [
      criteriaDoc.replace('"needs_draft":false', '"needs_draft":true'),
      proposal('The only answer.'),
    ];
    let index = 0;
    const out = await runConsensus({
      ...base,
      reviewers: ['claude'],
      maxRounds: 1,
      logger: captured.logger,
      runner: (call) => {
        kinds.push(call.kind);
        return Promise.resolve(answers[index++] ?? '');
      },
    });
    expect(kinds).toEqual(['criteria', 'propose']);
    expect(out.document).toBe('The only answer.');
  });

  it('stops when nobody moved and the split is unchanged', async () => {
    const captured = captureLogger();
    const out = await runConsensus({
      ...base,
      maxRounds: 5,
      logger: captured.logger,
      runner: scripted([
        criteriaDoc.replace('"needs_draft":false', '"needs_draft":true'),
        proposal('A.'),
        proposal('B.'),
        agreement(false, ['A versus B']),
        proposal('A.'),
        proposal('B.'),
        agreement(false, ['A versus B']),
      ]),
    });
    expect(out.stopReason).toBe('stalled');
    expect(out.rounds).toHaveLength(2);
  });

  it('discards a change serving a criterion the run does not have', async () => {
    const captured = captureLogger();
    const out = await runConsensus({
      ...base,
      maxRounds: 1,
      logger: captured.logger,
      runner: scripted([
        criteriaDoc,
        critique('major'),
        critique('major'),
        reconcile('# V2', false, 'house-style'),
      ]),
    });
    expect(captured.events).toContain('consensus.offcriteria');
    expect(out.rounds[0]?.dropped).toHaveLength(1);
    expect(out.rounds[0]?.reconcile?.changes).toHaveLength(0);
  });

  it('stops when the same criteria block again with nothing new raised', async () => {
    // Not destructured: `events` is a getter over a growing array.
    const captured = captureLogger();
    const logger = captured.logger;
    const out = await runConsensus({
      ...base,
      maxRounds: 4,
      logger,
      runner: scripted([
        criteriaDoc,
        critique('major'),
        critique('major'),
        reconcile('# V2'),
        critique('major'),
        critique('major'),
        reconcile('# V3'),
      ]),
    });
    expect(out.stopReason).toBe('stalled');
    expect(out.rounds).toHaveLength(2);
    // Round 2 still reconciled, so its findings reached the document.
    expect(out.document).toBe('# V3');
    expect(captured.events).toContain('consensus.stalled');
  });

  it('keeps going when a round raises blocking ground nobody has fixed', async () => {
    const { logger } = captureLogger();
    const out = await runConsensus({
      ...base,
      maxRounds: 3,
      logger,
      runner: scripted([
        criteriaDoc,
        critique('major'),
        critique('major'),
        reconcile('# V2'),
        critique('major', 'f2'),
        critique('major', 'f3'),
        // A second criterion, untouched by round 1's fix.
        reconcile('# V3', false, 'c2'),
        cleanCritique,
        cleanCritique,
      ]),
    });
    expect(out.stopReason).toBe('converged');
    expect(out.rounds).toHaveLength(3);
  });

  it('stops at the ceiling when findings never settle', async () => {
    const { logger } = captureLogger();
    const out = await runConsensus({
      ...base,
      maxRounds: 1,
      logger,
      runner: scripted([
        criteriaDoc,
        critique('blocker'),
        critique('blocker'),
        reconcile('# V2'),
      ]),
    });
    expect(out.stopReason).toBe('ceiling');
  });

  it('names a schema echo instead of dumping unrecognized keys', async () => {
    const { logger } = captureLogger();
    const settled: string[] = [];
    const schemaDoc = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {},
      required: [],
    });
    await runConsensus({
      ...base,
      reviewers: ['claude'],
      maxRounds: 1,
      logger,
      onCallSettled: (info) => {
        if (!info.ok && info.error !== undefined) settled.push(info.error);
      },
      runner: scripted([criteriaDoc, schemaDoc, schemaDoc]),
    });
    expect(settled).toContain('returned the schema instead of an answer');
  });

  it('proceeds on the surviving reviewers when one fails', async () => {
    const { logger } = captureLogger();
    let call = 0;
    const out = await runConsensus({
      ...base,
      logger,
      runner: ({ kind }) => {
        call += 1;
        if (kind === 'criteria') return Promise.resolve(criteriaDoc);
        if (kind === 'reconcile') return Promise.resolve(reconcile('# V2'));
        return call % 2 === 0
          ? Promise.reject(new Error('quota'))
          : Promise.resolve(critique('minor'));
      },
    });
    expect(out.rounds[0]?.failed).toHaveLength(1);
    expect(out.rounds[0]?.critiques).toHaveLength(1);
    expect(out.document).toBe('# V2');
  });

  it('ends at the last good draft when every reviewer fails, spending no reconcile', async () => {
    const { logger } = captureLogger();
    let reconciles = 0;
    const out = await runConsensus({
      ...base,
      logger,
      runner: ({ kind }) => {
        if (kind === 'criteria') return Promise.resolve(criteriaDoc);
        if (kind === 'reconcile') {
          reconciles += 1;
          return Promise.resolve(reconcile('# V2'));
        }
        return Promise.reject(new Error('down'));
      },
    });
    expect(out.stopReason).toBe('no_reviewers');
    expect(reconciles).toBe(0);
    expect(out.document).toBe('# Draft');
  });

  it('answers a question even when the moderator wanted to reword it', async () => {
    const captured = captureLogger();
    const wantsToReword = JSON.stringify({
      baya: '1',
      kind: 'consensus_criteria',
      artifact_kind: 'prompt',
      needs_workspace: false,
      criteria: [{ id: 'clarity', question: 'Is the wording clear?' }],
    });
    const out = await runConsensus({
      ...base,
      artifact: 'who created bitcoin',
      maxRounds: 1,
      logger: captured.logger,
      runner: scripted([
        wantsToReword,
        critique('minor'),
        critique('minor'),
        reconcile('Satoshi Nakamoto.'),
      ]),
    });
    expect(out.criteria.artifact_kind).toBe('question');
    expect(captured.events).toContain('consensus.kind.forced');
  });

  it('falls back to workspace access when the criteria call is unparseable', async () => {
    const captured = captureLogger();
    const out = await runConsensus({
      ...base,
      maxRounds: 1,
      logger: captured.logger,
      runner: scripted([
        'not json',
        critique('minor'),
        critique('minor'),
        reconcile('# V2'),
      ]),
    });
    expect(out.needsWorkspace).toBe(true);
    expect(captured.events).toContain('consensus.criteria.fallback');
  });

  it('skips pass 0 entirely when criteria are supplied', async () => {
    const { logger } = captureLogger();
    const kinds: string[] = [];
    await runConsensus({
      ...base,
      maxRounds: 1,
      logger,
      criteria: {
        baya: '1',
        kind: 'consensus_criteria',
        artifact_kind: 'idea',
        needs_workspace: false,
        needs_draft: false,
        criteria: [{ id: 'c1', question: 'q' }],
      },
      runner: (call) => {
        kinds.push(call.kind);
        return Promise.resolve(
          call.kind === 'reconcile' ? reconcile('# V2') : critique('minor'),
        );
      },
    });
    expect(kinds).not.toContain('criteria');
  });

  it("replays each reviewer its own ledger and nobody else's, from round 2", async () => {
    const { logger } = captureLogger();
    const seen: Record<string, string> = {};
    let round = 0;
    await runConsensus({
      ...base,
      maxRounds: 2,
      logger,
      ledgerFor: (provider) => `ledger for ${provider}`,
      runner: (call) => {
        if (call.role === 'reviewer' && call.round === 2)
          seen[call.provider] = call.prompt;
        if (call.kind === 'criteria') return Promise.resolve(criteriaDoc);
        if (call.kind === 'reconcile') {
          round += 1;
          return Promise.resolve(reconcile(`# V${String(round + 1)}`));
        }
        return Promise.resolve(critique('major'));
      },
    });
    expect(seen['codex']).toContain('ledger for codex');
    expect(seen['codex']).not.toContain('ledger for claude');
  });

  it('reports each round to the caller as it settles', async () => {
    const { logger } = captureLogger();
    const settled: number[] = [];
    await runConsensus({
      ...base,
      maxRounds: 1,
      logger,
      onRoundSettled: (record) => {
        settled.push(record.round);
      },
      runner: scripted([
        criteriaDoc,
        critique('minor'),
        critique('minor'),
        reconcile('# V2'),
      ]),
    });
    expect(settled).toEqual([1]);
  });
});
