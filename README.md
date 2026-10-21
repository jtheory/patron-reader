# Patron Reader

A calm, mobile-first reader for the creators you support on Patreon. Just their posts, newest first, in a reading view built for long chapters. No discovery feed, no recommendations.

- One chronological feed across all your creators, or one creator at a time
- Unread markers, and "Next chapter" at the end of each post
- Remembers exactly where you were reading, even after your phone closes the app
- Works offline for posts it has already loaded
- Light and dark themes, adjustable text size
- Installs to your home screen like an app

Personal project; not affiliated with or endorsed by Patreon. It only shows content your own account can already see.

## How it works

```
Your phone                    Your Cloudflare Worker              Patreon
Patron Reader app   ──────►   serves the app, and passes   ──────►  patreon.com/api
(session kept on              your session on to Patreon
 your device)                 (stores nothing)
```

Patreon has no official way for supporters to read posts through an app, so Patron Reader uses the same behind-the-scenes requests as the Patreon website, signed in with your own session. Browsers don't allow a web page to send those requests directly, so a tiny proxy (a free Cloudflare Worker) does it. The proxy keeps nothing: your session lives only on your phone and is sent along with each request.

## 1. Get your Patreon session

Patron Reader signs in using your **session**: the code your browser keeps to remember you're logged in to Patreon. You need to copy it once, from a computer.

> **Treat it like a password.** Anyone with it can use your Patreon account. Don't share it or post it anywhere. If it ever leaks, sign out of Patreon in that browser and it stops working.

### The easy way: Cookie-Editor (Chrome, Edge, Firefox)

1. On a computer, install the free **Cookie-Editor** browser extension from your browser's extension store (Chrome Web Store, Edge Add-ons, or Firefox Add-ons).
2. Go to [patreon.com](https://www.patreon.com) and make sure you're signed in.
3. Click the Cookie-Editor icon in the toolbar (you may need to open the puzzle-piece menu first and pin it).
4. In the list, click **session_id**.
5. Select everything in the **Value** box and copy it. That's your session.

You can uninstall the extension afterwards if you like.

### Without installing anything (developer tools)

1. On a computer, sign in at [patreon.com](https://www.patreon.com).
2. Open developer tools: press **F12** on Windows, or **⌥⌘I** on a Mac. (Safari: first turn on *Settings › Advanced › Show features for web developers*.)
3. Go to the **Application** tab (Chrome, Edge) or **Storage** tab (Firefox, Safari).
4. In the sidebar, open **Cookies › https://www.patreon.com**.
5. Find the row named **session_id** and copy its **Value**.

### Good to know

- The session keeps working until you **sign out of Patreon in that browser**. Just close the tab; don't sign out.
- If Patron Reader says Patreon didn't accept your session, repeat the steps above and paste the new one in Settings.
- Copying from a phone alone is hard: phone browsers mostly hide this. Using a computer once is the simplest route.

## 2. Set up your Worker (one time, about 10 minutes)

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, [Node.js](https://nodejs.org) on your computer, and this repository downloaded.

```sh
cd worker
npm install
npx wrangler login              # opens a browser to connect your Cloudflare account
npx wrangler secret put PROXY_KEY
```

When asked for `PROXY_KEY`, type any long random password and keep it somewhere safe. This is the **access key** the app asks for; it stops anyone else from using your Worker. (`openssl rand -hex 24` makes a good one.)

Then publish:

```sh
npm run deploy
```

Before deploying, edit `worker/wrangler.toml`: either change the `routes` hostname to a (sub)domain of a domain on your Cloudflare account, or delete the `routes` block and set `workers_dev = true` to get a free `https://patron-reader.<your-name>.workers.dev` address. The free Cloudflare plan is far more than one person needs.

Pick the final address before installing the app on your phone: your session, settings and saved posts are stored per address.

## 3. Install it on your phone

1. Set it up on your computer first: open your Worker address, paste your **Patreon session** and **access key** in Settings, and tap **Save and load feed**.
2. Still in Settings on the computer, tap **Show setup code** under *Set up another device*, and scan the QR code with your phone. It opens the app on your phone already signed in. (On Android, scan from Chrome: tap the address bar, then the camera icon, so it opens in Chrome.) Hide the code afterwards: it contains your session.

   No computer handy? Open the address on your phone and paste both values in Settings instead.
3. On your phone, add it to your home screen:
   - **iPhone (Safari):** Share button › **Add to Home Screen**.
   - **Android (Chrome):** ⋮ menu › **Install app** (or *Add to Home screen*).

Open it from the home screen icon from then on, so it runs full-screen and keeps its saved posts.

## For developers

### Layout

- `app/`: the reader itself. Plain HTML, CSS and JavaScript; no build step.
- `worker/`: the Cloudflare Worker. It serves `app/` and forwards `GET /api/*` to Patreon, adding the session cookie. It only allows `/api/*`, requires the `X-Proxy-Key` header, and stores nothing.
- `scripts/smoke-test.mjs`: checks your session works and posts are readable, without deploying anything.

### Smoke test

```sh
SESSION_ID=... node scripts/smoke-test.mjs                  # direct to Patreon
SESSION_ID=... CREATOR=ddwebb node scripts/smoke-test.mjs   # pick a creator by name
```

It reports whether your session works, which creators you support, and whether recent posts are readable or locked. To test one creator by ID, set `CAMPAIGN_ID` instead.

### Local development

```sh
cd worker
echo "PROXY_KEY=$(openssl rand -hex 24)" > .dev.vars
npm run dev       # app and proxy at http://localhost:8787
```

The service worker only registers over HTTPS, so local reloads always get fresh files.

### What Patreon returns

Discovered with the smoke test; Patreon's internal API is undocumented and may change.

- **Your creators:** `/api/current_user?include=active_memberships.campaign` (everyone you follow, free or paid). `include=pledges.campaign` gives only those you pay.
- **Posts:** `/api/posts?filter[campaign_id]=…&sort=-published_at`, paged via `links.next`.
- **Post text** is in `content_json_string`: a ProseMirror-style JSON document (`doc › paragraph › text` with `bold`/`italic` marks). `content` is usually `null`.
- **Locked posts** have `current_user_can_view: false`. **Billing placeholders** have `is_automated_monthly_charge: true` and are hidden.
