import Link from 'next/link';

const GITHUB_URL = 'https://github.com/juliomatcom/baya-cli';

type Line = { text: string; className?: string };

// A trimmed-down end-of-run report, matching the shape `baya` actually prints:
// the run header, a few completed tasks, the graded headline with token and
// cost totals, and the Flagged section.
const BODY_LINES: Line[] = [
  { text: '$ baya build-site.md', className: 'text-slate-300' },
  { text: 'Run order · 18 tasks · 9 stages', className: 'text-slate-500' },
  { text: '' },
  { text: '  ✓ scaffold-site  luna    project scaffolded', className: 'text-slate-300' },
  { text: '  ✓ visual-base    sonnet  dark hero, green accent', className: 'text-slate-300' },
  { text: '  ✓ docs-page      sonnet  sidebar from the wiki', className: 'text-slate-300' },
  { text: '  ✓ seo-pass       sonnet  sitemap, robots, JSON-LD', className: 'text-slate-300' },
  { text: '  · 14 more', className: 'text-slate-500' },
  { text: '' },
];

const SUMMARY_LINES: Line[] = [
  { text: '✓ Run complete', className: 'font-bold text-accent' },
  { text: '  18 succeeded · 112m57s · 7 processes', className: 'text-slate-400' },
  { text: '  21.5M tokens (20.6M cached) · $3.98', className: 'text-slate-400' },
  { text: '' },
  { text: 'Flagged', className: 'text-slate-500' },
  { text: '  ⚑ add-pages-workflow', className: 'text-[#eab308]' },
  { text: '    enable GitHub Pages — I cannot', className: 'text-slate-300' },
  { text: '' },
];

export default function Hero() {
  return (
    <section className="surface-dark">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 pb-20 pt-12 md:grid-cols-2 md:gap-16 md:pb-28 md:pt-16">
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
