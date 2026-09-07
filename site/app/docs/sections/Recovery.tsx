import { SectionHeading, WIKI_URL } from './shared';

export default function Recovery() {
  return (
    <section aria-labelledby="recovery" className="space-y-4">
      <SectionHeading id="recovery">Recovery &amp; resume</SectionHeading>
      <p className="text-slate-600">
        The run is checkpointed to <code>state.json</code> before every
        transition — a crash never loses a step. If a provider fails, runs out of
        quota, or you press Ctrl+C, the unfinished work stays resumable.
      </p>
      <ul className="ml-5 list-disc space-y-1.5 text-sm text-slate-600">
        <li>
          <code>baya runs</code> lists resumable runs — running, paused, failed,
          or interrupted — newest first.
        </li>
        <li>
          <code>baya resume &lt;runId&gt;</code> re-runs only the unfinished
          tasks in the run’s own directory; succeeded tasks are kept as context.
        </li>
        <li>
          <code>baya resume &lt;runId&gt; --provider claude</code> picks the work
          up on a different provider — the answer to exhausted credits.
        </li>
      </ul>
      <p className="text-sm text-slate-600">
        An unfinished run ends by printing that exact resume command, what it
        will re-run, and what to fix first. A <code>quota</code> failure halts
        the run cleanly rather than feeding the wall every remaining task.
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
  );
}
