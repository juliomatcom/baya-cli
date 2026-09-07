import { SectionHeading, WIKI_URL } from './shared';

export default function Configuration() {
  return (
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
          <code>baya config --show</code> prints every effective value and the
          layer it came from.
        </li>
        <li>
          <code>baya config path</code> prints the config file location.
        </li>
        <li>
          <code>baya config set &lt;key&gt; &lt;value&gt;</code> writes a single
          value.
        </li>
        <li>
          <code>baya config refresh-models</code> re-fetches the{' '}
          <code>opencode</code> model list and prunes catalog entries identical
          to a built-in one.
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
  );
}
