import type { NextConfig } from 'next';

// The site is served from the root of its custom domain (baya-cli.depre.net),
// so there is no path prefix — assets and links resolve from `/` in both the
// production build and `next dev`.
const nextConfig: NextConfig = {
  // This site is its own project; pin the root so Turbopack doesn't walk up to
  // the parent repo's lockfile when inferring the workspace root.
  turbopack: { root: __dirname },
  // Emit a fully static site to `site/out/` for GitHub Pages.
  output: 'export',
  // GitHub Pages has no trailing-slash redirect, so emit `/route/index.html`.
  trailingSlash: true,
  // The default image loader needs a server; disable it for the static export.
  images: { unoptimized: true },
};

export default nextConfig;
