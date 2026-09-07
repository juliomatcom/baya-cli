import { SectionHeading, WIKI_URL } from './shared';

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

export default function Providers() {
  return (
    <section aria-labelledby="providers" className="space-y-4">
      <SectionHeading id="providers">Providers</SectionHeading>
      <p className="text-slate-600">
        Verified by live invocation, not from documentation. “Verified” means a
        task was run end to end and returned a valid <code>task_result</code> — a
        probed flag surface is not enough.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">
            Baya provider support: non-interactive entrypoint, result-schema
            enforcement, and verification status.
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
              <tr key={provider.name} className="border-b border-slate-200">
                <th
                  scope="row"
                  className="py-2 pr-4 font-mono font-medium text-slate-900"
                >
                  {provider.name}
                </th>
                <td className="py-2 pr-4 font-mono text-slate-600">
                  {provider.nonInteractive}
                </td>
                <td className="py-2 pr-4 text-slate-600">{provider.schema}</td>
                <td className="py-2 text-slate-600">{provider.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-slate-600">
        A task’s permission level is what it is allowed to <em>do</em>, not what
        it edits: a <code>read-write</code> task can write, run commands, and
        reach the network; a <code>read-only</code> task does none of the three.{' '}
        <code>codex</code> is the only provider that enforces this with an OS
        sandbox — a task that must not touch the tree belongs there.
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
  );
}
