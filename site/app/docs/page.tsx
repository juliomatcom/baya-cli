import type { Metadata } from 'next';
import Link from 'next/link';
import { GITHUB_URL, pageMetadata } from '@/app/lib/site';
import { DOC_SECTIONS } from './sections';

export const metadata: Metadata = pageMetadata({
  title: 'Docs – Baya',
  description:
    'Baya documentation: install and first run, writing task lists, per-task model routing, how a run and a baya consensus debate work, the CLI command and flag reference, the provider support matrix, configuration, recovery and resume, and how to contribute.',
  path: '/docs',
});

const WIKI_URL = `${GITHUB_URL}/blob/main/wiki-llm`;

export default function DocsPage() {
  return (
    <main className="bg-white">
      <div className="mx-auto max-w-6xl px-6 py-12 md:py-16">
        <p className="font-mono text-sm font-semibold uppercase tracking-[0.25em] text-accent">
          Docs
        </p>
        <h1 className="mt-4 text-4xl font-bold sm:text-5xl">
          Everything Baya does, and how
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-slate-600">
          From install to a recovered run. This site is the place for the full
          picture; the{' '}
          <a href={WIKI_URL} target="_blank" rel="noreferrer noopener">
            wiki
          </a>{' '}
          stays the technical source of truth for contributors.
        </p>

        <div className="mt-12 gap-12 md:grid md:grid-cols-[13rem_minmax(0,1fr)]">
          <nav
            aria-label="On this page"
            className="mb-10 md:sticky md:top-24 md:mb-0 md:self-start"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              On this page
            </p>
            <ul className="mt-4 space-y-1 border-l border-slate-200">
              {DOC_SECTIONS.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="-ml-px block border-l border-transparent py-1.5 pl-4 text-sm text-slate-600 hover:border-accent hover:text-accent hover:no-underline"
                  >
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 space-y-16">
            {DOC_SECTIONS.map(({ id, Component }) => (
              <Component key={id} />
            ))}

            <p className="border-t border-slate-200 pt-8 text-sm text-slate-500">
              Still have a question? The <Link href="/faq">FAQ</Link> covers why
              Baya sits alongside your existing CLIs, what it does for your bill,
              and whether parallel runs are safe.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
