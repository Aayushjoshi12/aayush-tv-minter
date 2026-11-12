# Vercel notes

## 12-function limit (Hobby plan) — 12 Nov 2026

Vercel's Hobby plan allows at most **12 Serverless Functions per
deployment**. Every `.js` file under `api/` counts as one function.
On 12 Nov 2026 the modlist index chunks (7 files) + the loader +
the old moviesmod index pushed `api/` to 13 files, and every
deployment failed with "No more than 12 Serverless Functions can
be added to a Deployment on the Hobby plan" — which also broke the
live resolver (FUNCTION_INVOCATION_FAILED) until the data files
were deleted from `api/`.

Rules going forward:
- `api/` holds ONLY real function files (resolve.js,
  resolve-movie.js, resolve-azure.js, stream.js).
- Large data (the modlist index) lives in `public/` as a static
  file and is fetched at runtime by the resolver — never bundled
  or imported from `api/`.
- Never add another `.js` file to `api/` without checking the
  count first.
