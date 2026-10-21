#!/usr/bin/env node
// Smoke test: can we read our own Patreon feed with just a session_id?
//
// Direct to Patreon (run on your own machine, not a server):
//   SESSION_ID=xxx node scripts/smoke-test.mjs
//
// Through the deployed (or `wrangler dev`) Worker:
//   SESSION_ID=xxx PROXY_URL=https://patron-reader.<you>.workers.dev \
//   PROXY_KEY=yyy node scripts/smoke-test.mjs
//
// It answers three questions, in order:
//   1. Does the session work?            (who am I)
//   2. Which creators do I support?      (memberships -> campaigns)
//   3. Can I read full patron-only posts? (latest posts + whether body is visible)

const { SESSION_ID, PROXY_URL, PROXY_KEY } = process.env;
if (!SESSION_ID) {
  console.error("Set SESSION_ID (the session_id cookie from patreon.com).");
  process.exit(1);
}
const viaProxy = Boolean(PROXY_URL);
const base = viaProxy ? PROXY_URL.replace(/\/$/, "") : "https://www.patreon.com";

async function api(path) {
  const headers = viaProxy
    ? { "X-Proxy-Key": PROXY_KEY || "", "X-Patreon-Session": SESSION_ID }
    : {
        Cookie: `session_id=${SESSION_ID}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Accept: "application/vnd.api+json, application/json",
      };
  const res = await fetch(base + path, { headers, redirect: "manual" });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok || !body) {
    const hint = /cf-chl|challenge|Just a moment/i.test(text)
      ? " (looks like a bot-protection challenge)"
      : "";
    throw new Error(`${res.status} on ${path}${hint}\n${text.slice(0, 400)}`);
  }
  return body;
}

const qs = (o) => new URLSearchParams(o).toString();
const strip = (html) => (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

try {
  console.log(`Mode: ${viaProxy ? "via Worker " + base : "direct to patreon.com"}\n`);

  // 1 + 2: who am I, and what do I support
  const me = await api(
    "/api/current_user?" +
      qs({
        include: "memberships.campaign",
        "fields[user]": "full_name",
        "fields[member]": "patron_status",
        "fields[campaign]": "name,url",
        "json-api-version": "1.0",
      })
  );
  console.log(`✓ Session OK — logged in as ${me.data?.attributes?.full_name ?? "(name hidden)"}`);

  const campaigns = (me.included || []).filter((x) => x.type === "campaign");
  if (!campaigns.length) {
    console.log("! No campaigns found in memberships; dumping keys for debugging:");
    console.log(JSON.stringify(me, null, 2).slice(0, 1500));
    process.exit(0);
  }
  console.log(`✓ Supporting ${campaigns.length} creator(s):`);
  for (const c of campaigns) console.log(`   - ${c.attributes?.name} [${c.id}]`);

  // 3: latest posts from the first campaign
  const c = campaigns[0];
  const posts = await api(
    "/api/posts?" +
      qs({
        "filter[campaign_id]": c.id,
        "filter[contains_exclusive_posts]": "true",
        "filter[is_draft]": "false",
        sort: "-published_at",
        "page[count]": "5",
        "fields[post]": "title,content,published_at,url,current_user_can_view,post_type,image",
        "json-api-use-default-includes": "false",
        "json-api-version": "1.0",
      })
  );
  console.log(`\n✓ Latest posts from ${c.attributes?.name}:`);
  for (const p of posts.data || []) {
    const a = p.attributes || {};
    const body = strip(a.content);
    const status = a.current_user_can_view === false ? "LOCKED" : body ? "readable" : "no text";
    console.log(`   - [${status}] ${a.published_at?.slice(0, 10)} ${a.title}`);
    if (body) console.log(`       ${body.slice(0, 100)}${body.length > 100 ? "…" : ""}`);
  }
  console.log("\nDone. If posts show 'readable', the whole approach works.");
} catch (err) {
  console.error("✗ " + err.message);
  process.exit(1);
}
