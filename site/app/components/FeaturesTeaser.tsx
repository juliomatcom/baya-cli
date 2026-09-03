import Link from 'next/link';
import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import FeatureCard from '@/app/components/FeatureCard';
import UsageTerminal from '@/app/components/UsageTerminal';

const GITHUB_URL = 'https://github.com/juliomatcom/baya-cli';
const LICENSE_URL =
  'https://github.com/juliomatcom/baya-cli/blob/main/LICENSE';

const TEASER_CARDS = [
  {
    number: '01',
    icon: 'layers' as const,
    title: 'Multi-agent orchestration',
    description: 'Parallel task execution and process reuse.',
  },
  {
    number: '02',
    icon: 'route' as const,
    title: 'Visual dependency graph & routing',
    description:
      'Your task list becomes a dependency graph, and every task is routed to the provider and model that fit it best.',
  },
  {
    number: '03',
    icon: 'handoff' as const,
    title: 'Context & state handoff',
    description:
      'State is managed automatically, and useful findings hand off between tasks — even across different models.',
  },
];

const GOODIES = [
  {
    href: GITHUB_URL,
    external: true,
    label: 'Contribute on GitHub',
    icon: (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-hidden="true"
        focusable="false"
        className="fill-current"
      >
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    ),
  },
  {
    href: LICENSE_URL,
    external: true,
    label: 'MIT license',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12 3v18M5 7h14M7 7l-3 7a4 4 0 006 0zM17 7l-3 7a4 4 0 006 0z" />
      </svg>
    ),
  },
  {
    href: '/docs',
    external: false,
    label: 'Read the docs',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2zM8 7h8M8 11h8" />
      </svg>
    ),
  },
];

export default function FeaturesTeaser() {
  return (
    <section className="relative bg-white">
      {/*
       * Hard dark-to-white transition: the hero's near-black surface bleeds down
       * into a fixed-height band, then cuts straight to white with no gradient.
       * The dark cards start on the band and run onto the white below it.
       */}
      <div
        className="surface-dark absolute inset-x-0 top-0 h-72"
        aria-hidden="true"
      />

      <div className="relative mx-auto grid max-w-6xl gap-10 px-6 py-10 md:grid-cols-3 md:py-12">
        <div className="md:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            What you get
          </h2>

          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {TEASER_CARDS.map((card) => (
              <FeatureCard key={card.title} {...card} />
            ))}
          </div>

          <p className="mt-6">
            <Link
              href="/features"
              className="text-sm font-semibold text-accent"
            >
              See all features →
            </Link>
          </p>

          <div className="mt-12">
            <UsageTerminal />
          </div>
        </div>

        <aside className="card h-fit p-6">
          <div id="install">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
              Install
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              Node 24+ and one supported CLI. Then:
            </p>
            <div className="mt-3">
              <CopyCodeBlock code="npm install -g baya-cli" wrap={false} />
            </div>
          </div>

          <div className="mt-8">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
              Open-source goodies
            </h3>
            <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
              {GOODIES.map((row) => {
                const inner = (
                  <>
                    <span className="text-accent">{row.icon}</span>
                    <span>{row.label}</span>
                    <span aria-hidden="true" className="ml-auto text-slate-400">
                      →
                    </span>
                  </>
                );
                return (
                  <li key={row.label}>
                    {row.external ? (
                      <a
                        href={row.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex items-center gap-3 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:no-underline"
                      >
                        {inner}
                      </a>
                    ) : (
                      <Link
                        href={row.href}
                        className="flex items-center gap-3 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:no-underline"
                      >
                        {inner}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </section>
  );
}
