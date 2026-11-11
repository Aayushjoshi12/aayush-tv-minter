# azure/ — DO NOT DEPLOY

This folder is an **incomplete record** of the Azure Functions package,
kept for reference only. It must not be deployed.

Why: the live techjail minter (`src/functions/stream.js`, verbatim
from the Function App "aayush-tv-minter-kr", Korea Central) calls
`getlink.php` through **libcurl-impersonate** — the npm package
`impers` plus a bundled native binary `lib/libcurl-impersonate.so`.
That binary lives only in the deployed app package; it is not in
this repo, and deploying this folder without it would break the
techjail minter.

Decision (11 Nov 2026, user's words): "if it not working then it ok
leave for vercel only". The Premium resolver therefore runs on
**Vercel only** (see `api/resolve.js`, deployed as project
`aayush-tv-minter` on Vercel's free Hobby tier). The GitHub Actions
workflow `.github/workflows/azure-deploy.yml` is inert: it can only
deploy if the repo secret `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`
exists, and that secret was deliberately never created.

If Azure is ever revisited, the missing piece is
`lib/libcurl-impersonate.so` (matching the `impers` 0.1.3 package),
plus the `impers` dependency in `azure/package.json`. Until then,
leave this folder alone.
