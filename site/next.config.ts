import type { NextConfig } from 'next';

// GitHub Pages serves this project from https://<user>.github.io/baya-cli/.
// Production builds therefore need the `/baya-cli` path prefix baked in, while
// `next dev` keeps serving from `/` so local development just works.
const isProd = process.env.NODE_ENV === 'production';
const basePath = isProd ? '/baya-cli' : '';

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
  basePath,
  assetPrefix: basePath,
};

export default nextConfig;
