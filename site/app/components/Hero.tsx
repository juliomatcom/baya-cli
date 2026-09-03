import Link from 'next/link';

const GITHUB_URL = 'https://github.com/juliomatcom/baya-cli';

function GitHubIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
      className="fill-current"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

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
            <Link href="/docs#quickstart" className="btn-accent">
              Get Started
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-lg border border-white/25 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:border-white/50 hover:bg-white/5 hover:text-white"
            >
              <GitHubIcon />
              GitHub
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
