import Link from 'next/link';

const GITHUB_URL = 'https://github.com/juliomatcom/baya-cli';

type Line = { text: string; className?: string };

// A trimmed-down end-of-run report, matching the shape `baya` actually prints:
// the run header, a few completed tasks, the graded headline with token and
// cost totals, and the Flagged section.
const BODY_LINES: Line[] = [
  { text: '$ baya tasks.md', className: 'text-slate-300' },
  { text: 'Run order · 6 tasks · 3 stages', className: 'text-slate-500' },
  { text: '' },
  { text: '  ✓ design-api   codex   6 endpoints', className: 'text-slate-300' },
  { text: '  ✓ gen-schema   claude  4 tables created', className: 'text-slate-300' },
  { text: '  ✓ build-ui     codex   orders table', className: 'text-slate-300' },
  { text: '  ✓ tests        codex   14 tests pass', className: 'text-slate-300' },
  { text: '' },
];

const SUMMARY_LINES: Line[] = [
  { text: '✓ Run complete', className: 'font-bold text-accent' },
  { text: '  6 succeeded · 1m12s · 2 processes', className: 'text-slate-400' },
  { text: '  214k tokens (188k cached) · $0.37', className: 'text-slate-400' },
  { text: '' },
  { text: 'Flagged', className: 'text-slate-500' },
  { text: '  ⚑ gen-schema', className: 'text-[#eab308]' },
  { text: '    locks users ~30s at 1M+ rows', className: 'text-slate-300' },
  { text: '' },
];

export default function Hero() {
  return (
    <section className="surface-dark">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 pb-12 pt-12 md:grid-cols-2 md:gap-16 md:pb-14 md:pt-16">
        <div>
          <h1 className="text-4xl font-bold text-white sm:text-5xl">
            One command. Multiple models. No juggling.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-slate-400">
            Baya is a zero-config command-line orchestrator for AI coding agents.
            It turns a plain-text task list into a dependency graph and routes
            each task to the provider and model that fit it. Independent tasks
            run in parallel, dependent tasks wait for their prerequisites, and
            the run carries through to a report.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-6">
            <Link href="/#install" className="btn-accent">
              Get Started
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm font-medium text-white underline underline-offset-4 hover:text-white"
            >
              View on GitHub
            </a>
          </div>
        </div>

        <div className="terminal-window min-w-0">
          <div className="terminal-titlebar" aria-hidden="true">
            <span className="terminal-dot bg-[#ff5f56]" />
            <span className="terminal-dot bg-[#ffbd2e]" />
            <span className="terminal-dot bg-[#27c93f]" />
          </div>
          <pre className="terminal-body">
            <code>
              {[...BODY_LINES, ...SUMMARY_LINES].map((line, index) => (
                <span
                  key={line.text || `blank-${index}`}
                  className={`block ${line.className ?? ''}`}
                >
                  {line.text || ' '}
                </span>
              ))}
              <span className="block text-slate-300">
                ${' '}
                <span className="cursor-blink" aria-hidden="true" />
              </span>
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}
