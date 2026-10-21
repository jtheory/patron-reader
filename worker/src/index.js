// patron-reader proxy: a stateless Cloudflare Worker.
//
// The browser can't call patreon.com directly (no Cookie header allowed on
// fetch, and Patreon sends no CORS headers for our origin). This Worker:
//   1. checks a shared secret so only your app can use it,
//   2. takes your Patreon session_id from a request header,
//   3. forwards GET /api/... to www.patreon.com with that cookie,
//   4. returns the response with CORS headers added.
// Nothing is stored here; the session_id lives only on your device.

// env.UPSTREAM can point at a mock server for local testing.
const UPSTREAM = "https://www.patreon.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = origin && allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-Proxy-Key, X-Patreon-Session",
    "Access-Control-Expose-Headers": "X-Upstream-Status",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Constant-time-ish comparison so the key can't be guessed byte by byte.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request.headers.get("Origin"));

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === "/health") {
      return json(200, { ok: true }, cors);
    }
    if (request.method !== "GET") {
      return json(405, { error: "GET only" }, cors);
    }
    // Only Patreon's JSON API is reachable through this proxy.
    if (!url.pathname.startsWith("/api/")) {
      return json(404, { error: "Only /api/* is proxied" }, cors);
    }
    if (!env.PROXY_KEY || !safeEqual(request.headers.get("X-Proxy-Key"), env.PROXY_KEY)) {
      return json(401, { error: "Bad or missing X-Proxy-Key" }, cors);
    }
    const session = request.headers.get("X-Patreon-Session");
    if (!session || !/^[A-Za-z0-9_\-.%]+$/.test(session)) {
      return json(400, { error: "Missing or malformed X-Patreon-Session" }, cors);
    }

    const upstream = await fetch((env.UPSTREAM || UPSTREAM) + url.pathname + url.search, {
      method: "GET",
      headers: {
        Cookie: `session_id=${session}`,
        "User-Agent": env.USER_AGENT || DEFAULT_UA,
        Accept: "application/vnd.api+json, application/json",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.patreon.com/home",
      },
      redirect: "manual",
    });

    // Pass the body through untouched; only add CORS and a debug hint.
    const headers = new Headers(cors);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    headers.set("Cache-Control", "no-store");
    headers.set("X-Upstream-Status", String(upstream.status));
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
