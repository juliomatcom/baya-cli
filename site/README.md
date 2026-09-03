# Baya Site

Install dependencies with `npm install`.

Run the development server with `npm run dev`. Development serves from `/`.

Create a production build with `npm run build`. Build output is written to `site/out/`.
The site is served from the root of its custom domain, so there is no path prefix
in either `next dev` or the production build.

## Deployment

Pushes to `main` that touch `site/**` build and publish this site to GitHub Pages
via `.github/workflows/site.yml` (also runnable from the Actions tab via
**Run workflow**).

The public URL is <https://baya-cli.depre.net>. `public/CNAME` carries the custom
domain into every deploy so GitHub Pages keeps it across publishes.

**One-time manual step:** in the repository's **Settings → Pages**, set
**Source** to **GitHub Actions**. A workflow cannot change this setting itself,
so the first deployment will not publish until it is done.
