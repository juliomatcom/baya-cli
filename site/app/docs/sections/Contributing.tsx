import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import { GITHUB_URL } from '@/app/lib/site';
import { SectionHeading, WIKI_URL } from './shared';

export default function Contributing() {
  return (
    <section aria-labelledby="contributing" className="space-y-4">
      <SectionHeading id="contributing">Contributing</SectionHeading>
      <p className="text-slate-600">
        Contributions are welcome. The work is broken into sequenced tasks in{' '}
        <a
          href={`${GITHUB_URL}/blob/main/specs/001/02-plan.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          specs/001/02-plan.md
        </a>
        , each with its own done-criteria, so there is plenty to pick up
        independently.
      </p>
      <p className="text-slate-600">Before opening a PR:</p>
      <CopyCodeBlock code="npm run typecheck && npm run lint && npm test" />
      <p className="text-slate-600">
        A few rules are load-bearing rather than stylistic — the full list is in{' '}
        <a
          href={`${WIKI_URL}/conventions.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          wiki-llm/conventions.md
        </a>
        :
      </p>
      <ul className="ml-5 list-disc space-y-1.5 text-sm text-slate-600">
        <li>
          No <code>shell: true</code>, ever. Spawns take{' '}
          <code>argv: string[]</code>.
        </li>
        <li>Never document a provider flag you have not actually run.</li>
        <li>
          Never regex a model’s prose for meaning — semantics come from validated
          JSON.
        </li>
        <li>
          Update the affected <code>wiki-llm/</code> page in the same commit as
          the change.
        </li>
        <li>
          Read provider event shapes out of a recorded run in{' '}
          <code>.baya/runs/</code>, not out of a provider’s docs.
        </li>
        <li>
          Tests never touch the network; the contract tier is opt-in via{' '}
          <code>BAYA_CONTRACT=1</code>.
        </li>
      </ul>
      <p className="text-slate-600">
        Adding a provider is deliberately small: one adapter, one capability
        block, one section in <code>providers.md</code>, one contract test. New
        contributors should start with{' '}
        <a
          href={`${WIKI_URL}/conventions.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          conventions.md
        </a>
        , then the{' '}
        <a
          href={`${GITHUB_URL}/blob/main/specs/001/02-plan.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          plan
        </a>
        .
      </p>
      <div className="card p-5 text-sm text-slate-600">
        <strong className="text-slate-900">Use Baya on Baya.</strong> Every run
        leaves <code>.baya/runs/&lt;runId&gt;/</code> behind — real provider
        event streams on a real repository, for free. That corpus is the best
        fixture set the project has. Mine it before inventing an input, then pin
        what you find with a committed test.
      </div>
      <p>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
          Open the repository on GitHub →
        </a>
      </p>
    </section>
  );
}
