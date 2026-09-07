import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import { SectionHeading, WIKI_URL } from './shared';

export default function Run() {
  return (
    <section aria-labelledby="run" className="space-y-4">
      <SectionHeading id="run">Run</SectionHeading>
      <p className="text-slate-600">
        <code>baya run</code> takes a plain-text list of coding tasks and carries
        it through to a report. A model turns the list into a dependency graph; a
        scheduler walks the graph, routing each task to the provider and model
        that fit it and running independent work in parallel; each result feeds
        the tasks that depend on it.
      </p>
      <p className="text-slate-600">
        <code>baya &lt;file&gt;</code> is the default form — the same as{' '}
        <code>baya run &lt;file&gt;</code>. <code>baya plan &lt;file&gt;</code>{' '}
        stops at the preview, and <code>--plan-in</code> executes a manifest you
        captured earlier.
      </p>
      <CopyCodeBlock code={'baya ./tasks.md'} />
      <CopyCodeBlock code={'baya run tasks.md --plan-in plan.json --yes'} />
      <ul className="ml-5 list-disc space-y-1.5 text-sm text-slate-600">
        <li>
          <strong>The planner builds the graph.</strong> A model turns your list
          into a DAG of tasks and dependencies; if it cannot produce a valid one,
          a deterministic splitter falls back to a linear chain in the order you
          wrote them.
        </li>
        <li>
          <strong>Models are named in the task text</strong> —{' '}
          <code>Use Sonnet.</code>, <code>run with codex</code>. Each name
          resolves at the model gate to a real id and the provider that serves
          it; an unstated model uses your configured default.
        </li>
        <li>
          <strong>A preview gate comes first</strong> (<code>--dry-run</code> or{' '}
          <code>baya plan</code> stops there). It shows every task, its resolved
          model, what waits for what, and what shares a process, before anything
          runs.
        </li>
        <li>
          <strong>One process, many tasks.</strong> Tasks that share a provider,
          model, permission level, and directory are worked through in order in a
          single agent process, so the repo is read once. Decided separately from
          the graph — a six-step chain can still be one process.{' '}
          <code>--group-size</code> defaults to 3.
        </li>
        <li>
          <strong>Parallel, but write-safe.</strong> Independent{' '}
          <code>read-only</code> tasks run concurrently (
          <code>--max-parallel</code>, plus a per-provider cap); every{' '}
          <code>read-write</code> task takes the single writer lock and runs
          alone.
        </li>
        <li>
          <strong>Nothing paid-for is redone.</strong> A task already ticked off
          (<code>[x]</code>, <code>✅</code>) is read for context, never re-run;
          what earlier tasks discovered is handed forward to the tasks that could
          not share their process (<code>--no-memory</code> to disable).
        </li>
        <li>
          <strong>Checkpointed.</strong> State is written before every
          transition. Run out of credits mid-graph and{' '}
          <code>baya resume &lt;runId&gt;</code> picks up the unfinished work,
          optionally on a different provider; <code>baya runs</code> lists what is
          resumable.
        </li>
      </ul>
      <p className="text-sm text-slate-600">
        Everything lands in <code>.baya/runs/&lt;runId&gt;/</code> — the
        manifest, each task’s request and result, the providers’ event streams —
        and <code>state.json</code> is written before every transition, so a
        crash or Ctrl+C is a pause, not a restart. The run ends with a report:
        task outcomes, flagged notes, token spend, and the exact command to
        resume what is left.
      </p>
      <p className="text-sm text-slate-500">
        Scheduling, grouping, memory, locks, and interrupts in full:{' '}
        <a
          href={`${WIKI_URL}/execution.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          wiki-llm/execution.md
        </a>
        . The stage-by-stage flow is the{' '}
        <a href="#how-it-works">diagram further down</a>.
      </p>
    </section>
  );
}
