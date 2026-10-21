#!/usr/bin/env node
// Smoke test: can we read our own Patreon feed with just a session_id?
//
// Direct to Patreon (run on your own machine, not a server):
//   SESSION_ID=xxx node scripts/smoke-test.mjs
//
// Pick a creator: add CREATOR=ddwebb (ignores case, spaces, punctuation).
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
// Patreon stores post bodies as a JSON rich-text doc (ProseMirror-style):
// { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
// Flatten it to plain text, one line per block, just to check it's there.
function jsonText(str) {
  if (!str) return "";
  let doc;
  try {
    doc = JSON.parse(str);
  } catch {
    return "";
  }
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.text === "string") out.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (/paragraph|heading|blockquote|listItem|list_item/i.test(n.type || "")) out.push("\n");
  };
  walk(doc);
  return out.join("").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
function nodeTypes(str) {
  const seen = new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type) seen.add(n.type);
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (Array.isArray(n.marks)) n.marks.forEach((m) => m.type && seen.add("mark:" + m.type));
  };
  try {
    walk(JSON.parse(str));
  } catch {}
  return [...seen];
}
const strip = (html) => (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

try {
  console.log(`Mode: ${viaProxy ? "via Worker " + base : "direct to patreon.com"}\n`);

  // 1 + 2: who am I, and what do I support.
  // The website's internal API has used several names for "creators I support";
  // try each and keep the first that yields campaigns.
  const candidates = [
    "active_memberships.campaign",
    "pledges.campaign",
    "memberships.campaign",
    "campaign_memberships.campaign",
  ];
  let me = null;
  let campaigns = [];
  let worked = null;
  for (const include of candidates) {
    try {
      const r = await api(
        "/api/current_user?" +
          qs({ include, "fields[campaign]": "name,url", "json-api-version": "1.0" })
      );
      me = me || r;
      const found = (r.included || []).filter((x) => x.type === "campaign");
      console.log(`  include=${include}: ${found.length} campaign(s)`);
      if (found.length && !worked) {
        campaigns = found;
        worked = include;
      }
    } catch (e) {
      console.log(`  include=${include}: error ${e.message.split("\n")[0]}`);
    }
  }
  if (!me) throw new Error("No /api/current_user variant worked");
  console.log(`\n✓ Session OK — logged in as ${me.data?.attributes?.full_name ?? "(name hidden)"}`);

  if (process.env.CAMPAIGN_ID) {
    campaigns = [{ id: process.env.CAMPAIGN_ID, attributes: { name: `campaign ${process.env.CAMPAIGN_ID}` } }];
    console.log(`  (using CAMPAIGN_ID=${process.env.CAMPAIGN_ID} from env)`);
  } else if (!campaigns.length) {
    console.log("! No variant returned campaigns. Relationship keys seen on the user:");
    console.log("  " + Object.keys(me.data?.relationships || {}).join(", "));
    console.log("  Workaround: rerun with CAMPAIGN_ID=<id> to test post reading (see README).");
    process.exit(0);
  } else {
    console.log(`✓ Supporting ${campaigns.length} creator(s) (via ${worked}):`);
    for (const c of campaigns) console.log(`   - ${c.attributes?.name} [${c.id}]`);
  }

  // 3: latest posts from one campaign (CREATOR=<name substring> to choose).
  const norm = (x) => (x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(process.env.CREATOR);
  let c = campaigns[0];
  if (want) {
    c = campaigns.find((x) => norm(x.attributes?.name).includes(want));
    if (!c) {
      console.error(`✗ No creator matches CREATOR=${process.env.CREATOR}`);
      process.exit(1);
    }
  }
  // No fields[post] filter: we want to see every attribute Patreon returns.
  const posts = await api(
    "/api/posts?" +
      qs({
        "filter[campaign_id]": c.id,
        "filter[contains_exclusive_posts]": "true",
        "filter[is_draft]": "false",
        sort: "-published_at",
        "page[count]": "5",
        "json-api-use-default-includes": "false",
        "json-api-version": "1.0",
      })
  );
  const list = posts.data || [];
  console.log(`\n✓ Latest ${list.length} posts from ${c.attributes?.name}:`);
  const allTypes = new Set();
  for (const p of list) {
    const a = p.attributes || {};
    const body = jsonText(a.content_json_string) || strip(a.content);
    const teaser = jsonText(a.teaser_text_json_string) || strip(a.teaser_text);
    nodeTypes(a.content_json_string).forEach((t) => allTypes.add(t));
    const status =
      a.current_user_can_view === false
        ? `LOCKED, needs ${(a.min_cents_pledged_to_view || 0) / 100}`
        : body
          ? `readable, ${body.length} chars`
          : teaser
            ? "teaser only"
            : "no text";
    const billing = a.is_automated_monthly_charge ? " [billing post]" : "";
    console.log(`   - [${status}] ${a.published_at?.slice(0, 10)} ${a.title}${billing}`);
    const preview = (body || teaser).replace(/\n/g, " / ");
    if (preview) console.log(`       ${preview.slice(0, 110)}${preview.length > 110 ? "…" : ""}`);
  }
  if (allTypes.size) console.log(`\n  Rich-text node types seen: ${[...allTypes].join(", ")}`);
  console.log("\nDone. If posts show 'readable', the whole approach works.");
} catch (err) {
  console.error("✗ " + err.message);
  process.exit(1);
}
