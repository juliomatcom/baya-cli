'use client';

import { useEffect, useId, useRef, useState } from 'react';

type MermaidProps = {
  /** Mermaid diagram source, authored the same as in the repo's wiki and specs. */
  chart: string;
  /** Optional caption rendered under the diagram. */
  caption?: string;
};

/**
 * Renders a Mermaid diagram on the client. The site is a static export, so the
 * library is dynamically imported and the diagram is drawn in an effect after
 * hydration; until then (and if rendering throws) the raw source is shown in a
 * scrollable code block so the content is never lost.
 */
export default function Mermaid({ chart, caption }: MermaidProps) {
  const rawId = useId();
  const renderId = `mermaid-${rawId.replace(/[^a-zA-Z0-9-]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily:
            'var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif',
          themeVariables: {
            primaryColor: '#dcfce7',
            primaryBorderColor: '#16a34a',
            primaryTextColor: '#020617',
            secondaryColor: '#f1f5f9',
            tertiaryColor: '#ffffff',
            lineColor: '#64748b',
            textColor: '#1e293b',
            fontSize: '14px',
          },
        });
        const { svg: out } = await mermaid.render(renderId, chart);
        if (!cancelled) {
          setSvg(out);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [chart, renderId]);

  return (
    <figure className="my-2">
      {svg && !failed ? (
        <div
          ref={containerRef}
          className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-none"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre className="overflow-x-auto rounded-xl border border-slate-200 bg-ink p-4 text-xs leading-relaxed text-slate-200">
          <code>{chart.trim()}</code>
        </pre>
      )}
      {caption ? (
        <figcaption className="mt-2 text-sm text-slate-500">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
