import Link from 'next/link';

const GITHUB_URL = 'https://github.com/juliomatcom/baya-cli';

const TERMINAL_LINES = [
  { text: '$ baya my-tasks.md', tone: 'prompt' as const },
  { text: 'Run order · 3 tasks · 2 stages', tone: 'muted' as const },
  {
    text: '✓ design-api    codex     4.2s   Designed the orders REST API',
    tone: 'default' as const,
  },
  {
    text: '✓ db-schema     claude    6.9s   Generated the schema from that design',
    tone: 'default' as const,
  },
  {
    text: '✓ integration   codex    12.4s   Wrote integration tests for the endpoint',
    tone: 'default' as const,
  },
  { text: '', tone: 'default' as const },
];

export default function Hero() {
  return (
    <section className="surface-dark">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-12 md:grid-cols-2 md:gap-16 md:pb-28 md:pt-16">
        <div>
          <h1 className="text-4xl font-bold text-white sm:text-5xl">
            One command. Multiple models. No juggling.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-slate-400">
            Baya is a zero-config command-line orchestrator that turns a plain-text
            task list into a dependency graph and routes each task to the provider
            and model that fit it. Independent tasks run in parallel, dependent
            tasks wait for their prerequisites, and the run carries through to a
            report.
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

        <div className="terminal-window">
          <div className="terminal-titlebar" aria-hidden="true">
            <span className="terminal-dot bg-[#ff5f56]" />
            <span className="terminal-dot bg-[#ffbd2e]" />
            <span className="terminal-dot bg-[#27c93f]" />
          </div>
          <pre className="terminal-body">
            <code>
              {TERMINAL_LINES.map((line) => (
                <span
                  key={line.text || 'blank'}
                  className={
                    line.tone === 'muted'
                      ? 'block text-slate-500'
                      : line.tone === 'prompt'
                        ? 'block text-slate-300'
                        : 'block'
                  }
                >
                  {line.text || ' '}
                </span>
              ))}
              <span className="block">
                Final summary:{' '}
                <span className="text-accent">Successful</span>
              </span>
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
