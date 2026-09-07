import { SectionHeading, WIKI_URL } from './shared';

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
  {
    name: 'baya consensus <file|"prompt">',
    purpose:
      'Several provider CLIs debate one artifact until they agree. Alias con. Not a run — invisible to runs and resume.',
  },
];

const RUN_FLAGS = [
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

const CONSENSUS_FLAGS = [
  {
    flag: '--providers <models>',
    meaning:
      'Reviewers, named by model or alias — luna,sonnet. A bare provider id means that CLI’s own default model. Defaults to your configured default model; unset with no default exits 2.',
  },
  {
    flag: '--moderator <model>',
    meaning:
      'The reconciler, named the same way. Defaults to your planner model. May also appear in --providers, in which case it reviews blind before reconciling. --moderator-model is a synonym.',
  },
  {
    flag: '--rounds <n>',
    meaning:
      'Round ceiling, not a count — the debate stops earlier when nothing blocker or major is left. Default 5.',
  },
  {
    flag: '--kind <k>',
    meaning:
      'question | plan | spec | review | idea | prompt. Skips the moderator’s classification call and fixes the access posture: plan, idea, prompt, and question run tool-less; spec and review get the workspace. question answers the artifact; prompt rewords it.',
  },
  {
    flag: '--ledger-budget <n>',
    meaning:
      'Characters of its own prior rounds carried into each reviewer’s next prompt before compaction. Default 8000.',
  },
  {
    flag: '--output <f>',
    meaning:
      'Write the final document to a file instead of stdout. The banner stays on stderr, so a piped stdout stays clean.',
  },
  {
    flag: '--no-diff',
    meaning: 'Suppress the change summary in the report.',
  },
  {
    flag: '--yes',
    meaning:
      'Auto-confirm the cost gate. A non-TTY without it exits 2 after spending only pass 0.',
  },
  {
    flag: '--tools all',
    meaning:
      'Force the full tool set regardless of the posture the moderator picked.',
  },
];

const EXIT_CODES = [
  {
    code: '0',
    meaning:
      'All tasks succeeded, or --dry-run completed. Consensus: the debate converged, or the ceiling was reached with a document.',
  },
  {
    code: '1',
    meaning:
      'A run had a task fail, skip, or park, or an uncaught exception (teardown still runs). Consensus: a reviewer or the moderator failed and no document survived.',
  },
  {
    code: '2',
    meaning:
      'A run hit a planner, manifest-validation, or model-gate error. Consensus: bad input, unknown provider, or an unresolved moderator. Nothing was executed either way.',
  },
  { code: '130', meaning: 'SIGINT; children torn down.' },
  { code: '143', meaning: 'SIGTERM; same teardown.' },
];

function FlagTable({
  caption,
  rows,
}: {
  caption: string;
  rows: { flag: string; meaning: string }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
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
          {rows.map((row) => (
            <tr key={row.flag} className="border-b border-slate-200 align-top">
              <th
                scope="row"
                className="whitespace-nowrap py-2 pr-6 font-mono font-medium text-slate-900"
              >
                {row.flag}
              </th>
              <td className="py-2 text-slate-600">{row.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CliReference() {
  return (
    <section aria-labelledby="cli" className="space-y-4">
      <SectionHeading id="cli">CLI reference</SectionHeading>
      <p className="text-slate-600">
        A bare path argument is treated as <code>baya run &lt;file&gt;</code>.
        The full flag surface is in the{' '}
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
        Frequently used run flags
      </h3>
      <FlagTable
        caption="The most common baya run flags and their meaning."
        rows={RUN_FLAGS}
      />

      <h3 className="pt-4 text-lg font-bold text-slate-900">Consensus flags</h3>
      <p className="text-sm text-slate-600">
        <code>baya consensus</code> takes its own flags below, plus the shared{' '}
        <code>--json</code>, <code>--verbose</code>, <code>--quiet</code>,{' '}
        <code>--log-level</code>, <code>--no-color</code>, and{' '}
        <code>--no-progress</code>. Full surface:{' '}
        <a
          href={`${WIKI_URL}/cli.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          wiki-llm/cli.md
        </a>
        .
      </p>
      <FlagTable
        caption="baya consensus flags and their meaning."
        rows={CONSENSUS_FLAGS}
      />

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
              <tr key={row.code} className="border-b border-slate-200 align-top">
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
  );
}
