import {
  agreementOf,
  compactPrompt,
  criteriaPrompt,
  reconcilePrompt,
  reviewPrompt,
} from '../../../src/consensus/prompt.js';
import type { ConsensusCriteria, Finding } from '../../../src/manifest/index.js';

const criteria: ConsensusCriteria = {
  baya: '1',
  kind: 'consensus_criteria',
  artifact_kind: 'spec',
  needs_workspace: true,
  needs_draft: false,
  criteria: [{ id: 'edge-cases', question: 'What breaks under load?' }],
};

const finding: Finding = {
  id: 'claude:f1',
  severity: 'major',
  claim: 'No retry policy.',
  evidence: 'src/run.ts:40',
  suggestion: 'Bound retries.',
  location: 'src/run.ts:40',
};

const base = {
  artifact: '# Spec',
  criteria,
  cwd: '/work',
  needsWorkspace: true,
  reviewerCount: 3,
};

describe('criteriaPrompt', () => {
  it('names the source and asks for the posture', () => {
    const out = criteriaPrompt({ artifact: '# Spec', sourcePath: './s.md' });
    expect(out).toContain('./s.md');
    expect(out).toContain('needs_workspace');
  });

  it('warns off a needless workspace posture with its actual cost', () => {
    const out = criteriaPrompt({ artifact: 'who created bitcoin', sourcePath: null });
    expect(out).toContain('entire');
    expect(out).toContain('10k tokens');
  });

  it('says the artifact was given on the command line when there is no path', () => {
    expect(criteriaPrompt({ artifact: 'x', sourcePath: null })).toContain('command line');
  });
});

describe('reviewPrompt', () => {
  it('carries the shared-workspace note in the workspace posture', () => {
    expect(reviewPrompt({ ...base, round: 1 })).toContain(
      'several agents working in this directory',
    );
  });

  it('omits the note entirely in the tool-less posture', () => {
    const out = reviewPrompt({ ...base, round: 1, needsWorkspace: false });
    expect(out).not.toContain('several agents working in this directory');
    expect(out).toContain('You have no tools');
  });

  it('omits the note when this reviewer is the only agent', () => {
    const out = reviewPrompt({ ...base, round: 1, reviewerCount: 1 });
    expect(out).not.toContain('several agents working in this directory');
  });

  it('has no ledger section on round 1', () => {
    expect(reviewPrompt({ ...base, round: 1 })).not.toContain('Where you left off');
  });

  it('replays the ledger from round 2', () => {
    const out = reviewPrompt({
      ...base,
      round: 2,
      ledger: 'you said X; rejected because Y',
    });
    expect(out).toContain('Where you left off');
    expect(out).toContain('you said X; rejected because Y');
  });

  it('never names another provider', () => {
    const out = reviewPrompt({ ...base, round: 2, ledger: 'Reviewer B disagreed' });
    for (const id of ['claude', 'codex', 'copilot', 'opencode']) {
      expect(out).not.toContain(id);
    }
  });

  it('inlines the schema when one is given and tells the model not to look otherwise', () => {
    const schema = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'baya critique_result',
      properties: { findings: { type: 'array' } },
    });
    const out = reviewPrompt({ ...base, round: 1, schema });
    expect(out).toContain('findings');
    expect(reviewPrompt({ ...base, round: 1 })).toContain('already enforces');
  });

  it('strips the meta keys that make a schema look like a document to copy', () => {
    const schema = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'baya critique_result',
      properties: { findings: { type: 'array' } },
    });
    const out = reviewPrompt({ ...base, round: 1, schema });
    expect(out).not.toContain('$schema');
    expect(out).not.toContain('baya critique_result');
  });

  it('says the schema is a shape and not the answer', () => {
    const out = reviewPrompt({ ...base, round: 1, schema: '{"properties":{}}' });
    expect(out).toContain('describes the shape');
    expect(out).toContain('never return');
  });

  it('leaves an unparseable schema alone rather than dropping it', () => {
    expect(reviewPrompt({ ...base, round: 1, schema: 'not json' })).toContain('not json');
  });

  it('never names a schema by path', () => {
    expect(reviewPrompt({ ...base, round: 1, schema: '{}' })).not.toMatch(
      /schema at |\.schema\.json/,
    );
  });
});

describe('reconcilePrompt', () => {
  const critiques = [{ provider: 'claude', position: 'sound', findings: [finding] }];

  it('attributes findings to real providers — the moderator is not blind', () => {
    expect(reconcilePrompt({ ...base, round: 1, critiques })).toContain('## claude');
  });

  it('records a reviewer that raised nothing', () => {
    const out = reconcilePrompt({
      ...base,
      round: 1,
      critiques: [{ provider: 'codex', position: '', findings: [] }],
    });
    expect(out).toContain('No findings raised.');
  });

  it('replays its own past decisions when it has any', () => {
    const out = reconcilePrompt({ ...base, round: 2, critiques, ledger: 'rejected f1' });
    expect(out).toContain('What you decided before');
  });
});

describe('compactPrompt', () => {
  it('lists every id that must survive', () => {
    const out = compactPrompt({
      ledger: 'long',
      ids: ['claude:f1', 'codex:f2'],
      budget: 8000,
    });
    expect(out).toContain('claude:f1');
    expect(out).toContain('codex:f2');
    expect(out).toContain('8000');
  });
});

describe('agreementOf', () => {
  it('counts distinct providers behind one change', () => {
    expect(
      agreementOf({
        finding_ids: ['claude:f1', 'codex:f4', 'claude:f9'],
        criterion_id: 'c1',
        action: 'accepted',
        rationale: 'x',
      }),
    ).toEqual(['claude', 'codex']);
  });

  it('ignores an un-namespaced id rather than inventing a provider', () => {
    expect(
      agreementOf({
        finding_ids: ['f1'],
        criterion_id: 'c1',
        action: 'rejected',
        rationale: 'x',
      }),
    ).toEqual([]);
  });
});
