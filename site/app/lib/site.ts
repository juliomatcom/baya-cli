/**
 * Canonical production origin. GitHub Pages serves this project from
 * https://juliomatcom.github.io/baya-cli/, so the `/baya-cli` base path is part
 * of every absolute URL. `next.config.ts` bakes the same prefix into asset and
 * link URLs for production builds; keep the two in sync.
 */
export const SITE_URL = 'https://juliomatcom.github.io/baya-cli';

export const GITHUB_URL = 'https://github.com/juliomatcom/baya-cli';

export const SITE_NAME = 'Baya';

/** One-line pitch, lifted from the README. */
export const SITE_DESCRIPTION =
  'Baya is a zero-config command-line orchestrator for the AI coding agents you already have installed and authenticated. Write the actions in plain text and run one command: Baya turns them into a dependency graph, routes each task to the provider and model that fit it, and carries the run through to a report.';

/** Default social card, served as static files from `app/`. */
export const OG_IMAGE = '/opengraph-image.png';
export const OG_IMAGE_ALT =
  'Baya — one command runs a plain-text list of coding tasks across the AI agents you already use.';

/**
 * Per-page metadata: an absolute (non-templated) title, description, canonical
 * path, and the shared Open Graph / Twitter card. A page that sets its own
 * `openGraph` object drops any inherited from the root layout — including the
 * file-convention card — so every page spells the image out here.
 */
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): import('next').Metadata {
  const image = { url: OG_IMAGE, width: 1200, height: 630, alt: OG_IMAGE_ALT };

  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      siteName: SITE_NAME,
      locale: 'en_US',
      type: 'website',
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  };
}
