import {
  ConsensusCriteriaSchema,
  CritiqueResultSchema,
  ProposalResultSchema,
  ReconcileResultSchema,
  consensusCriteriaJsonSchema,
  critiqueResultJsonSchema,
  proposalResultJsonSchema,
  reconcileResultJsonSchema,
} from '../../../src/manifest/index.js';

const criteria = {
  baya: '1',
  kind: 'consensus_criteria',
  artifact_kind: 'spec',
  needs_workspace: true,
  needs_draft: false,
  criteria: [{ id: 'edge-cases', question: 'What breaks under load?' }],
};

const critique = {
  baya: '1',
  kind: 'critique_result',
  round: 1,
  position: 'The plan is sound but under-specifies failure.',
  findings: [
    {
      id: 'f1',
      severity: 'major',
      claim: 'No retry policy.',
      evidence: 'src/run.ts:40 catches and rethrows.',
      suggestion: 'Bound retries.',
      location: 'src/run.ts:40',
    },
  ],
  notes: [],
};

const reconcile = {
  baya: '1',
  kind: 'reconcile_result',
  round: 1,
  document: '# Spec\n\nUpdated.',
  changes: [
    {
      finding_ids: ['claude:f1', 'codex:f4'],
      criterion_id: 'edge-cases',
      action: 'accepted',
      rationale: 'Both are right.',
    },
  ],
  unresolved: [],
  converged: false,
};

describe('consensus schemas', () => {
  it('accepts a well-formed criteria document', () => {
    expect(ConsensusCriteriaSchema.parse(criteria).needs_workspace).toBe(true);
  });

  it('accepts a well-formed critique and keeps finding order', () => {
    const parsed = CritiqueResultSchema.parse(critique);
    expect(parsed.findings.map((f) => f.id)).toEqual(['f1']);
  });

  it('accepts a well-formed reconcile document', () => {
    const parsed = ReconcileResultSchema.parse(reconcile);
    expect(parsed.changes[0]?.finding_ids).toEqual(['claude:f1', 'codex:f4']);
  });

  it('defaults an absent findings array to empty rather than failing', () => {
    const { findings: _drop, ...rest } = critique;
    void _drop;
    expect(CritiqueResultSchema.parse(rest).findings).toEqual([]);
  });

  it('rejects an unknown severity', () => {
    const bad = {
      ...critique,
      findings: [{ ...critique.findings[0], severity: 'huge' }],
    };
    expect(CritiqueResultSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a reconcile document with no document text', () => {
    expect(ReconcileResultSchema.safeParse({ ...reconcile, document: '' }).success).toBe(
      false,
    );
  });

  it('rejects a proposal with no document text', () => {
    expect(ProposalResultSchema.safeParse({ ...proposal, document: '' }).success).toBe(
      false,
    );
  });

  it('rejects unknown properties, so provider drift is loud', () => {
    expect(ConsensusCriteriaSchema.safeParse({ ...criteria, extra: 1 }).success).toBe(
      false,
    );
  });
});

const proposal = {
  baya: '1',
  kind: 'proposal_result',
  document: '# Answer\n\nProbably not.',
  notes: [],
};

describe('consensus JSON Schema documents', () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ['consensus_criteria', consensusCriteriaJsonSchema(), criteria],
    ['critique_result', critiqueResultJsonSchema(), critique],
    ['reconcile_result', reconcileResultJsonSchema(), reconcile],
    ['proposal_result', proposalResultJsonSchema(), proposal],
  ];

  it.each(cases)('%s requires every property it declares', (_name, document, sample) => {
    const properties = Object.keys(document['properties'] as Record<string, unknown>);
    expect(document['required']).toEqual(properties);
    expect(document['additionalProperties']).toBe(false);
    expect(Object.keys(sample as object).sort()).toEqual([...properties].sort());
  });
});
