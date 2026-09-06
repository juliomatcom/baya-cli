import { join } from 'node:path';

/**
 * On-disk layout for one consensus run (specs/002-ai-consensus §8).
 *
 * `.baya/consensus/<runId>/` is a sibling of `runs/`, never a child: `baya
 * runs` and `baya resume` glob `runs/` and must not start listing debates.
 *
 * Per reviewer is the primary axis — the per-round view is a glob over it,
 * never a second copy.
 */
export interface ConsensusPaths {
  bayaDir: string;
  schemaDir: string;
  root: string;
  runDir: string;
  input: string;
  /** The parsed pass-0 document. Its call artifacts sit in `criteria/`. */
  criteria: string;
  /** Each reviewer's own answer for one round, in its own words. */
  proposal(provider: string, round: number): string;
  /** Whether the moderator found that round's answers saying the same thing. */
  agreement(round: number): string;
  pseudonyms: string;
  final: string;
  report: string;
  log: string;
  reviewerDir(provider: string): string;
  critique(provider: string, round: number): string;
  ledger(provider: string): string;
  digest(provider: string, round: number): string;
  moderatorDir: string;
  moderatorLedger: string;
  roundDir(round: number): string;
  reconcile(round: number): string;
  /** One call's own directory. Setup calls live under their own name, not `rounds/0/`. */
  callDir(callId: string, round: number): string;
  /** Where a `schema-file` provider leaves one call's JSON. Named by call id. */
  callResult(callId: string, round: number): string;
  /**
   * What the call actually answered, whatever shape it arrived in. Always
   * written: only `codex` fills `callResult`, so without this a claude or
   * opencode call left an empty directory and no record of its reply.
   */
  callAnswer(callId: string, round: number): string;
  callStdout(callId: string, round: number): string;
  callStderr(callId: string, round: number): string;
}

export function consensusPaths(cwd: string, runId: string): ConsensusPaths {
  const bayaDir = join(cwd, '.baya');
  const root = join(bayaDir, 'consensus');
  const runDir = join(root, runId);
  const reviewerDir = (provider: string): string => join(runDir, 'reviewers', provider);
  const roundDir = (round: number): string => join(runDir, 'rounds', String(round));
  /**
   * Pass 0 is not a round — it settles the criteria before any debate starts,
   * and there is exactly one of it. `rounds/0/` implied a round that never ran
   * and left a directory with no `reconcile.json` beside it.
   */
  const callDir = (callId: string, round: number): string => {
    if (round > 0) return join(roundDir(round), callId);
    // `<provider>-<kind>-<round>`; no provider id contains a dash.
    return join(runDir, 'criteria');
  };

  return {
    bayaDir,
    schemaDir: join(bayaDir, 'schema'),
    root,
    runDir,
    input: join(runDir, 'input.md'),
    criteria: join(runDir, 'criteria.json'),

    pseudonyms: join(runDir, 'pseudonyms.json'),
    final: join(runDir, 'final.md'),
    report: join(runDir, 'report.json'),
    log: join(runDir, 'baya.jsonl'),
    reviewerDir,
    proposal: (provider, round) =>
      join(reviewerDir(provider), `round-${String(round)}.answer.md`),
    agreement: (round) => join(roundDir(round), 'agreement.json'),
    critique: (provider, round) =>
      join(reviewerDir(provider), `round-${String(round)}.critique.json`),
    ledger: (provider) => join(reviewerDir(provider), 'ledger.md'),
    digest: (provider, round) =>
      join(reviewerDir(provider), `digest-${String(round)}.md`),
    moderatorDir: join(runDir, 'moderator'),
    moderatorLedger: join(runDir, 'moderator', 'ledger.md'),
    roundDir,
    reconcile: (round) => join(roundDir(round), 'reconcile.json'),
    callDir,
    callResult: (callId, round) => join(callDir(callId, round), 'result.json'),
    callAnswer: (callId, round) => join(callDir(callId, round), 'answer.txt'),
    callStdout: (callId, round) => join(callDir(callId, round), 'stdout.log'),
    callStderr: (callId, round) => join(callDir(callId, round), 'stderr.log'),
  };
}
