# patron-reader

A calm, chronological, mobile-first reader for the creators you support on Patreon — text and images, no discovery feed, no recommendations.

Personal project; not affiliated with or endorsed by Patreon. It reads only content your own account already has access to.

## How it works

```
PWA (your phone)  ──►  Worker (stateless proxy)  ──►  patreon.com/api
 session_id in          adds Cookie + CORS,
 localStorage           stores nothing
```

Browsers can't send a `Cookie` header with `fetch`, and Patreon doesn't send CORS headers for other origins, so a tiny proxy is needed. It's stateless: the PWA sends your `session_id` per request in `X-Patreon-Session`, plus a shared `X-Proxy-Key` so nobody else can use the Worker.

## Step 1: smoke test (no deploy needed)

Get your `session_id`: log in at patreon.com on a desktop browser → DevTools → Application/Storage → Cookies → `https://www.patreon.com` → copy `session_id`.

```sh
SESSION_ID=... node scripts/smoke-test.mjs
```

It checks: the session works → which creators you support → whether the latest patron-only posts are readable.

## Step 2: run the Worker

```sh
cd worker
npm install
echo "PROXY_KEY=$(openssl rand -hex 24)" > .dev.vars
npm run dev            # local, at http://localhost:8787

# then test through it:
SESSION_ID=... PROXY_URL=http://localhost:8787 PROXY_KEY=<from .dev.vars> \
  node ../scripts/smoke-test.mjs
```

Deploy to Cloudflare (free plan is plenty):

```sh
npx wrangler login
npx wrangler secret put PROXY_KEY
npm run deploy
```

Set `ALLOWED_ORIGINS` in `worker/wrangler.toml` to your PWA's URL.

## Step 3: the PWA

`app/` — coming next.
