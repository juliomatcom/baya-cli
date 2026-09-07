import type { Metadata } from 'next';
import Link from 'next/link';
import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import Mermaid from '@/app/components/Mermaid';
import { CONSENSUS_DIAGRAM_SIMPLE } from '@/app/lib/diagrams';
import { GITHUB_URL, pageMetadata, SITE_URL } from '@/app/lib/site';

export const metadata: Metadata = {
  ...pageMetadata({
    title: 'AI Consensus for Code — baya consensus',
    description:
      'baya consensus runs a multi-model AI consensus from your terminal: several LLM CLIs review one spec, diff, or question independently, a moderator reconciles each round, and you get back what they agree on and what they do not. No API keys — it drives the coding subscriptions you already have.',
    path: '/ai-consensus',
    image: '/og/ai-consensus.png',
    imageAlt:
      'Diagram — how a baya consensus debate runs: your spec, diff, or question goes to a moderator, several models review it blind and in parallel, the moderator merges their feedback into a new draft, and the loop repeats until nothing important is unresolved.',
  }),
  keywords: [
    'AI consensus',
    'multi-model consensus',
    'LLM consensus',
    'AI consensus tool',
    'multi-model AI review',
    'multi-provider AI',
    'AI debate CLI',
    'consensus AI',
    'baya consensus',
  ],
};

const WIKI_CONSENSUS = `${GITHUB_URL}/blob/main/wiki-llm/consensus.md`;

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'SoftwareApplication',
      name: 'baya consensus',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS, Linux, Windows',
      url: `${SITE_URL}/ai-consensus`,
      downloadUrl: 'https://www.npmjs.com/package/baya-cli',
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' },
      description:
        'A command-line tool for multi-model AI consensus: several LLM CLIs review one artifact independently and blind, a moderator reconciles each round, and the run reports agreement and unresolved disagreement.',
      featureList: [
        'Multi-model AI consensus over a spec, a diff, or a plain question',
        'Independent, blind review across several LLM CLIs',
        'A moderator that reconciles rounds but never picks the answer',
        'Deterministic convergence — stops when nothing blocking is left',
        'Runs on the coding subscriptions you already have, no API keys',
      ],
    },
    {
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'What is AI consensus?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'AI consensus is asking several models the same thing independently and then measuring where they agree. baya consensus does this from your terminal: each provider CLI reviews one artifact blind, a moderator reconciles their findings into a new draft each round, and the run reports what the models agree on and what they do not — it never just averages them or picks a winner.',
          },
        },
        {
          '@type': 'Question',
          name: 'How does baya run a multi-model consensus?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Point baya consensus at a file or a quoted prompt. Reviewers critique it in parallel, never seeing each other’s findings in the same round. A moderator merges those findings into a new draft; the next round critiques that draft. The loop stops when no reviewer raises a blocker or major finding, or when the round ceiling is hit.',
          },
        },
        {
          '@type': 'Question',
          name: 'Does AI consensus need API keys?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'No. baya consensus drives the coding CLIs already installed and authenticated on your machine — codex, claude, copilot, opencode — under whatever subscription you already pay for.',
          },
        },
      ],
    },
  ],
};

export default function ConsensusPage() {
  return (
    <main className="bg-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />

      <section className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <p className="font-mono text-sm font-semibold uppercase tracking-[0.25em] text-accent">
          baya consensus
        </p>
        <h1 className="mt-4 text-4xl font-bold sm:text-5xl">
          Multi-model AI consensus, from your terminal
        </h1>
        <p className="mt-6 text-lg text-slate-600">
          <code>baya consensus</code> puts one artifact — a spec, a diff, or a
          plain question — in front of several models at once and reports where
          they land. Each provider CLI reviews it independently and blind; a
          moderator reconciles their findings into a new draft each round; the
          loop repeats until nothing blocking is left. You get back what the
          models agree on, and the disagreements that never resolved.
        </p>

        <div className="mt-8 space-y-3">
          <CopyCodeBlock code="npm install -g baya-cli" />
          <CopyCodeBlock code={'baya consensus ./spec.md --providers luna,sonnet,opencode/mimo-v2.5-free'} />
        </div>

        <div className="mt-6 flex flex-wrap gap-4 text-sm font-semibold">
          <Link href="/docs#consensus" className="text-accent">
            Read the docs →
          </Link>
          <a
            href={WIKI_CONSENSUS}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent"
          >
            Design record →
          </a>
        </div>
      </section>

      <section
        aria-labelledby="how"
        className="border-t border-slate-200 bg-slate-50"
      >
        <div className="mx-auto max-w-3xl px-6 py-14">
          <h2 id="how" className="text-2xl font-bold">
            How the debate runs
          </h2>
          <p className="mt-3 text-slate-600">
            A moderator classifies the artifact and writes the criteria it will
            judge against — then keeps them to itself. Reviewers answer or
            critique in parallel, blind to each other. The moderator reconciles
            each round into a new draft and reports whether the reviewers agree;
            it never picks the answer itself.
          </p>
          <div className="mt-6">
            <Mermaid
              chart={CONSENSUS_DIAGRAM_SIMPLE}
              caption="Each model reviews on its own, a moderator merges the feedback into a new draft, and the loop repeats until nothing important is left — a few rounds at most."
            />
          </div>
        </div>
      </section>

      <section
        aria-labelledby="use"
        className="mx-auto max-w-3xl px-6 py-14"
      >
        <h2 id="use" className="text-2xl font-bold">
          What it is good for
        </h2>
        <dl className="mt-6 space-y-5 text-slate-600">
          <div>
            <dt className="font-semibold text-slate-900">
              Pressure-testing a design
            </dt>
            <dd className="mt-1 text-sm leading-relaxed">
              Put a spec or an RFC in front of three models and see which
              concerns more than one of them independently raise — that overlap
              is the signal a single review cannot give you.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-900">Reviewing a diff</dt>
            <dd className="mt-1 text-sm leading-relaxed">
              In the workspace posture reviewers get the full tool set in your
              working directory and can run the suite to ground a finding. A
              confirm gate warns you first — consensus is for reviewing, not
              developing.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-900">
              Settling a question
            </dt>
            <dd className="mt-1 text-sm leading-relaxed">
              Ask a plain question and every model answers it blind. Agreement
              prints the first answer; disagreement prints every answer side by
              side, none marked best. The moderator writes no criteria and only
              reports agreement.
            </dd>
          </div>
        </dl>

        <h2 className="mt-12 text-2xl font-bold">Why not just average models?</h2>
        <p className="mt-3 text-slate-600">
          Because a majority is not a correctness signal. Voting and averaging
          both make one model an arbiter of the others. <code>baya consensus</code>{' '}
          keeps every position on the record, anonymizes rivals so a finding
          stands on its evidence rather than a brand name, and hands you the
          disagreement instead of hiding it.
        </p>

        <div className="mt-10 rounded-xl border border-slate-200 bg-white p-6">
          <p className="text-sm text-slate-600">
            <code>baya consensus</code> ships in{' '}
            <a
              href="https://www.npmjs.com/package/baya-cli"
              target="_blank"
              rel="noreferrer noopener"
            >
              baya-cli
            </a>{' '}
            alongside <Link href="/features">the run orchestrator</Link>. No API
            keys — it drives the coding CLIs you already have.{' '}
            <Link href="/faq">FAQ</Link> · <Link href="/docs">Docs</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
