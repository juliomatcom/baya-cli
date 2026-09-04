import type { Metadata } from 'next';
import Link from 'next/link';
import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import { GITHUB_URL, pageMetadata } from '@/app/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Docs – Baya',
  description:
    'Baya documentation: install and first run, writing task lists, per-task model routing, the run pipeline, the CLI command and flag reference, the provider support matrix, configuration, recovery and resume, and how to contribute.',
  path: '/docs',
});

const WIKI_URL = `${GITHUB_URL}/blob/main/wiki-llm`;

type Section = { id: string; label: string };

const SECTIONS: Section[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'install', label: 'Install & first run' },
  { id: 'quickstart', label: 'Quick start' },
  { id: 'task-lists', label: 'Writing task lists' },
  { id: 'models', label: 'Model routing' },
  { id: 'pipeline', label: 'How a run works' },
  { id: 'internals', label: 'Design principles' },
  { id: 'cli', label: 'CLI reference' },
  { id: 'providers', label: 'Providers' },
  { id: 'config', label: 'Configuration' },
  { id: 'recovery', label: 'Recovery & resume' },
  { id: 'contributing', label: 'Contributing' },
];

const PIPELINE = [
  {
    title: 'Task list',
    description:
      'Any UTF-8 text file — Markdown, TODO.txt, or YAML. Baya reads it for intent; the format is yours to pick. Empty or binary files are rejected before planning.',
  },
  {
    title: 'Planner',
    description:
      'An LLM CLI turns the freeform list into a JSON manifest of tasks, dependencies, and a per-task provider and permission level.',
  },
  {
    title: 'Validation',
    description:
      'The manifest is checked against the schema for cycles and dangling dependencies. One repair pass is attempted, then a deterministic linear fallback.',
  },
  {
    title: 'DAG',
    description:
      'Valid tasks are arranged into topological layers — independent work in the same layer, dependents in later ones.',
  },
  {
    title: 'Model gate',
    description:
      'Task-named models (luna, sonnet, …) are resolved against the catalog to a real provider and id. An unresolved name stops here unless --yes takes a confident match.',
  },
  {
    title: 'Preview gate',
    description:
      'The full plan — tasks, resolved models, what waits for what, what shares a process — is shown for confirmation before anything runs. --dry-run stops here.',
  },
  {
    title: 'Scheduler',
    description:
      'Walks the layers within budgets and a single write-lock: parallel read-only tasks, serialized read-write tasks.',
  },
  {
    title: 'Provider adapters',
    description:
      'Tasks that share a provider, model, permission level, and directory are grouped into one process. Adapters alone build argv, deliver the prompt, and parse events.',
  },
  {
    title: 'Results',
    description:
      'Each task returns a validated task_result envelope — ok feeds dependents over the context bus, needs_input bubbles a question, failed is classified into resumable state.',
  },
  {
    title: 'Report',
    description:
      'A final summary of task outcomes, flagged notes, token spend, and the exact command to resume unfinished work.',
  },
];

const PRINCIPLES = [
  {
    title: 'JSON on the wire, both directions',
    description:
      'Every exchange with a provider is a validated envelope, never prose. codex and claude enforce the result schema natively. A question from an agent is a status: "needs_input" field — not a question mark spotted in a stream.',
  },
  {
    title: 'The planner picks a provider, never a command',
    description:
      'Manifests carry a provider name from a closed enum; adapters alone build argv. shell: true is banned repo-wide and lint-enforced.',
  },
  {
    title: 'A process is the unit, not a task',
    description:
      'Tasks that share a provider, model, permission level, and directory go into one agent process and are worked through in order. Grouping is decided separately from the DAG shape, so a six-stage chain can still be one process.',
  },
  {
    title: 'Nothing paid-for is ever redone',
    description:
      'Progress is checkpointed before each transition. Within a run, commands that worked, commands that failed, and files already touched are derived from the providers’ own logs and handed to every later task.',
  },
  {
    title: 'Providers are watched, not trusted',
    description:
      'Their flag surfaces are live-probed and contract-tested, their output is ANSI-stripped and schema-validated before it is read or persisted.',
  },
];

const COMMANDS = [
  { name: 'baya <file>', purpose: 'Default form. Alias for run.' },
  { name: 'baya run <file>', purpose: 'Plan, resolve models, confirm, execute.' },
  {
    name: 'baya plan <file>',
    purpose: 'Plan and render the DAG; never executes. Same as run --dry-run.',
  },
  {
    name: 'baya doctor',
    purpose:
      'Resolve every provider: path, version, capabilities. Reap stray process groups.',
  },
  {
    name: 'baya config',
    purpose:
      'Re-run the setup wizard. Subactions: --show, path, set <key> <value>, refresh-models.',
  },
  {
    name: 'baya models [id]',
    purpose:
      'Print the effective model catalog grouped by provider, each row tagged built-in or user.',
  },
  {
    name: 'baya upgrade [id]',
    purpose:
      "Run each resolved provider's self-update argv; optional provider filter.",
  },
  {
    name: 'baya resume <runId>',
    purpose:
      'Re-execute a run’s unfinished tasks; succeeded tasks are kept as context. --provider <id> re-runs elsewhere.',
  },
  {
    name: 'baya runs',
    purpose:
      'List resumable runs — running, paused, failed, interrupted — newest first.',
  },
];

const FLAGS = [
  {
    flag: '--dry-run',
    meaning: 'Render the DAG with resolved models and exit. Nothing runs.',
  },
  {
    flag: '--yes',
    meaning:
      'Auto-confirm the plan gate; at the model gate take a best match ≥ 0.85. Never answers a task question.',
  },
  {
    flag: '--max-parallel <n>',
    meaning:
      'Global concurrency budget, default min(4, cpus). Per-provider caps apply on top.',
  },
  {
    flag: '--group-size <n>',
    meaning:
      'Max tasks per provider process, default 3. 1 gives every task its own process.',
  },
  {
    flag: '--no-memory',
    meaning:
      'Do not pass what earlier tasks learned. Every task starts blind — the A/B control for measuring memory.',
  },
  {
    flag: '--default-provider <id>',
    meaning:
      'Fallback provider for tasks with no stated provider. Bypasses the first-run wizard.',
  },
  {
    flag: '--planner-provider <id>',
    meaning: 'Provider that parses the task list into a manifest.',
  },
  {
    flag: '--json',
    meaning:
      'Machine-readable run report, models catalog, or runs list to stdout — always ANSI-free.',
  },
];

const PROVIDERS = [
  {
    name: 'codex',
    nonInteractive: 'codex exec',
    schema: 'file in / file out',
    status: 'Verified 2026-08-28',
  },
  {
    name: 'claude',
    nonInteractive: 'claude -p',
    schema: 'inline --json-schema',
    status: 'Verified 2026-08-28',
  },
  {
    name: 'opencode',
    nonInteractive: 'opencode run',
    schema: 'None',
    status: 'Verified 2026-08-31',
  },
  {
    name: 'copilot',
    nonInteractive: 'copilot -p',
    schema: 'None',
    status: 'Partial',
  },
  {
    name: 'gemini',
    nonInteractive: 'gemini -p',
    schema: 'None',
    status: 'Deferred to v1.1',
  },
  {
    name: 'grok',
    nonInteractive: '—',
    schema: '—',
    status: 'Planned, unprobed',
  },
];

const EXIT_CODES = [
  { code: '0', meaning: 'All tasks succeeded, or --dry-run completed.' },
  {
    code: '1',
    meaning:
      'At least one task failed, skipped, or parked; or an uncaught exception (teardown still runs).',
  },
  {
    code: '2',
    meaning: 'Planner, manifest-validation, or model-gate error; nothing executed.',
  },
  { code: '130', meaning: 'SIGINT; children torn down.' },
  { code: '143', meaning: 'SIGTERM; same teardown.' },
];

const MARKDOWN_EXAMPLE = `# Ship the orders endpoint

- Design the REST API for orders — list, get, create, and cancel.
  Define pagination, the error response shapes, and an idempotency
  key on create. Write it up as an OpenAPI document. Use Sonnet.
- Generate the Postgres schema and migrations from that design.
- Build the React table that consumes the list endpoint: sortable
  columns, a status filter, and empty and loading states. Run with codex.
- Once the schema and UI are done, write integration tests that
  exercise every endpoint against a throwaway database.`;

const TODO_EXAMPLE = `1 Design the REST API for orders (list, get, create, cancel) with pagination, error shapes, and an idempotency key on create. Use Sonnet.
2 Generate the Postgres schema and migrations from that design.
3 Build the sortable, filterable React table that consumes the list endpoint. Run with codex.
4 Once the schema and UI are done, write integration tests for every endpoint.`;

const YAML_EXAMPLE = `- id: design-api
  task: |
    Design the REST API for orders — list, get, create, cancel.
    Define pagination, error response shapes, and an idempotency
    key on create. Write it up as an OpenAPI document. Use Sonnet.
- id: gen-schema
  task: Generate the Postgres schema and migrations from that design.
  depends_on: [design-api]
- id: build-ui
  task: Build the React table that consumes the list endpoint. Run with codex.
  depends_on: [gen-schema]
- id: tests
  task: Write integration tests for every endpoint.
  depends_on: [gen-schema, build-ui]`;

const CONFIG_EXAMPLE = `{
  "modelAliases": {
    "cheap": "gpt-5.6-luna"
  },
  "modelCatalog": {
    "copilot": [
      {
        "id": "claude-sonnet-4.5",
        "aliases": ["sonnet45"],
        "description": "Anthropic Claude Sonnet 4.5"
      }
    ]
  }
}`;

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="scroll-mt-24 text-2xl font-bold text-slate-900">
      {children}
    </h2>
  );
}

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
          From install to a recovered run. This page is drawn from the project’s{' '}
          <a href={`${GITHUB_URL}#readme`} target="_blank" rel="noreferrer noopener">
            README
          </a>{' '}
          and{' '}
          <a href={WIKI_URL} target="_blank" rel="noreferrer noopener">
            wiki
          </a>
          , which stay the source of truth.
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
              {SECTIONS.map((section) => (
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
            <section aria-labelledby="overview" className="space-y-4">
              <SectionHeading id="overview">Overview</SectionHeading>
              <p className="text-slate-600">
                Baya is a zero-config command-line orchestrator for the AI coding
                agents you already have installed and authenticated. Write the
                actions in plain text and run one command: Baya turns them into a
                dependency graph, routes each task to the provider and model that
                fit it, runs independent work in parallel, and carries the run
                through to a report.
              </p>
              <p className="text-slate-600">
                There is no config format, no DSL, and no separate API key. It
                works with <code>codex</code>, <code>claude</code>,{' '}
                <code>copilot</code>, and <code>opencode</code> — use one default
                model, or name a different model or provider for a specific task.
              </p>
              <div className="card border-l-4 border-l-accent p-5 text-sm text-slate-600">
                <strong className="text-slate-900">Status: early.</strong> The
                walking skeleton, provider breadth, and most of concurrency and
                resilience have landed and are published to npm as{' '}
                <a
                  href="https://www.npmjs.com/package/baya-cli"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  baya-cli
                </a>
                . Still open: <code>--on-error stop</code>, a parallel-aware
                status line, and the recovery prompt.
              </div>
            </section>

            <section aria-labelledby="install" className="space-y-4">
              <SectionHeading id="install">Install &amp; first run</SectionHeading>
              <p className="text-slate-600">
                Requires <strong>Node 24+</strong> and at least one supported CLI
                on your machine.
              </p>
              <CopyCodeBlock code="npm install -g baya-cli" />
              <p className="text-slate-600">
                Then check what Baya can see. <code>baya doctor</code> resolves
                every provider — path, version, and capabilities — and is worth
                running first on any new machine, since provider binaries are
                frequently off <code>$PATH</code>.
              </p>
              <CopyCodeBlock code="baya doctor" />
              <p className="text-slate-600">
                On the first real run, Baya asks once which provider and model to
                default to, stores the answer in{' '}
                <code>~/.config/baya/config.json</code>, and never asks again.
                Change it later with <code>baya config</code>.
              </p>
              <p className="text-slate-600">
                Run <code>baya upgrade</code> any time to update every installed
                provider CLI to its latest version; <code>baya upgrade &lt;provider&gt;</code>{' '}
                narrows to one.
              </p>
              <CopyCodeBlock code="baya upgrade" />
            </section>

            <section aria-labelledby="quickstart" className="space-y-4">
              <SectionHeading id="quickstart">Quick start</SectionHeading>
              <p className="text-slate-600">
                Point Baya at any plain-text list of tasks. It plans, shows you
                the graph, and waits for your approval before running anything.
              </p>
              <CopyCodeBlock code="baya ./tasks.md" />
              <p className="text-slate-600">
                To see the plan without running it, use <code>baya plan</code> or{' '}
                <code>--dry-run</code>. To run unattended, review a captured
                manifest first, then execute it:
              </p>
              <CopyCodeBlock code="baya plan tasks.md --plan-out plan.json" />
              <CopyCodeBlock code="baya run tasks.md --plan-in plan.json --yes" />
            </section>

            <section aria-labelledby="task-lists" className="space-y-4">
              <SectionHeading id="task-lists">Writing task lists</SectionHeading>
              <p className="text-slate-600">
                Any UTF-8 text file works. Baya never parses these structurally —
                the planner reads every format for intent, so{' '}
                <code>depends_on:</code> and plain prose like “once the schema and
                UI are done” get you the same graph.
              </p>
              <div className="card border-l-4 border-l-accent p-5 text-sm text-slate-600">
                <strong className="text-slate-900">
                  A task is as long as it needs to be.
                </strong>{' '}
                A single item can run for several sentences and wrap across
                indented lines, spelling out constraints and acceptance criteria
                — the planner treats the whole item as one task. This site’s own
                build list is written exactly that way, one paragraph-long task
                per bullet.
              </div>

              <h3 className="pt-2 text-lg font-bold text-slate-900">Markdown</h3>
              <p className="text-sm text-slate-600">
                A heading for the goal, one bullet per task — each bullet as long
                as the task needs. Wrapped continuation lines are indented under
                the bullet.
              </p>
              <CopyCodeBlock code={MARKDOWN_EXAMPLE} />

              <h3 className="pt-2 text-lg font-bold text-slate-900">
                A bare TODO.txt
              </h3>
              <p className="text-sm text-slate-600">
                One task per line, numbered or not. The line itself can be as
                detailed as you like.
              </p>
              <CopyCodeBlock code={TODO_EXAMPLE} />

              <h3 className="pt-2 text-lg font-bold text-slate-900">YAML</h3>
              <p className="text-sm text-slate-600">
                The same intent, with explicit <code>depends_on</code> if you
                think better that way. Use a <code>|</code> block scalar for a
                multi-line <code>task:</code>.
              </p>
              <CopyCodeBlock code={YAML_EXAMPLE} />
              <p className="text-sm text-slate-500">
                If the planner can’t produce a graph, a deterministic splitter
                falls back to a linear chain in the order you wrote the tasks.
              </p>
            </section>

            <section aria-labelledby="models" className="space-y-4">
              <SectionHeading id="models">Model routing</SectionHeading>
              <p className="text-slate-600">
                Name a model in the task text — <code>Use Sonnet.</code>,{' '}
                <code>run this with codex</code>, <code>Use luna.</code> — and
                Baya resolves that name against the catalog to a real provider
                and model id at the model gate. Tasks with no stated model use
                your configured default; an unset model means the provider’s own
                default.
              </p>
              <p className="text-slate-600">
                Model ids churn faster than the tool ships, so nothing is
                hard-coded. When a provider’s catalog is missing a model or the
                installed CLI rejects a built-in slug, add an override to{' '}
                <code>~/.config/baya/config.json</code>:
              </p>
              <CopyCodeBlock code={CONFIG_EXAMPLE} />
              <p className="text-sm text-slate-600">
                <code>modelAliases</code> maps a nickname to a real id;{' '}
                <code>modelCatalog</code> adds or replaces a catalog entry, keyed
                by provider and model id. Set an alias from the CLI with{' '}
                <code>baya config set modelAliases.cheap gpt-5.6-luna</code>, and
                inspect the effective catalog with <code>baya models</code>.
              </p>
            </section>

            <section aria-labelledby="pipeline" className="space-y-4">
              <SectionHeading id="pipeline">How a run works</SectionHeading>
              <p className="text-slate-600">
                A run moves through these stages in order. The preview gate is
                the only one that stops for you.
              </p>
              <ol className="mt-2 space-y-3">
                {PIPELINE.map((stage, index) => (
                  <li key={stage.title} className="flex gap-4">
                    <span
                      className="icon-badge shrink-0 font-mono text-sm font-bold"
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    <div>
                      <h3 className="text-base font-bold text-slate-900">
                        {stage.title}
                      </h3>
                      <p className="mt-1 text-sm leading-relaxed text-slate-600">
                        {stage.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section aria-labelledby="internals" className="space-y-4">
              <SectionHeading id="internals">Design principles</SectionHeading>
              <p className="text-slate-600">
                Five ideas do most of the work. Full detail lives in the{' '}
                <a
                  href={`${WIKI_URL}/architecture.md`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  architecture
                </a>{' '}
                and{' '}
                <a
                  href={`${WIKI_URL}/protocol.md`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  protocol
                </a>{' '}
                wiki pages.
              </p>
              <dl className="space-y-5">
                {PRINCIPLES.map((principle) => (
                  <div key={principle.title}>
                    <dt className="font-semibold text-slate-900">
                      {principle.title}
                    </dt>
                    <dd className="mt-1 text-sm leading-relaxed text-slate-600">
                      {principle.description}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <section aria-labelledby="cli" className="space-y-4">
              <SectionHeading id="cli">CLI reference</SectionHeading>
              <p className="text-slate-600">
                A bare path argument is treated as <code>baya run &lt;file&gt;</code>
                . The full flag surface is in the{' '}
                <a
                  href={`${WIKI_URL}/cli.md`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  CLI wiki page
                </a>
                .
              </p>

              <h3 className="pt-2 text-lg font-bold text-slate-900">Commands</h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Baya commands and what each one does.
                  </caption>
                  <thead>
                    <tr className="border-b border-slate-300">
                      <th scope="col" className="py-2 pr-6 font-semibold">
                        Command
                      </th>
                      <th scope="col" className="py-2 font-semibold">
                        Purpose
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMMANDS.map((command) => (
                      <tr
                        key={command.name}
                        className="border-b border-slate-200 align-top"
                      >
                        <th
                          scope="row"
                          className="whitespace-nowrap py-2 pr-6 font-mono font-medium text-slate-900"
                        >
                          {command.name}
                        </th>
                        <td className="py-2 text-slate-600">{command.purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="pt-4 text-lg font-bold text-slate-900">
                Frequently used flags
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    The most common run flags and their meaning.
                  </caption>
                  <thead>
                    <tr className="border-b border-slate-300">
                      <th scope="col" className="py-2 pr-6 font-semibold">
                        Flag
                      </th>
                      <th scope="col" className="py-2 font-semibold">
                        Meaning
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {FLAGS.map((flag) => (
                      <tr
                        key={flag.flag}
                        className="border-b border-slate-200 align-top"
                      >
                        <th
                          scope="row"
                          className="whitespace-nowrap py-2 pr-6 font-mono font-medium text-slate-900"
                        >
                          {flag.flag}
                        </th>
                        <td className="py-2 text-slate-600">{flag.meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="pt-4 text-lg font-bold text-slate-900">Exit codes</h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Baya exit codes and what each one means.
                  </caption>
                  <thead>
                    <tr className="border-b border-slate-300">
                      <th scope="col" className="py-2 pr-6 font-semibold">
                        Code
                      </th>
                      <th scope="col" className="py-2 font-semibold">
                        Meaning
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {EXIT_CODES.map((row) => (
                      <tr
                        key={row.code}
                        className="border-b border-slate-200 align-top"
                      >
                        <th
                          scope="row"
                          className="py-2 pr-6 font-mono font-medium text-slate-900"
                        >
                          {row.code}
                        </th>
                        <td className="py-2 text-slate-600">{row.meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section aria-labelledby="providers" className="space-y-4">
              <SectionHeading id="providers">Providers</SectionHeading>
              <p className="text-slate-600">
                Verified by live invocation, not from documentation. “Verified”
                means a task was run end to end and returned a valid{' '}
                <code>task_result</code> — a probed flag surface is not enough.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Baya provider support: non-interactive entrypoint,
                    result-schema enforcement, and verification status.
                  </caption>
                  <thead>
                    <tr className="border-b border-slate-300">
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        Provider
                      </th>
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        Non-interactive
                      </th>
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        Schema enforcement
                      </th>
                      <th scope="col" className="py-2 font-semibold">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {PROVIDERS.map((provider) => (
                      <tr
                        key={provider.name}
                        className="border-b border-slate-200"
                      >
                        <th
                          scope="row"
                          className="py-2 pr-4 font-mono font-medium text-slate-900"
                        >
                          {provider.name}
                        </th>
                        <td className="py-2 pr-4 font-mono text-slate-600">
                          {provider.nonInteractive}
                        </td>
                        <td className="py-2 pr-4 text-slate-600">
                          {provider.schema}
                        </td>
                        <td className="py-2 text-slate-600">{provider.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-sm text-slate-600">
                A task’s permission level is what it is allowed to <em>do</em>,
                not what it edits: a <code>read-write</code> task can write, run
                commands, and reach the network; a <code>read-only</code> task
                does none of the three. <code>codex</code> is the only provider
                that enforces this with an OS sandbox — a task that must not touch
                the tree belongs there.
              </p>
              <p className="text-sm text-slate-500">
                Full flag surfaces, event shapes, and the capability matrix:{' '}
                <a
                  href={`${WIKI_URL}/providers.md`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  wiki-llm/providers.md
                </a>
                .
              </p>
            </section>

            <section aria-labelledby="config" className="space-y-4">
              <SectionHeading id="config">Configuration</SectionHeading>
              <p className="text-slate-600">
                Config is layered: built-in defaults, then{' '}
                <code>~/.config/baya/config.json</code> (written by the first-run
                wizard), then per-directory <code>.baya/config.json</code>, then
                command-line flags — each overriding the one before.
              </p>
              <ul className="ml-5 list-disc space-y-1.5 text-sm text-slate-600">
                <li>
                  <code>baya config --show</code> prints every effective value
                  and the layer it came from.
                </li>
                <li>
                  <code>baya config path</code> prints the config file location.
                </li>
                <li>
                  <code>baya config set &lt;key&gt; &lt;value&gt;</code> writes a
                  single value.
                </li>
                <li>
                  <code>baya config refresh-models</code> re-fetches the{' '}
                  <code>opencode</code> model list and prunes catalog entries
                  identical to a built-in one.
                </li>
              </ul>
              <p className="text-sm text-slate-500">
                Full precedence rules and the first-run flow:{' '}
                <a
                  href={`${WIKI_URL}/config.md`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  wiki-llm/config.md
                </a>
                .
              </p>
            </section>

            <section aria-labelledby="recovery" className="space-y-4">
              <SectionHeading id="recovery">Recovery &amp; resume</SectionHeading>
              <p className="text-slate-600">
                The run is checkpointed to <code>state.json</code> before every
                transition — a crash never loses a step. If a provider fails,
                runs out of quota, or you press Ctrl+C, the unfinished work stays
                resumable.
              </p>
              <ul className="ml-5 list-disc space-y-1.5 text-sm text-slate-600">
                <li>
                  <code>baya runs</code> lists resumable runs — running, paused,
                  failed, or interrupted — newest first.
                </li>
                <li>
                  <code>baya resume &lt;runId&gt;</code> re-runs only the
                  unfinished tasks in the run’s own directory; succeeded tasks
                  are kept as context.
                </li>
                <li>
                  <code>baya resume &lt;runId&gt; --provider claude</code> picks
                  the work up on a different provider — the answer to exhausted
                  credits.
                </li>
              </ul>
              <p className="text-sm text-slate-600">
                An unfinished run ends by printing that exact resume command,
                what it will re-run, and what to fix first. A <code>quota</code>{' '}
                failure halts the run cleanly rather than feeding the wall every
                remaining task.
              </p>
              <p className="text-sm text-slate-500">
                Failure taxonomy and the full resume contract:{' '}
                <a
                  href={`${WIKI_URL}/recovery.md`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  wiki-llm/recovery.md
                </a>
                .
              </p>
            </section>

            <section aria-labelledby="contributing" className="space-y-4">
              <SectionHeading id="contributing">Contributing</SectionHeading>
              <p className="text-slate-600">
                Contributions are welcome. The work is broken into sequenced
                tasks in{' '}
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
                A few rules are load-bearing rather than stylistic — the full
                list is in{' '}
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
                  Never regex a model’s prose for meaning — semantics come from
                  validated JSON.
                </li>
                <li>
                  Update the affected <code>wiki-llm/</code> page in the same
                  commit as the change.
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
                Adding a provider is deliberately small: one adapter, one
                capability block, one section in <code>providers.md</code>, one
                contract test. New contributors should start with{' '}
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
                <strong className="text-slate-900">Use Baya on Baya.</strong>{' '}
                Every run leaves <code>.baya/runs/&lt;runId&gt;/</code> behind —
                real provider event streams on a real repository, for free. That
                corpus is the best fixture set the project has. Mine it before
                inventing an input, then pin what you find with a committed test.
              </div>
              <p>
                <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
                  Open the repository on GitHub →
                </a>
              </p>
            </section>

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
