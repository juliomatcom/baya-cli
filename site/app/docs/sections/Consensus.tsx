import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import { SectionHeading, WIKI_URL } from './shared';

export default function Consensus() {
  return (
    <section aria-labelledby="consensus" className="space-y-4">
      <SectionHeading id="consensus">AI Consensus</SectionHeading>
      <p className="text-slate-600">
        <code>baya consensus</code> puts one artifact — a spec, a diff, or a
        plain question — in front of several models at once and reports where
        they land. Each provider CLI reviews it independently; a moderator
        reconciles their findings into a new draft; the loop repeats until
        nothing blocking is left or the round ceiling is hit.
      </p>
      <p className="text-slate-600">
        It is a separate command, not a mode of <code>baya run</code>: no
        dependency graph, no task list, no lock, and <code>baya runs</code> and{' '}
        <code>baya resume</code> never see a consensus run.
      </p>
      <CopyCodeBlock
        code={
          'baya consensus ./spec.md --providers luna,sonnet,opencode/mimo-v2.5-free'
        }
      />
      <CopyCodeBlock
        code={
          'baya consensus "should we split this module?" --providers luna,sonnet --kind idea --rounds 3'
        }
      />
      <ul className="ml-5 list-disc space-y-1.5 text-sm text-slate-600">
        <li>
          <strong>Reviewers are named by model</strong> —{' '}
          <code>--providers luna,sonnet</code>. A bare provider id means that
          CLI’s own default model; an unstated reviewer uses your configured
          default, and the moderator defaults to your planner model.
        </li>
        <li>
          <strong>The moderator never picks the answer.</strong> It writes the
          criteria, reconciles each round, and reports whether the reviewers
          agree — nothing it believes about the subject reaches the output. A
          plain question gets no criteria at all: agreement prints the first
          reviewer’s answer, disagreement prints every answer side by side.
        </li>
        <li>
          <strong>Reviewers work blind.</strong> No reviewer sees another’s
          findings in the same round; rivals reach it under stable pseudonyms, so
          a finding stands on its evidence, not a brand name.
        </li>
        <li>
          <strong>
            <code>--rounds</code> is a ceiling, not a count.
          </strong>{' '}
          The debate stops early when no reviewer raised a <code>blocker</code>{' '}
          or <code>major</code> finding, or when a round breaks no new ground the
          last one already fixed.
        </li>
        <li>
          <strong>Access is the moderator’s call, not a flag.</strong> For a pure
          question the reviewers get no tools; for anything touching the tree
          they get the full tool set in your working directory and can run the
          suite to ground a finding.
        </li>
        <li>
          <strong>A confirm gate comes first</strong> (skip with{' '}
          <code>--yes</code>). When the reviewers have write access it warns that
          agents run unsupervised, several at once, with nothing isolating them —{' '}
          <strong>commit or stash before you start</strong>. Consensus is for
          reviewing, not developing.
        </li>
      </ul>
      <p className="text-sm text-slate-600">
        Everything lands in <code>.baya/consensus/&lt;runId&gt;/</code> as each
        round settles — every critique, each reviewer’s append-only ledger, and
        the reconciled drafts — so Ctrl+C on round 3 leaves rounds 1–2 intact.
        The report adds per-provider token spend, agreement counts, and the
        disagreements that never resolved.
      </p>
      <p className="text-sm text-slate-500">
        Every flag — <code>--providers</code>, <code>--moderator</code>,{' '}
        <code>--rounds</code>, <code>--kind</code>, <code>--ledger-budget</code>,{' '}
        <code>--output</code>, <code>--no-diff</code> — is in{' '}
        <a href="#cli">the CLI reference</a>. Round loop, ledgers, compaction,
        and the access postures in full:{' '}
        <a
          href={`${WIKI_URL}/consensus.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          wiki-llm/consensus.md
        </a>
        . The round loop is the <a href="#how-it-works">diagram further down</a>.
      </p>
    </section>
  );
}
