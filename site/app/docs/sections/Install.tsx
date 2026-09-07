import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import { SectionHeading } from './shared';

export default function Install() {
  return (
    <section aria-labelledby="install" className="space-y-4">
      <SectionHeading id="install">Install &amp; first run</SectionHeading>
      <p className="text-slate-600">
        Requires <strong>Node 24+</strong> and at least one supported CLI on your
        machine.
      </p>
      <CopyCodeBlock code="npm install -g baya-cli" />
      <p className="text-slate-600">
        Then check what Baya can see. <code>baya doctor</code> resolves every
        provider — path, version, and capabilities — and is worth running first
        on any new machine, since provider binaries are frequently off{' '}
        <code>$PATH</code>.
      </p>
      <CopyCodeBlock code="baya doctor" />
      <p className="text-slate-600">
        On the first real run, Baya asks once which provider and model to default
        to, stores the answer in <code>~/.config/baya/config.json</code>, and
        never asks again. Change it later with <code>baya config</code>.
      </p>
      <p className="text-slate-600">
        Run <code>baya upgrade</code> any time to update every installed provider
        CLI to its latest version; <code>baya upgrade &lt;provider&gt;</code>{' '}
        narrows to one.
      </p>
      <CopyCodeBlock code="baya upgrade" />
    </section>
  );
}
