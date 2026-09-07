import { renderGate } from '../../../src/cli/consensus.js';
import { createTheme } from '../../../src/ui/theme.js';
import type { ConsensusCriteria, ProviderId } from '../../../src/manifest/index.js';

const GREEN = '\u001B[32m';
const YELLOW = '\u001B[33m';

function criteria(needsWorkspace: boolean): ConsensusCriteria {
  return {
    baya: '1',
    kind: 'consensus_criteria',
    artifact_kind: 'spec',
    needs_workspace: needsWorkspace,
    needs_draft: false,
    criteria: [{ id: 'edge-cases', question: 'What breaks under load?' }],
  };
}

function gate(needsWorkspace: boolean, color: 'always' | 'never' = 'always'): string {
  return renderGate({
    theme: createTheme(color),
    artifact: './spec.md',
    criteria: criteria(needsWorkspace),
    moderator: 'codex' as ProviderId,
    moderatorModel: 'gpt-5.6-luna',
    reviewers: ['codex', 'claude'] as ProviderId[],
    reviewerModels: new Map<ProviderId, string | null>([
      ['codex', 'gpt-5.6-luna'],
      ['claude', null],
    ]),
    maxRounds: 2,
    calls: 6,
    cwd: '/work',
  });
}

describe('the consensus gate', () => {
  it('paints a tool-less posture green — the agents can touch nothing', () => {
    expect(gate(false)).toContain(`${GREEN}tool-less`);
  });

  it('paints a workspace posture yellow — the agents can write in your tree', () => {
    expect(gate(true)).toContain(`${YELLOW}workspace`);
  });

  it('warns about unsupervised agents only in the workspace posture', () => {
    expect(gate(true, 'never')).toContain('will run unsupervised in');
    expect(gate(false, 'never')).not.toContain('will run unsupervised in');
  });

  // ⚠️ The criteria are the moderator's alone, and a producing run has none.
  it('never shows the criteria', () => {
    expect(gate(false, 'never')).not.toContain('What breaks under load?');
  });

  it('lists reviewers on one line, model names only, falling back to the provider', () => {
    const out = gate(false, 'never');
    expect(out).toContain('reviewers [gpt-5.6-luna, claude]');
  });

  it('says when the moderator has no pinned model', () => {
    const out = renderGate({
      theme: createTheme('never'),
      artifact: './spec.md',
      criteria: criteria(false),
      moderator: 'codex' as ProviderId,
      moderatorModel: null,
      reviewers: ['codex'] as ProviderId[],
      reviewerModels: new Map<ProviderId, string | null>([['codex', null]]),
      maxRounds: 2,
      calls: 6,
      cwd: '/work',
    });
    expect(out).toContain('(provider default)');
  });

  it('states what is still to be spent', () => {
    expect(gate(false, 'never')).toContain('6 more provider calls');
  });
});
