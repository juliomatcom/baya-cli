import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { consensusPaths } from '../../src/consensus/paths.js';
import { FAKE_PROVIDER, makeWorkspace, runCli } from '../helpers/runCli.js';
import { readdirSync } from 'node:fs';

/**
 * `baya consensus` end to end against the fake provider. Zero network, zero
 * cost — the fake stands in for `codex` through the config's bin override.
 */

function criteria(needsWorkspace = false): object {
  return {
    baya: '1',
    kind: 'consensus_criteria',
    artifact_kind: 'spec',
    needs_workspace: needsWorkspace,
    needs_draft: false,
    criteria: [{ id: 'correctness', question: 'Is it right?' }],
  };
}

function critique(severity: string): object {
  return {
    baya: '1',
    kind: 'critique_result',
    round: 1,
    position: 'a stance',
    findings: [
      {
        id: 'f1',
        severity,
        claim: 'a claim',
        evidence: 'some evidence',
        suggestion: '',
        location: null,
      },
    ],
    notes: [],
  };
}

function proposal(document: string): object {
  return { baya: '1', kind: 'proposal_result', document, notes: [] };
}

function reconcile(document: string): object {
  return {
    baya: '1',
    kind: 'reconcile_result',
    round: 1,
    document,
    changes: [
      {
        finding_ids: ['codex:f1'],
        criterion_id: 'correctness',
        action: 'accepted',
        rationale: 'fair point',
      },
    ],
    unresolved: [{ claim: 'still arguing about naming', providers: [], rationale: '' }],
    converged: false,
  };
}

function consensusRunDir(cwd: string): string | null {
  const root = join(cwd, '.baya', 'consensus');
  if (!existsSync(root)) return null;
  const ids = readdirSync(root).sort();
  const last = ids[ids.length - 1];
  return last === undefined ? null : last;
}

describe('baya consensus', () => {
  it('runs a round and writes the final document to stdout', async () => {
    const workspace = makeWorkspace({
      taskList: '# Draft\n\nSome spec text.\n',
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# Draft v2') },
      },
    });

    const result = await runCli(['consensus', 'tasks.md', '--yes'], { workspace });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('# Draft v2');
  });

  it('persists the whole debate under .baya/consensus, not runs/', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    await runCli(['consensus', 'tasks.md', '--yes'], { workspace });

    const runId = consensusRunDir(workspace.cwd);
    expect(runId).not.toBeNull();
    const paths = consensusPaths(workspace.cwd, runId as string);

    expect(readFileSync(paths.final, 'utf8')).toContain('# V2');
    expect(readFileSync(paths.input, 'utf8')).toContain('Design the API');
    expect(existsSync(paths.criteria)).toBe(true);
    expect(existsSync(paths.pseudonyms)).toBe(true);
    expect(existsSync(paths.critique('codex', 1))).toBe(true);
    expect(existsSync(paths.reconcile(1))).toBe(true);
    expect(existsSync(paths.ledger('codex'))).toBe(true);
    expect(existsSync(paths.moderatorLedger)).toBe(true);
    // Never in runs/ — `baya runs` and `resume` must not see debates.
    expect(existsSync(join(workspace.cwd, '.baya', 'runs'))).toBe(false);
  });

  it('writes the document to --output when asked', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# Written') },
      },
    });

    const result = await runCli(
      ['consensus', 'tasks.md', '--output', 'out.md', '--yes'],
      {
        workspace,
      },
    );

    expect(result.code).toBe(0);
    expect(readFileSync(join(workspace.cwd, 'out.md'), 'utf8')).toContain('# Written');
  });

  it('emits a machine-readable report under --json', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(['consensus', 'tasks.md', '--json', '--yes'], {
      workspace,
    });
    const report = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(report['stop_reason']).toBe('converged');
    expect(report['moderator']).toBe('codex');
    expect(report['reviewers']).toEqual(['codex']);
  });

  it('accepts a raw prompt when the positional is not a file', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        // A bare question is answered, so round 1 proposes rather than reviews.
        'codex-propose-1': { final: proposal('# From a prompt') },
      },
    });

    const result = await runCli(
      ['consensus', 'should we abstract this class?', '--json', '--rounds', '1', '--yes'],
      { workspace },
    );

    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(result.code).toBe(0);
    // The subject of a prompt run survives into the report; there is no path.
    expect(report['artifact']).toBe('should we abstract this class?');
    expect(report['source']).toBeNull();
  });

  it('skips the classification call when --kind is given', async () => {
    const workspace = makeWorkspace({
      scenario: {
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(
      ['consensus', 'tasks.md', '--kind', 'idea', '--json', '--yes'],
      { workspace },
    );

    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as Record<string, unknown>)['artifact_kind']).toBe(
      'idea',
    );
  });

  it('names gemini as adapter-less rather than merely unknown', async () => {
    const result = await runCli(['consensus', 'tasks.md', '--providers', 'gemini']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no adapter yet');
  });

  it('rejects a name that is neither a model nor a provider', async () => {
    const result = await runCli(['consensus', 'tasks.md', '--providers', 'nonsense-9']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not a known model or provider');
  });

  it('routes a reviewer named by model to the CLI that serves it', async () => {
    const workspace = makeWorkspace({
      scenario: {
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(
      [
        'consensus',
        'tasks.md',
        '--providers',
        'gpt-5.6-luna',
        '--kind',
        'idea',
        '--json',
        '--yes',
      ],
      { workspace },
    );

    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as Record<string, unknown>)['reviewers']).toEqual([
      'codex',
    ]);
  });

  it('resolves a user alias to its model and CLI', async () => {
    const workspace = makeWorkspace({
      config: { modelAliases: { luna: 'gpt-5.6-luna' } },
      scenario: {
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(
      [
        'consensus',
        'tasks.md',
        '--providers',
        'luna',
        '--kind',
        'idea',
        '--json',
        '--yes',
      ],
      { workspace },
    );

    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as Record<string, unknown>)['reviewers']).toEqual([
      'codex',
    ]);
  });

  it('routes an opencode id by its upstream/model shape', async () => {
    const workspace = makeWorkspace({
      config: {
        providers: {
          codex: { bin: FAKE_PROVIDER },
          opencode: { bin: FAKE_PROVIDER },
        },
      },
      scenario: {
        'opencode-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(
      [
        'consensus',
        'tasks.md',
        '--providers',
        'opencode/mimo-v2.5-free',
        '--kind',
        'idea',
        '--json',
        '--yes',
      ],
      { workspace },
    );

    expect((JSON.parse(result.stdout) as Record<string, unknown>)['reviewers']).toEqual([
      'opencode',
    ]);
  });

  it("takes bare provider ids as that CLI's own default model", async () => {
    const workspace = makeWorkspace({
      config: {
        providers: {
          codex: { bin: FAKE_PROVIDER },
          claude: { bin: FAKE_PROVIDER },
        },
      },
      scenario: {
        'claude-review-1': { final: critique('minor') },
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(
      [
        'consensus',
        'tasks.md',
        '--providers',
        'claude,codex',
        '--kind',
        'idea',
        '--json',
        '--yes',
      ],
      { workspace },
    );

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report['reviewers']).toEqual(['claude', 'codex']);
  });

  it('leaves a completion line for every call that finished', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(['consensus', 'tasks.md', '--yes'], { workspace });

    expect(result.stderr).toContain('set the criteria');
    expect(result.stderr).toContain('1 finding');
    expect(result.stderr).toContain('reconciled');
  });

  it('reports a reviewer that raised nothing, rather than going silent', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': {
          final: {
            baya: '1',
            kind: 'critique_result',
            round: 1,
            position: 'fine',
            findings: [],
            notes: [],
          },
        },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(['consensus', 'tasks.md', '--yes'], { workspace });
    expect(result.stderr).toContain('nothing to raise');
  });

  it('leaves a record for every call, not only the schema-file provider', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    await runCli(['consensus', 'tasks.md', '--yes'], { workspace });

    const runId = consensusRunDir(workspace.cwd) as string;
    const paths = consensusPaths(workspace.cwd, runId);
    for (const [callId, round] of [
      ['criteria', 0],
      ['codex-review-1', 1],
      ['codex-reconcile-1', 1],
    ] as const) {
      expect(
        readFileSync(paths.callAnswer(callId, round), 'utf8').length,
      ).toBeGreaterThan(0);
    }
  });

  it('shows the posture and the spend at the gate, after pass 0 and before the rounds', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(['consensus', 'tasks.md', '--yes'], { workspace });

    expect(result.stderr).toContain('tool-less');
    expect(result.stderr).toContain('more provider calls');
    // The criteria never leave the moderator, the gate included.
    expect(result.stderr).not.toContain('Is it right?');
  });

  it('will not start a debate on a pipe without --yes', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });

    const result = await runCli(['consensus', 'tasks.md'], { workspace });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--yes');
    // Pass 0 ran and is on disk; no round did.
    const runId = consensusRunDir(workspace.cwd) as string;
    const paths = consensusPaths(workspace.cwd, runId);
    expect(existsSync(paths.callAnswer('criteria', 0))).toBe(true);
    expect(existsSync(join(paths.runDir, 'rounds'))).toBe(false);
  });

  it('answers a question rather than rewording it', async () => {
    const workspace = makeWorkspace({
      scenario: {
        'codex-propose-1': { final: proposal('Satoshi Nakamoto, probably.') },
      },
    });

    const result = await runCli(
      [
        'consensus',
        'who created bitcoin',
        '--kind',
        'question',
        '--rounds',
        '1',
        '--yes',
      ],
      { workspace },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Satoshi Nakamoto, probably.');

    // The reviewers answer; nothing critiques the question and nothing rewrites it.
    const runId = consensusRunDir(workspace.cwd) as string;
    const paths = consensusPaths(workspace.cwd, runId);
    expect(readFileSync(paths.proposal('codex', 1), 'utf8')).toContain(
      'Satoshi Nakamoto',
    );
    expect(existsSync(paths.critique('codex', 1))).toBe(false);
  });

  it('reviews a pasted document in place, with no proposal round', async () => {
    const workspace = makeWorkspace({
      taskList: '# Plan\n\nStep one.\n',
      scenario: {
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# Plan v2') },
      },
    });

    const result = await runCli(
      ['consensus', 'tasks.md', '--kind', 'plan', '--json', '--yes'],
      { workspace },
    );

    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as Record<string, unknown>)['proposed']).toBe(
      false,
    );
    const runId = consensusRunDir(workspace.cwd) as string;
    expect(existsSync(consensusPaths(workspace.cwd, runId).proposal('codex', 1))).toBe(
      false,
    );
  });

  it('refuses two models of the same CLI — one ledger per reviewer', async () => {
    const result = await runCli([
      'consensus',
      'tasks.md',
      '--providers',
      'codex,gpt-5.6-luna',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('already reviewing');
  });

  it('rejects an unknown --kind', async () => {
    const result = await runCli(['consensus', 'tasks.md', '--kind', 'novel']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--kind must be one of');
  });

  it('needs an artifact', async () => {
    const result = await runCli(['consensus']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('consensus needs a file path or a prompt');
  });

  it('shows the unsupervised-agents warning only in the workspace posture', async () => {
    const loose = makeWorkspace({
      scenario: {
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });
    const workspaceRun = await runCli(
      ['consensus', 'tasks.md', '--kind', 'review', '--yes'],
      { workspace: loose },
    );
    expect(workspaceRun.stderr).toContain('will run unsupervised in');

    const quiet = makeWorkspace({
      scenario: {
        'codex-review-1': { final: critique('minor') },
        'codex-reconcile-1': { final: reconcile('# V2') },
      },
    });
    const toolless = await runCli(['consensus', 'tasks.md', '--kind', 'idea', '--yes'], {
      workspace: quiet,
    });
    expect(toolless.stderr).not.toContain('will run unsupervised in');
  });

  it('keeps going for another round while a major finding stands', async () => {
    const workspace = makeWorkspace({
      scenario: {
        criteria: { final: criteria() },
        'codex-review-1': { final: critique('major') },
        'codex-reconcile-1': { final: reconcile('# V2') },
        'codex-review-2': { final: critique('nit') },
        'codex-reconcile-2': { final: reconcile('# V3') },
      },
    });

    const result = await runCli(['consensus', 'tasks.md', '--json', '--yes'], {
      workspace,
    });
    const report = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(report['rounds']).toBe(2);
    expect(report['stop_reason']).toBe('converged');
  });
});
