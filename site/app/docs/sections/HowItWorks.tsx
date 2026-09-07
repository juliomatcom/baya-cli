import Mermaid from '@/app/components/Mermaid';
import { CONSENSUS_DIAGRAM, RUN_DIAGRAM } from '@/app/lib/diagrams';
import { SectionHeading, WIKI_URL } from './shared';

export default function HowItWorks() {
  return (
    <section aria-labelledby="how-it-works" className="space-y-6">
      <SectionHeading id="how-it-works">How it works</SectionHeading>
      <p className="text-slate-600">
        Two commands, two shapes. A <strong>run</strong> turns a task list into a
        dependency graph and executes it; a <strong>consensus</strong> debate
        puts one artifact in front of several models and reports where they land.
      </p>

      <div className="space-y-3">
        <h3 className="text-lg font-bold text-slate-900">A run</h3>
        <p className="text-sm text-slate-600">
          Freeform list to report, with the preview gate the only stop. Grouping
          is decided separately from the graph, so a chain can still be one
          process, and what each task discovers flows back to the scheduler for
          the tasks that follow. Detail: <a href="#run">run</a> and{' '}
          <a href="#internals">design principles</a>.
        </p>
        <Mermaid
          chart={RUN_DIAGRAM}
          caption="A run: plan, validate, gate, group, dispatch, reconcile results, report."
        />
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-bold text-slate-900">A consensus debate</h3>
        <p className="text-sm text-slate-600">
          The moderator writes the criteria and reconciles each round but never
          picks the answer; reviewers critique in parallel and never see each
          other’s findings in the same round. The loop stops when nothing
          blocking is left or <code>--rounds</code> is hit. For a plain question
          there are no criteria and the moderator only reports agreement. Detail:{' '}
          <a href="#consensus">consensus</a> and{' '}
          <a
            href={`${WIKI_URL}/consensus.md`}
            target="_blank"
            rel="noreferrer noopener"
          >
            wiki-llm/consensus.md
          </a>
          .
        </p>
        <Mermaid
          chart={CONSENSUS_DIAGRAM}
          caption="A consensus debate: classify, fan out blind, reconcile, repeat until it converges or the round ceiling is reached."
        />
      </div>
    </section>
  );
}
