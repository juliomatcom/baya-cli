import { SectionHeading } from './shared';

export default function Overview() {
  return (
    <section aria-labelledby="overview" className="space-y-4">
      <SectionHeading id="overview">Overview</SectionHeading>
      <p className="text-slate-600">
        Baya is a zero-config command-line orchestrator for the AI coding agents
        you already have installed and authenticated. Write the actions in plain
        text and run one command: Baya turns them into a dependency graph, routes
        each task to the provider and model that fit it, runs independent work in
        parallel, and carries the run through to a report.
      </p>
      <p className="text-slate-600">
        There is no config format, no DSL, and no separate API key. It works with{' '}
        <code>codex</code>, <code>claude</code>, <code>copilot</code>, and{' '}
        <code>opencode</code> — use one default model, or name a different model
        or provider for a specific task.
      </p>
      <div className="card border-l-4 border-l-accent p-5 text-sm text-slate-600">
        <strong className="text-slate-900">Status: early.</strong> The walking
        skeleton, provider breadth, and most of concurrency and resilience have
        landed and are published to npm as{' '}
        <a
          href="https://www.npmjs.com/package/baya-cli"
          target="_blank"
          rel="noreferrer noopener"
        >
          baya-cli
        </a>
        . Still open: <code>--on-error stop</code>, a parallel-aware status line,
        and the recovery prompt.
      </div>
    </section>
  );
}
