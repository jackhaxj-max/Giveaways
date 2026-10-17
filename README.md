# Giveaways

This app uses a Vercel serverless function (`api/giveaways.js`) to access JSONBin. The JSONBin credentials are read only by the server function and must not be added to `index.html` or other browser files.

## Vercel setup

1. In the Vercel project, open **Settings → Environment Variables**.
2. Add `JSONBIN_BIN_ID` and `JSONBIN_MASTER_KEY` for the environments you use (Production, Preview, and/or Development).
3. Make sure the JSONBin record is initialized with an object such as `{"giveaways":{}}`.
4. Redeploy the project so the function receives the environment variables.

For local development with Vercel CLI, copy `.env.example` to `.env.local`, fill in your values locally, and run `vercel dev`. `.env.local` is ignored by Git.

## Google indexing

After deployment, add `https://passdrops.vercel.app/` as a URL-prefix property in Google Search Console, verify ownership, submit `https://passdrops.vercel.app/sitemap.xml`, and use URL Inspection to request indexing for the homepage. Metadata helps describe the page, but Google decides whether and when to index it. If the production domain changes, update the canonical URL, `robots.txt`, and `sitemap.xml` too.

## Important: rotate the exposed key

The previous frontend version included the JSONBin master key in browser JavaScript. Removing it from the current page does not remove it from existing deployments or Git history. Revoke/rotate that key in JSONBin, then add the **new** key only as `JSONBIN_MASTER_KEY` in Vercel. Do not commit the real key or send it in chat.
