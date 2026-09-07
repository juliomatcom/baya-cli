import { renderConsensusReport } from '../../../src/ui/consensus-report.js';
import { consensusPaths } from '../../../src/consensus/paths.js';
import { createTheme } from '../../../src/ui/theme.js';
import type { ConsensusOutcome } from '../../../src/consensus/engine.js';
import type { Change, ConsensusCriteria, Finding } from '../../../src/manifest/index.js';

/**
 * The report is where a debate becomes learnable: what each reviewer argued,
 * and what the moderator did with it. Asserted here is the presence of the
 * reasoning, never its wording — see AGENTS.md §Test What Was Decided.
 */

const criteria: ConsensusCriteria = {
  baya: '1',
  kind: 'consensus_criteria',
  artifact_kind: 'question',
  needs_workspace: false,
  needs_draft: true,
  criteria: [{ id: 'evidence', question: 'Is it grounded?' }],
};

const finding = (id: string, claim: string): Finding => ({
  id,
  severity: 'major',
  claim,
  evidence: 'the draft',
  suggestion: '',
  location: null,
});

function outcome(
  findings: Finding[],
  ids: string[],
  dropped: Change[] = [],
): ConsensusOutcome {
  return {
    criteria,
    needsWorkspace: false,
    proposed: false,
    document: '# Final',
    stopReason: 'converged',
    pseudonyms: {},
    rounds: [
      {
        round: 1,
        critiques: [
          {
            provider: 'codex',
            alias: 'Reviewer A',
            result: {
              baya: '1',
              kind: 'critique_result',
              round: 1,
              position: 'The draft overstates its case.',
              findings,
              notes: [],
            },
          },
        ],
        failed: [],
        unsourced: [],
        dropped,
        document: '# Final',
        reconcile: {
          baya: '1',
          kind: 'reconcile_result',
          round: 1,
          document: '# Final',
          changes: [
            {
              finding_ids: ids,
              criterion_id: 'evidence',
              action: 'accepted',
              rationale: 'the evidence was thin',
            },
          ],
          unresolved: [],
          converged: true,
        },
      },
    ],
  };
}

function render(out: ConsensusOutcome): string {
  return renderConsensusReport({
    theme: createTheme('never'),
    outcome: out,
    usage: [],
    paths: consensusPaths('/w', 'run-1'),
  });
}

describe('renderConsensusReport', () => {
  it("carries each reviewer's position and the claim behind every decision", () => {
    const text = render(
      outcome([finding('codex:f1', 'No dated milestone is cited.')], ['codex:f1']),
    );
    expect(text).toContain('The draft overstates its case.');
    expect(text).toContain('No dated milestone is cited.');
    expect(text).toContain('the evidence was thin');
  });

  it('prints a change Baya discarded for serving no criterion', () => {
    const stray: Change = {
      finding_ids: ['codex:f2'],
      criterion_id: 'house-style',
      action: 'accepted',
      rationale: 'added the required TL;DR line',
    };
    const text = render(
      outcome([finding('codex:f1', 'No dated milestone.')], ['codex:f1'], [stray]),
    );
    expect(text).toContain('discarded');
    expect(text).toContain('added the required TL;DR line');
  });

  it('says nothing about discards when there were none', () => {
    const text = render(
      outcome([finding('codex:f1', 'No dated milestone.')], ['codex:f1']),
    );
    expect(text).not.toContain('discarded');
  });

  it('says nothing about the debate under --no-diff', () => {
    const text = renderConsensusReport({
      theme: createTheme('never'),
      outcome: outcome([finding('codex:f1', 'A claim.')], ['codex:f1']),
      usage: [],
      paths: consensusPaths('/w', 'run-1'),
      noDiff: true,
    });
    expect(text).not.toContain('A claim.');
    expect(text).not.toContain('The draft overstates its case.');
  });
});
