/**
 * Regenerates the social card for `/ai-consensus`: a 1200x630 PNG that redraws
 * the "How the debate runs" flow (kept in sync with `CONSENSUS_DIAGRAM_SIMPLE`
 * in `app/lib/diagrams.ts`) so link previews show the diagram, not the generic
 * site card. Output is committed; rerun this after the diagram changes:
 *
 *   node scripts/generate-consensus-og.mjs
 *
 * Needs `sharp` (already present as a Next dependency) to rasterize the SVG.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'og', 'ai-consensus.png');

const W = 1200;
const H = 630;

const C = {
  accent: '#16a34a',
  accentSubtle: '#dcfce7',
  ink: '#020617',
  slateLine: '#64748b',
  slateText: '#475569',
  lightFill: '#f1f5f9',
  border: '#e2e8f0',
};

const FONT = 'Helvetica, Arial, sans-serif';

/** A rounded node with centered, vertically-middled text. */
function node(cx, y, w, h, text, { fill, stroke, fontSize = 19 } = {}) {
  const x = cx - w / 2;
  const baseline = y + h / 2 + fontSize * 0.34;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"
          fill="${fill}" stroke="${stroke}" stroke-width="2" />
    <text x="${cx}" y="${baseline}" text-anchor="middle"
          font-family="${FONT}" font-size="${fontSize}" font-weight="600"
          fill="${C.ink}">${text}</text>`;
}

function line(x1, y1, x2, y2, { marker = true } = {}) {
  return `<path d="M ${x1} ${y1} L ${x2} ${y2}" fill="none"
                stroke="${C.slateLine}" stroke-width="2"
                ${marker ? 'marker-end="url(#arrow)"' : ''} />`;
}

const green = { fill: C.accentSubtle, stroke: C.accent };
const gray = { fill: C.lightFill, stroke: C.slateLine };

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.slateLine}" />
    </marker>
  </defs>

  <rect width="${W}" height="${H}" fill="#ffffff" />
  <rect width="${W}" height="6" fill="${C.accent}" />

  <text x="64" y="70" font-family="${FONT}" font-size="20" font-weight="700"
        letter-spacing="4" fill="${C.accent}">BAYA CONSENSUS</text>
  <text x="64" y="122" font-family="${FONT}" font-size="46" font-weight="700"
        fill="${C.ink}">How the debate runs</text>
  <text x="64" y="158" font-family="${FONT}" font-size="20" fill="${C.slateText}">Several models review one artifact blind; a moderator merges the feedback each round.</text>

  ${node(600, 196, 330, 48, 'Your spec, diff, or question', gray)}
  ${line(600, 244, 600, 272)}

  ${node(600, 272, 620, 48, 'A moderator frames the review and sets the criteria', green)}
  ${line(600, 320, 435, 354)}
  ${line(600, 320, 600, 354)}
  ${line(600, 320, 765, 354)}

  ${node(435, 354, 120, 46, 'Model A', { ...green, fontSize: 18 })}
  ${node(600, 354, 120, 46, 'Model B', { ...green, fontSize: 18 })}
  ${node(765, 354, 120, 46, 'Model C', { ...green, fontSize: 18 })}
  <text x="838" y="382" font-family="${FONT}" font-size="16" fill="${C.slateLine}">blind &#183; in parallel</text>

  ${line(435, 400, 600, 430)}
  ${line(600, 400, 600, 430)}
  ${line(765, 400, 600, 430)}

  ${node(600, 430, 620, 48, 'The moderator merges the feedback into a new draft', green)}
  ${line(600, 478, 600, 508)}

  ${node(600, 508, 380, 50, 'Anything important still unresolved?', gray)}
  <text x="614" y="570" font-family="${FONT}" font-size="15" fill="${C.slateLine}">no</text>
  ${line(600, 558, 600, 574)}
  ${node(600, 574, 560, 44, 'The final version, plus the open disagreements', gray)}

  <path d="M 410 533 C 250 533, 138 516, 138 430 C 138 356, 248 377, 373 377"
        fill="none" stroke="${C.accent}" stroke-width="2"
        marker-end="url(#arrow)" />
  <text font-family="${FONT}" font-size="15" font-weight="600" fill="${C.accent}"
        text-anchor="middle" transform="translate(122, 470) rotate(-90)">yes &#8212; review the new draft</text>
</svg>`;

await mkdir(dirname(OUT), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(`wrote ${OUT}`);
