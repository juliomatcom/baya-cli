import type { Metadata } from 'next';
import Link from 'next/link';
import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import FeatureIcon, { type FeatureIconName } from '@/app/components/FeatureIcon';
import { pageMetadata } from '@/app/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Features – Baya',
  description:
    'Everything Baya does: zero-config orchestration for AI coding agents, an LLM-planned dependency graph, per-task model routing, parallel execution, process grouping, cross-task memory, a preview gate, checkpointed resume, and clean Ctrl+C teardown.',
  path: '/features',
});

type Feature = {
  icon: FeatureIconName;
  title: string;
  description: string;
};

type FeatureGroup = {
  id: string;
  label: string;
  blurb: string;
  features: Feature[];
};

const GROUPS: FeatureGroup[] = [
  {
    id: 'setup',
    label: 'Fits the setup you already have',
    blurb:
      'No API keys, no config file, no new subscription. Baya drives the coding CLIs already installed and logged in on your machine.',
    features: [
      {
        icon: 'box',
        title: 'Works out of the box',
        description:
          'Zero config. One prompt on first run for your default provider and model, stored in ~/.config/baya/config.json, then never again.',
      },
      {
        icon: 'grid',
        title: 'Multi-provider',
        description:
          'Routes each task to codex, claude, copilot, or opencode — whichever CLIs baya doctor finds installed and authenticated.',
      },
      {
        icon: 'key',
        title: 'No API keys',
        description:
          'Runs entirely under the CLI subscriptions you already pay for. Nothing new to bill, nothing new to store.',
      },
      {
        icon: 'document',
        title: 'Plain-text task lists',
        description:
          'Markdown, TODO.txt, YAML, or any UTF-8 text. No DSL, no schema — the planner reads whatever you already write for intent, whether a task is a one-liner or a paragraph of constraints.',
      },
    ],
  },
  {
    id: 'orchestration',
    label: 'Plans and coordinates the whole run',
    blurb:
      'One command turns the list into a graph, decides what runs where, and keeps independent work moving in parallel.',
    features: [
      {
        icon: 'graph',
        title: 'LLM-planned dependency graph',
        description:
          'A model turns your list into a DAG of tasks and dependencies. If it can’t produce a valid graph, a deterministic splitter falls back to a linear chain in the order you wrote them.',
      },
      {
        icon: 'tag',
        title: 'Model per task',
        description:
          'Name luna, sonnet, and friends in the task text. Baya resolves each alias to the real model id and the provider that serves it, so light steps stay cheap and hard steps get the strong model.',
      },
      {
        icon: 'parallel',
        title: 'Parallel execution',
        description:
          'Independent read-only tasks run concurrently, bounded by --max-parallel and a per-provider cap. Every read-write task takes a single writer key and runs alone, because agents sharing one tree collide on the build, not just on files.',
      },
      {
        icon: 'eye',
        title: 'Preview gate',
        description:
          'See the full plan — every task, its provider, its resolved model, what waits for what, and what shares a process — before anything runs. --dry-run shows it and stops.',
      },
    ],
  },
  {
    id: 'cost',
    label: 'Doesn’t make you pay twice',
    blurb:
      'Baya spawns as few agent processes as it can and carries forward what earlier tasks already discovered.',
    features: [
      {
        icon: 'layers',
        title: 'One process, many tasks',
        description:
          'Tasks that share a provider, model, and permission level are packed into one agent process and worked through in order, so the repo is read and oriented once instead of once per task. --group-size defaults to 3.',
      },
      {
        icon: 'recycle',
        title: 'Cross-task memory',
        description:
          'What earlier tasks found — commands that worked, commands that failed, files changed — is derived from the providers’ own logs and handed to tasks that couldn’t share a process. --no-memory to start every task blind.',
      },
      {
        icon: 'check',
        title: 'Skips what you already ticked off',
        description:
          'A task marked [x], [done], (complete), or ✅ is read for context and never planned as work, so re-running a part-finished list doesn’t re-pay for what already landed.',
      },
    ],
  },
  {
    id: 'resilience',
    label: 'Survives a failure without losing work',
    blurb:
      'The run is checkpointed before every transition, so an interruption or a spent quota is a pause, not a restart.',
    features: [
      {
        icon: 'resume',
        title: 'Checkpointed resume',
        description:
          'Run out of credits mid-graph and baya resume <runId> picks up where it stopped — optionally on a different provider. Succeeded tasks are kept as context and never re-run. baya runs lists what is resumable.',
      },
      {
        icon: 'route',
        title: 'Failures don’t cascade',
        description:
          'A failed task marks its descendants skipped, never failed — the distinction drives the exit code and the report. A quota failure halts the run cleanly instead of feeding the wall every remaining task.',
      },
      {
        icon: 'stop',
        title: 'Ctrl+C actually stops',
        description:
          'SIGTERM to every provider’s process group, a grace window, then SIGKILL; a second Ctrl+C skips the wait. Grandchildren are reaped, not orphaned, and the same path covers SIGHUP and an uncaught crash.',
      },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <main className="bg-white">
      <section className="mx-auto max-w-5xl px-6 py-16 md:py-20">
        <p className="font-mono text-sm font-semibold uppercase tracking-[0.25em] text-accent">
          Features
        </p>
        <h1 className="mt-4 text-4xl font-bold sm:text-5xl">
          One command handles the whole run
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-slate-600">
          Baya plans, routes, parallelizes, groups, hands off context, and
          recovers — coordinating the AI subscriptions and coding agents already
          on your machine. Here is everything it does, grouped by what it buys
          you.
        </p>

        <div className="mt-16 space-y-16">
          {GROUPS.map((group) => (
            <section
              key={group.id}
              aria-labelledby={group.id}
              className="border-t border-slate-200 pt-10"
            >
              <h2 id={group.id} className="text-2xl font-bold">
                {group.label}
              </h2>
              <p className="mt-3 max-w-2xl text-slate-600">{group.blurb}</p>
              <dl className="mt-10 grid gap-x-12 gap-y-10 sm:grid-cols-2">
                {group.features.map((feature) => (
                  <div key={feature.title} className="flex gap-4">
                    <span className="icon-badge shrink-0" aria-hidden="true">
                      <FeatureIcon name={feature.icon} />
                    </span>
                    <div>
                      <dt className="font-semibold text-slate-900">
                        {feature.title}
                      </dt>
                      <dd className="mt-1.5 text-sm leading-relaxed text-slate-600">
                        {feature.description}
                      </dd>
                    </div>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <section className="mt-16 border-t border-slate-200 pt-10">
          <h2 className="text-2xl font-bold">Try it on a task list</h2>
          <p className="mt-3 max-w-2xl text-slate-600">
            Install the CLI, point it at any plain-text list, and approve the
            plan.
          </p>
          <div className="mt-6 max-w-xl space-y-3">
            <CopyCodeBlock code="npm install -g baya-cli" />
            <CopyCodeBlock code="baya ./tasks.md" />
          </div>
          <p className="mt-5 text-sm text-slate-500">
            New to the format? The <Link href="/docs">docs</Link> walk through
            task lists, model routing, providers, and how a run recovers.
          </p>
        </section>
      </section>
    </main>
  );
}
