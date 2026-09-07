import { SectionHeading, WIKI_URL } from './shared';

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

export default function DesignPrinciples() {
  return (
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
            <dt className="font-semibold text-slate-900">{principle.title}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-slate-600">
              {principle.description}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
