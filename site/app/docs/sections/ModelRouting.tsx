import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import { SectionHeading } from './shared';

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

export default function ModelRouting() {
  return (
    <section aria-labelledby="models" className="space-y-4">
      <SectionHeading id="models">Model routing</SectionHeading>
      <p className="text-slate-600">
        Name a model in the task text — <code>Use Sonnet.</code>,{' '}
        <code>run this with codex</code>, <code>Use luna.</code> — and Baya
        resolves that name against the catalog to a real provider and model id at
        the model gate. Tasks with no stated model use your configured default;
        an unset model means the provider’s own default.
      </p>
      <p className="text-slate-600">
        Model ids churn faster than the tool ships, so nothing is hard-coded.
        When a provider’s catalog is missing a model or the installed CLI rejects
        a built-in slug, add an override to{' '}
        <code>~/.config/baya/config.json</code>:
      </p>
      <CopyCodeBlock code={CONFIG_EXAMPLE} />
      <p className="text-sm text-slate-600">
        <code>modelAliases</code> maps a nickname to a real id;{' '}
        <code>modelCatalog</code> adds or replaces a catalog entry, keyed by
        provider and model id. Set an alias from the CLI with{' '}
        <code>baya config set modelAliases.cheap gpt-5.6-luna</code>, and inspect
        the effective catalog with <code>baya models</code>.
      </p>
    </section>
  );
}
