# Short Studio

An Apple-inspired URL shortener prototype with a real backend, Vercel serverless entrypoint, optional Redis persistence, redirects, and analytics.

## Local Run

```powershell
npm start
```

If PowerShell blocks `npm.ps1`, use:

```powershell
npm.cmd start
```

Then open:

```text
http://localhost:4173
```

## What Works

- Create short links with generated or custom aliases.
- Redirect from `/:slug` to the original URL.
- Persist links in `data/links.json`.
- Track clicks, referrers, user agents, and last-click timestamps.
- Archive links from the dashboard.
- Search the link library.
- Set optional expiration dates.
- Copy and open generated short links.

## API

```text
GET    /api/links
POST   /api/shorten
GET    /api/stats/:slug
DELETE /api/links/:slug
GET    /:slug
```

The server intentionally uses only Node built-ins so the prototype can run without installing packages.

## Deploy To GitHub

```powershell
git init
git add .
git commit -m "Initial Short Studio prototype"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/apple-url-shortener.git
git push -u origin main
```

## Deploy To Vercel

Import the GitHub repository in Vercel. The project is configured with `vercel.json`, so Vercel will serve static files from `public/` and send API, health, and short-link routes to `api/index.js`.

Recommended settings:

```text
Framework Preset: Other
Build Command: npm run vercel-build
Output Directory: public
Install Command: npm install
```

The app deploys without environment variables. For durable production persistence, add an Upstash Redis database through Vercel Marketplace or Upstash, then set:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
SHORT_STUDIO_REDIS_KEY
```

Without Redis variables, Vercel uses in-memory serverless storage. That is fine for previews and demos, but links can reset when a serverless instance goes cold.
