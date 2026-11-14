# aayush-bb-proxy

Bigg Boss 24/7 HLS proxy. Runs as an Azure App Service (Basic B1,
Node.js 20) in Central India (Pune) on the Azure for Students
subscription.

Why it exists: the 24/7 feeds' video pieces are locked to the
address that asks for them, and the broadcaster (Hotstar) only
allows India. A browser in Nepal cannot fetch them, in-site or
otherwise. This server sits in India: it fetches the live
playlist + the video pieces from its own Indian address (where
the session holds) and serves them back with CORS *, so the
site's own player (hls.js) can play them in-site.

## Endpoints

- `GET /bb?lang=<tamil|telugu|malayalam|kannada|hindi>` — the
  rewritten live playlist. Segment URLs point at this server's
  `/seg` endpoint.
- `GET /seg?u=<encoded zoloj /seg URL>` — one video piece (.ts),
  fetched from this server's Indian address and served with
  CORS *.
- `GET /health` — `{"ok":true}`.

## Deploy (Azure App Service, Central India)

Resource group `aayush-tv-proxy-rg`, plan `aayush-bb-plan`
(Basic B1, Linux), app `aayush-bb-proxy` (Node 20). Always On
is on. The app listens on `process.env.PORT` (set by App
Service). Deploy by zip:

```
az webapp deployment source config-zip \
  --resource-group aayush-tv-proxy-rg \
  --name aayush-bb-proxy --src app.zip
```

## Cost

- App Service Basic B1 is about $13/month, from the $100
  student credit.
- Outbound data is ~$0.087/GB after the first 15 GB/month
  free — only the video actually watched is charged.
- This server does NOT touch the techjail minter (separate
  resource group + region).
