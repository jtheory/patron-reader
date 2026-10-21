import { webSpeechEngine, Listener } from "./listen.js";

// Patron Reader — a quiet feed of the creators you support on Patreon.
// No build step, no dependencies. Data flow:
//   settings (localStorage) → api() via the Worker proxy → IndexedDB cache → views.

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  session: "",       // Patreon session_id cookie value
  key: "",           // X-Proxy-Key for the Worker
  base: "",          // proxy origin; "" = same origin as this app
  hideLocked: true,
  paidOnly: false,
  theme: "auto",
  size: 1.1875,      // reader font size, rem
  rate: 1,           // listening speed
  voice: "",         // voice id; "" = device default
};
const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem("pr." + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("pr." + k, JSON.stringify(v));
    } catch {}
  },
};
let settings = { ...DEFAULTS, ...LS.get("settings", {}) };
const saveSettings = () => LS.set("settings", settings);

let readSet = LS.get("read", {});        // postId -> 1
let progress = LS.get("progress", {});   // postId -> { pct, i, f } (see readerSpot)
const pctOf = (id) => (typeof progress[id] === "number" ? progress[id] : progress[id]?.pct) || 0;

function applyLook() {
  const root = document.documentElement;
  if (settings.theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);
  root.style.setProperty("--reader-size", settings.size + "rem");
}

// ---------------------------------------------------------------- storage

const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open("patron-reader", 1);
  req.onupgradeneeded = () => {
    const d = req.result;
    d.createObjectStore("posts", { keyPath: "id" });   // metadata, small
    d.createObjectStore("bodies");                       // id -> rich-text JSON / HTML
    d.createObjectStore("meta");                         // creators, cursors, lastSync
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
function idb(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}
const getMeta = (k) => idb("meta", "readonly", (s) => s.get(k));
const setMeta = (k, v) => idb("meta", "readwrite", (s) => s.put(v, k));
const allPosts = () => idb("posts", "readonly", (s) => s.getAll());
const getPost = (id) => idb("posts", "readonly", (s) => s.get(id));
const getBody = (id) => idb("bodies", "readonly", (s) => s.get(id));

// Patreon has no "unlocked on" date, so detect it ourselves: a post we saved
// as locked that now comes back readable was unlocked just now. It jumps to
// the top of the feed (sorted by unlock time) and counts as unread again.
async function mergeAndSave(items) {
  const now = new Date().toISOString();
  for (const it of items) {
    const old = await getPost(it.meta.id);
    if (old?.unlockedAt) it.meta.unlockedAt = old.unlockedAt;
    else if (old && !old.canView && it.meta.canView) {
      it.meta.unlockedAt = now;
      delete readSet[it.meta.id];
      LS.set("read", readSet);
    }
  }
  await savePosts(items);
}
const sortKey = (p) => p.unlockedAt || p.published || "";

async function savePosts(items) {
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["posts", "bodies"], "readwrite");
    for (const { meta, body } of items) {
      tx.objectStore("posts").put(meta);
      if (body) tx.objectStore("bodies").put(body, meta.id);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------- api

class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;  // "setup" | "key" | "session" | "blocked" | "network" | "upstream"
  }
}

const qs = (o) => new URLSearchParams(o).toString();

async function api(path) {
  if (!settings.session || !settings.key) throw new ApiError("setup", "Add your Patreon session and access key in Settings.");
  let res;
  try {
    res = await fetch(settings.base.replace(/\/$/, "") + path, {
      headers: { "X-Proxy-Key": settings.key, "X-Patreon-Session": settings.session },
    });
  } catch {
    throw new ApiError("network", "Can't reach the proxy. Check your connection.");
  }
  const upstream = res.headers.get("X-Upstream-Status");
  if (res.status === 401 && !upstream) throw new ApiError("key", "The proxy rejected the access key. Check it in Settings.");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (/Just a moment|cf-chl|challenge/i.test(text)) throw new ApiError("blocked", "Patreon's bot check blocked the request. Try again in a few minutes.");
    if (res.status === 401 || res.status === 403) throw new ApiError("session", "Patreon didn't accept your session. Paste a fresh session_id in Settings.");
    throw new ApiError("upstream", `Patreon returned an error (${res.status}).`);
  }
  return res.json();
}

const POST_FIELDS = [
  "title", "content", "content_json_string", "teaser_text_json_string", "published_at",
  "url", "current_user_can_view", "is_automated_monthly_charge", "post_type", "image",
  "min_cents_pledged_to_view",
].join(",");

function postsPath(campaignId) {
  return "/api/posts?" + qs({
    "filter[campaign_id]": campaignId,
    "filter[contains_exclusive_posts]": "true",
    "filter[is_draft]": "false",
    sort: "-published_at",
    "page[count]": "10",
    "fields[post]": POST_FIELDS,
    "json-api-use-default-includes": "false",
    "json-api-version": "1.0",
  });
}

// Patreon's "next" links are absolute; we only want the path for the proxy.
const toPath = (u) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return null;
  }
};

function shapePost(p, campaignId) {
  const a = p.attributes || {};
  const body = a.content_json_string || a.content || "";
  return {
    meta: {
      id: p.id,
      campaignId,
      title: a.title || "Untitled",
      published: a.published_at,
      url: a.url,
      canView: a.current_user_can_view !== false,
      billing: !!a.is_automated_monthly_charge,
      type: a.post_type,
      image: a.image?.large_url || a.image?.url || null,
      words: countWords(body),
      teaser: a.teaser_text_json_string || null,
    },
    body: body ? { kind: a.content_json_string ? "json" : "html", data: body } : null,
  };
}

async function fetchCreators() {
  const include = (rel) =>
    api("/api/current_user?" + qs({ include: rel, "fields[campaign]": "name,url", "json-api-version": "1.0" }));
  const [all, paid] = await Promise.all([include("active_memberships.campaign"), include("pledges.campaign")]);
  const camps = (r) => (r.included || []).filter((x) => x.type === "campaign");
  const paidIds = new Set(camps(paid).map((c) => c.id));
  const byId = new Map();
  for (const c of [...camps(all), ...camps(paid)]) {
    byId.set(c.id, { id: c.id, name: c.attributes?.name || "Unknown", url: c.attributes?.url, paid: paidIds.has(c.id) });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function pool(items, n, fn) {
  const queue = [...items];
  const errors = [];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await fn(item);
        } catch (e) {
          errors.push(e);
        }
      }
    })
  );
  return errors;
}

let syncing = null;
function sync() {
  syncing ||= doSync().finally(() => {
    syncing = null;
    setSpinning(false);
  });
  return syncing;
}

async function doSync() {
  setSpinning(true);
  const firstRun = !(await getMeta("lastSync"));
  const creators = await fetchCreators();
  await setMeta("creators", creators);
  const cursors = (await getMeta("cursors")) || {};
  const errors = await pool(creators, 4, async (c) => {
    const r = await api(postsPath(c.id));
    const items = (r.data || []).map((p) => shapePost(p, c.id));
    await mergeAndSave(items);
    // Keep the oldest page's cursor; a refresh only fetches the newest page.
    if (!(c.id in cursors)) cursors[c.id] = toPath(r.links?.next) || null;
    if (firstRun) {
      // Don't greet a new install with 150 unread posts: older ones start as read.
      const weekAgo = Date.now() - 7 * 864e5;
      for (const { meta } of items) if (Date.parse(meta.published) < weekAgo) readSet[meta.id] = 1;
    }
    if (route().name === "feed") render();
  });
  await setMeta("cursors", cursors);
  await setMeta("lastSync", Date.now());
  if (firstRun) LS.set("read", readSet);
  if (errors.length) throw errors[0];
}

async function loadMore(campaignId) {
  const cursors = (await getMeta("cursors")) || {};
  const next = cursors[campaignId];
  if (!next) return false;
  const r = await api(next);
  await mergeAndSave((r.data || []).map((p) => shapePost(p, campaignId)));
  cursors[campaignId] = toPath(r.links?.next) || null;
  await setMeta("cursors", cursors);
  return true;
}

// ---------------------------------------------------------------- rich text

// Patreon post bodies are a ProseMirror-style JSON doc. Build DOM nodes
// directly (never innerHTML) so nothing in a post can run script.
const BLOCKS = {
  paragraph: "p", heading: "h", blockquote: "blockquote",
  bulletList: "ul", bullet_list: "ul", orderedList: "ol", ordered_list: "ol",
  listItem: "li", list_item: "li", horizontalRule: "hr", horizontal_rule: "hr",
  hardBreak: "br", hard_break: "br", codeBlock: "pre", code_block: "pre",
  table: "table", tableRow: "tr", table_row: "tr", tableCell: "td", table_cell: "td",
  tableHeader: "th", table_header: "th",
};
const MARKS = { bold: "strong", strong: "strong", italic: "em", em: "em", underline: "u", strike: "s", strikethrough: "s", code: "code" };

const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);

function renderNode(n) {
  if (!n || typeof n !== "object") return document.createTextNode("");
  if (n.type === "text") {
    let node = document.createTextNode(n.text || "");
    for (const m of n.marks || []) {
      let wrap;
      if (m.type === "link") {
        const href = safeUrl(m.attrs?.href);
        if (!href) continue;
        wrap = document.createElement("a");
        wrap.href = href;
        wrap.target = "_blank";
        wrap.rel = "noopener noreferrer";
      } else if (MARKS[m.type]) {
        wrap = document.createElement(MARKS[m.type]);
      } else continue;
      wrap.append(node);
      node = wrap;
    }
    return node;
  }
  const src = safeUrl(n.attrs?.src);
  if (src && /image/i.test(n.type || "")) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = n.attrs?.alt || "";
    img.loading = "lazy";
    return img;
  }
  let tag = BLOCKS[n.type] || (n.type === "doc" ? null : "div");
  if (tag === "h") tag = "h" + Math.min(4, Math.max(2, (n.attrs?.level || 2) + 1));
  const el = tag ? document.createElement(tag) : document.createDocumentFragment();
  for (const child of n.content || []) el.append(renderNode(child));
  return el;
}

// Fallback for posts that only have HTML: copy over an allow-list of tags.
const ALLOWED = new Set("P BR EM STRONG I B U S A H1 H2 H3 H4 BLOCKQUOTE UL OL LI HR IMG FIGURE FIGCAPTION".split(" "));
function renderHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const copy = (src, dest) => {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) dest.append(n.textContent);
      else if (n.nodeType === 1) {
        if (!ALLOWED.has(n.tagName)) {
          copy(n, dest);
          continue;
        }
        const el = document.createElement(n.tagName === "H1" ? "h2" : n.tagName);
        if (n.tagName === "A" && safeUrl(n.getAttribute("href"))) {
          el.href = n.getAttribute("href");
          el.target = "_blank";
          el.rel = "noopener noreferrer";
        }
        if (n.tagName === "IMG") {
          const s = safeUrl(n.getAttribute("src"));
          if (!s) continue;
          el.src = s;
          el.loading = "lazy";
          el.alt = n.getAttribute("alt") || "";
        }
        copy(n, el);
        dest.append(el);
      }
    }
  };
  const frag = document.createDocumentFragment();
  copy(doc.body, frag);
  return frag;
}

function renderBody(body) {
  if (!body) return null;
  if (body.kind === "json") {
    try {
      return renderNode(JSON.parse(body.data));
    } catch {
      return null;
    }
  }
  return renderHtml(body.data);
}

function countWords(s) {
  if (!s) return 0;
  // Works for both JSON and HTML well enough for a reading-time estimate.
  const text = s.replace(/"(type|marks|attrs|content|text|level|href)"\s*:/g, " ").replace(/<[^>]+>|[{}\[\]",:]/g, " ");
  return (text.match(/[\p{L}\p{N}’']+/gu) || []).length;
}

// ---------------------------------------------------------------- ui helpers

const $ = (id) => document.getElementById(id);
const view = $("view");

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
  return el;
}

function setSpinning(on) {
  $("refresh").classList.toggle("spinning", on);
}

let statusTimer;
function showStatus(msg, { error = false, sticky = false } = {}) {
  const s = $("status");
  clearTimeout(statusTimer);
  if (!msg) {
    s.hidden = true;
    return;
  }
  s.textContent = msg;
  s.classList.toggle("error", error);
  s.hidden = false;
  if (!sticky) statusTimer = setTimeout(() => (s.hidden = true), 4000);
}

// Brief, self-dismissing note at the bottom (errors use the status line instead).
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("toast");
  clearTimeout(toastTimer);
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    toastTimer = setTimeout(() => (t.hidden = true), 300);
  }, ms);
}

function handleError(e) {
  console.error(e);
  const msg = e instanceof ApiError ? e.message : "Something went wrong while loading. Try refreshing.";
  showStatus(msg, { error: true, sticky: true });
  if (e.kind === "setup") location.hash = "#/settings";
}

const LOCK_SVG = '<svg class="lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const lockIcon = () => {
  const t = document.createElement("template");
  t.innerHTML = LOCK_SVG;
  return t.content.firstChild;
};

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const opts = { weekday: "long", day: "numeric", month: "long" };
  if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const minutes = (w) => Math.max(1, Math.round(w / 250));

// ---------------------------------------------------------------- routing

function route() {
  const [, name, arg] = location.hash.match(/^#\/(\w+)?\/?(.*)$/) || [];
  if (name === "p") return { name: "post", id: arg };
  if (name === "c") return { name: "feed", creator: arg };
  if (name === "settings") return { name: "settings" };
  return { name: "feed", creator: null };
}

const scrollMemory = new Map();
let lastHash = location.hash;

// Which top-bar pieces each screen gets.
function setBar(r) {
  const show = {
    home: r.name === "post",
    back: r.name === "feed" && !!r.creator,
    "bar-author": r.name === "post",
    refresh: r.name !== "settings",
    "settings-link": r.name === "feed" && !r.creator,
    close: r.name === "settings",
  };
  for (const [id, on] of Object.entries(show)) $(id).hidden = !on;
  $("bar").classList.toggle("bar-post", r.name === "post");
}

async function render() {
  const r = route();
  setBar(r);
  if (r.name !== "post") hideControls();
  if (r.name === "settings") return renderSettings();
  if (r.name === "post") return renderPost(r.id);
  return renderFeed(r.creator);
}

addEventListener("hashchange", () => {
  if (takeConnectLink()) {
    render();
    return;
  }
  scrollMemory.set(lastHash, scrollY);
  if (listening && location.hash !== "#/p/" + listening.postId) stopListening();
  if (lastHash.startsWith("#/p/")) {
    const id = lastHash.slice(4);
    const spot = progress[id];
    // readerSpot() would now read the new view, so this was saved on scroll already.
    if (!spot) progress[id] = { i: 0, f: 0, pct: 0 };
  }
  lastHash = location.hash;
  render().then(() => {
    const r = route();
    if (r.name === "feed") scrollTo(0, scrollMemory.get(location.hash) || 0);
    saveSpot();
  });
});

// ---------------------------------------------------------------- feed view

let lastFeedKey = "";

async function renderFeed(creatorId) {
  const creators = (await getMeta("creators")) || [];
  const byId = new Map(creators.map((c) => [c.id, c]));
  const creator = creatorId ? byId.get(creatorId) : null;
  $("bar-title").textContent = creator ? creator.name : "Patron Reader";
  $("back").setAttribute("href", "#/");

  let posts = (await allPosts()).filter((p) => !p.billing && byId.has(p.campaignId));
  if (settings.paidOnly) posts = posts.filter((p) => byId.get(p.campaignId)?.paid);
  if (settings.hideLocked) posts = posts.filter((p) => p.canView);
  const unreadBy = {};
  for (const p of posts) if (!readSet[p.id] && p.canView) unreadBy[p.campaignId] = (unreadBy[p.campaignId] || 0) + 1;
  if (creator) posts = posts.filter((p) => p.campaignId === creator.id);
  posts.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

  // Avoid rebuilding (and losing scroll) when a background sync changes nothing visible.
  const key = JSON.stringify([creatorId, posts.map((p) => p.id + (readSet[p.id] ? "r" : "")), unreadBy, settings.paidOnly]);
  if (key === lastFeedKey && view.dataset.view === "feed") return;
  lastFeedKey = key;
  view.dataset.view = "feed";

  const visibleCreators = creators.filter((c) => !settings.paidOnly || c.paid);
  const filters = h(
    "nav",
    { class: "filters", "aria-label": "Creators" },
    h("a", { class: "chip", href: "#/", "aria-current": String(!creator) }, "All"),
    visibleCreators.map((c) =>
      h(
        "a",
        { class: "chip", href: "#/c/" + c.id, "aria-current": String(creator?.id === c.id) },
        c.name,
        unreadBy[c.id] ? h("span", { class: "count", "aria-label": unreadBy[c.id] + " unread" }, String(unreadBy[c.id])) : null
      )
    )
  );

  const body = [];
  if (!creators.length) {
    body.push(h("p", { class: "empty" }, settings.session ? "Loading your creators…" : "Add your Patreon session in Settings to load your feed."));
  } else if (!posts.length) {
    body.push(h("p", { class: "empty" }, creator ? "No posts from this creator yet." : "No posts yet. Pull them in with the refresh button."));
  }
  let currentDay = null;
  let list = null;
  for (const p of posts) {
    const day = dayLabel(sortKey(p));
    if (day !== currentDay) {
      currentDay = day;
      body.push(h("h2", { class: "day" }, day));
      list = h("ul", { class: "posts" });
      body.push(list);
    }
    const unread = p.canView && !readSet[p.id];
    const prog = pctOf(p.id);
    const fresh = p.unlockedAt ? "Unlocked" : "";
    const len = p.words > 40 ? minutes(p.words) + " min" : "";
    const right = !p.canView
      ? "Locked"
      : prog > 0.02 && prog < 0.95
        ? h("span", { class: "progress" }, Math.round(prog * 100) + "% read")
        : [fresh, len].filter(Boolean).join(", ");
    list.append(
      h(
        "li",
        { class: "post-row" + (unread ? " unread" : "") + (p.canView ? "" : " locked") },
        h(
          "a",
          { href: "#/p/" + p.id },
          h("span", { class: "post-title" }, p.canView ? null : lockIcon(), p.title),
          h("span", { class: "post-meta" }, h("span", {}, creator ? "" : byId.get(p.campaignId)?.name), h("span", {}, right))
        )
      )
    );
  }
  if (creator) {
    const cursors = (await getMeta("cursors")) || {};
    if (cursors[creator.id]) {
      body.push(
        h("button", {
          class: "more",
          onclick: async (ev) => {
            ev.target.disabled = true;
            ev.target.textContent = "Loading…";
            try {
              await loadMore(creator.id);
            } catch (e) {
              handleError(e);
            }
            lastFeedKey = "";
            const y = scrollY;
            await render();
            scrollTo(0, y);
          },
        }, "Load older posts")
      );
    }
  }
  view.replaceChildren(filters, ...body);
  const active = filters.querySelector('[aria-current="true"]');
  if (active && creator) active.scrollIntoView({ inline: "center", block: "nearest" });
}

// ---------------------------------------------------------------- post view

let current = null; // { post, listenable } for the chapter on screen

async function renderPost(id) {
  view.dataset.view = "post";
  current = null;
  lastFeedKey = "";
  const p = await getPost(id);
  if (!p) {
    view.replaceChildren(h("p", { class: "empty" }, "This post isn't in your library. ", h("a", { href: "#/" }, "Back to the feed")));
    return;
  }
  const creators = (await getMeta("creators")) || [];
  const creator = creators.find((c) => c.id === p.campaignId);
  $("bar-author").textContent = creator?.name || "";
  $("bar-author").setAttribute("href", "#/c/" + p.campaignId);
  $("bar-title").textContent = p.title;

  const article = h("article", { class: "reader" });
  article.append(
    h("a", { class: "running-head", href: "#/c/" + p.campaignId }, creator?.name || ""),
    h("h1", {}, p.title),
    h("p", { class: "dateline" }, fmtDate(p.published) + (p.unlockedAt ? `, unlocked ${fmtDate(p.unlockedAt)}` : "") + (p.words > 40 && p.canView ? `, ${minutes(p.words)} min read` : ""))
  );

  const bodyEl = h("div", { class: "body" });
  if (p.image && p.canView) bodyEl.append(h("img", { class: "cover", src: p.image, alt: "", loading: "lazy" }));
  if (p.canView) {
    const content = renderBody(await getBody(id));
    if (content) bodyEl.append(content);
    else if (!p.image) bodyEl.append(h("p", { class: "locked-note" }, "This post has no text. It may be a video or attachment; open it on Patreon to see it."));
  } else {
    const teaser = p.teaser ? renderBody({ kind: "json", data: p.teaser }) : null;
    if (teaser) bodyEl.append(teaser);
    bodyEl.append(h("p", { class: "locked-note" }, "Your current tier doesn't include this post."));
  }
  article.append(bodyEl);

  // Next / previous chapter: neighbours from the same creator, by date.
  const siblings = (await allPosts())
    .filter((x) => x.campaignId === p.campaignId && !x.billing)
    .sort((a, b) => (a.published || "").localeCompare(b.published || ""));
  const i = siblings.findIndex((x) => x.id === p.id);
  const newer = siblings.slice(i + 1).find((x) => x.canView);
  const older = siblings.slice(0, i).reverse().find((x) => x.canView);

  article.append(
    h(
      "footer",
      { class: "reader-end" },
      newer ? h("a", { class: "next", href: "#/p/" + newer.id }, "Next: " + newer.title) : h("a", { href: "#/" }, "Back to the feed"),
      older ? h("a", { href: "#/p/" + older.id }, "Previous") : null,
      p.url ? h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, "Comments on Patreon") : null
    )
  );
  current = {
    post: p,
    listenable: !!(speech && p.canView && bodyEl.querySelector(".body > p, .body > blockquote, .body > h2, .body > h3, .body > ul, .body > ol")),
  };
  view.replaceChildren(article);
  article.addEventListener("click", (e) => {
    if (e.target.closest("a, button, input, select")) return;
    if (String(getSelection()).length) return; // selecting text, not tapping
    toggleControls();
  });
  if (listening && listening.postId === p.id) attachListening();

  if (p.canView && !readSet[id]) {
    readSet[id] = 1;
    LS.set("read", readSet);
  }

  // Resume where you left off: back to the saved paragraph, or the top.
  const saved = progress[id];
  restoreReader(typeof saved === "object" && saved.pct < 0.97 ? saved : null);
}

// ---------------------------------------------------------------- listening

const speech = webSpeechEngine();
let listening = null;     // { postId, listener }
let wakeLock = null;

const blockEls = () => [...(view.querySelector(".body")?.children || [])];

function startListening(p, index) {
  stopListening();
  const listener = new Listener(speech, {
    onIndex: (i) => highlight(i),
    onState: (st) => {
      updatePlayer();
      if (st === "playing") keepAwake();
      else releaseWake();
      if (st === "stopped" && listening?.listener === listener) clearHighlight();
    },
    // Stop at the end of the post. (No auto-continue: a creator's next post
    // isn't necessarily the next chapter of the same story.)
    onFinish: () => stopListening(),
  });
  listener.rate = settings.rate;
  listener.voice = settings.voice;
  listening = { postId: p.id, title: p.title, listener };
  listener.start(blockEls().map((el) => (el.tagName === "IMG" || el.tagName === "HR" ? "" : el.textContent)), index);
}

// Re-render of the same post while listening: point the highlight at the new DOM.
function attachListening() {
  highlight(listening.listener.index, false);
  updatePlayer();
}

function stopListening() {
  if (!listening) return;
  const l = listening.listener;
  listening = null;
  l.stop();
  clearHighlight();
  updatePlayer();
}

function clearHighlight() {
  view.querySelectorAll(".speaking").forEach((el) => el.classList.remove("speaking"));
}

function highlight(i, follow = true) {
  clearHighlight();
  const el = blockEls()[i];
  if (!el) return;
  el.classList.add("speaking");
  // Listening moves the bookmark too, so reading picks up where listening left off.
  if (listening) {
    const max = document.documentElement.scrollHeight - innerHeight;
    progress[listening.postId] = { i, f: 0, pct: max > 0 ? +(el.offsetTop / max).toFixed(3) : 0 };
    LS.set("progress", progress);
  }
  if (!follow) return;
  const r = el.getBoundingClientRect();
  const bottom = controlsOpen() ? $("controls").getBoundingClientRect().height : 0;
  if (r.top < barHeight() || r.bottom > innerHeight - bottom) {
    pinUntil = 0;
    scrollTo({ top: r.top + scrollY - barHeight() - 16, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}

async function keepAwake() {
  try {
    if (!wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    }
  } catch {}
}
function releaseWake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

addEventListener("visibilitychange", () => {
  if (!listening) return;
  if (document.visibilityState === "hidden") {
    // Speech gets cut off in the background: hold our place at the start of
    // this paragraph so coming back replays it rather than skipping ahead.
    listening.listener.suspend();
    return;
  }
  if (listening.listener.state === "playing") keepAwake();
  setTimeout(() => listening?.listener.nudge(), 400);
});

const RATES = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2, 2.25, 2.5, 3];
const rateLabel = (r) => (Number.isInteger(r) ? r + ".0" : String(r)) + "×";
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';

const listeningHere = () => listening && current && listening.postId === current.post.id;
const isPlaying = () => listeningHere() && listening.listener.state === "playing";

// Right-edge buttons: only once listening has started in this chapter.
function updatePlayer() {
  const on = listeningHere() && listening.listener.state !== "stopped";
  $("audio").hidden = !on;
  document.body.classList.toggle("has-audio", on);
  if (on) {
    $("au-toggle").innerHTML = isPlaying() ? PAUSE_SVG : PLAY_SVG;
    $("au-toggle").setAttribute("aria-label", isPlaying() ? "Pause" : "Play");
  }
  updateControls();
}

$("au-toggle").addEventListener("click", () => listening?.listener.toggle());
$("au-prev").addEventListener("click", () => listening?.listener.jump(-1));
$("au-next").addEventListener("click", () => listening?.listener.jump(1));

// ---------------------------------------------------------------- tap controls
//
// In a chapter, a tap (not a scroll, not on a link) slides up a bar with
// play/pause, speed and text size. It hides after a few seconds, or on scroll.

let controlsTimer;
let controlsHold = 0; // ignore scrolls we cause ourselves (keeping place on resize)
const controlsOpen = () => $("controls").classList.contains("open");

function updateControls() {
  const canPlay = !!current?.listenable;
  $("ct-play").hidden = !canPlay;
  $("ct-play").innerHTML = (isPlaying() ? PAUSE_SVG : PLAY_SVG) + `<span>${isPlaying() ? "Pause" : "Listen"}</span>`;
  $("ct-rate").textContent = rateLabel(settings.rate);
  $("ct-slower").disabled = settings.rate <= RATES[0];
  $("ct-faster").disabled = settings.rate >= RATES.at(-1);
}

function showControls() {
  updateControls();
  const c = $("controls");
  c.classList.add("open");
  c.setAttribute("aria-hidden", "false");
  document.body.classList.add("has-controls");
  armControlsHide();
}
function hideControls() {
  clearTimeout(controlsTimer);
  const c = $("controls");
  c.classList.remove("open");
  c.setAttribute("aria-hidden", "true");
  document.body.classList.remove("has-controls");
}
function toggleControls() {
  controlsOpen() ? hideControls() : showControls();
}
function armControlsHide() {
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(hideControls, 4000);
}

$("ct-play").addEventListener("click", () => {
  if (!current) return;
  if (listeningHere()) listening.listener.toggle();
  else startListening(current.post, readerSpot()?.i || 0);
  hideControls();
});
const stepRate = (dir) => {
  const i = RATES.findIndex((r) => r >= settings.rate - 1e-9);
  settings.rate = RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? RATES.length - 1 : i) + dir))];
  saveSettings();
  listening?.listener.setRate(settings.rate);
  updateControls();
  armControlsHide();
};
$("ct-slower").addEventListener("click", () => stepRate(-1));
$("ct-faster").addEventListener("click", () => stepRate(1));
const stepSize = (delta) => {
  const spot = readerSpot(); // keep the same paragraph at the top while text reflows
  settings.size = Math.min(1.6, Math.max(0.95, +(settings.size + delta).toFixed(4)));
  saveSettings();
  applyLook();
  controlsHold = Date.now() + 500;
  if (spot) scrollToSpot(spot);
  armControlsHide();
};
$("ct-smaller").addEventListener("click", () => stepSize(-0.0625));
$("ct-larger").addEventListener("click", () => stepSize(0.0625));

addEventListener("scroll", () => {
  if (controlsOpen() && Date.now() > pinUntil && Date.now() > controlsHold) hideControls();
}, { passive: true });

// ---------------------------------------------------------------- position memory
//
// iOS often kills a backgrounded PWA; relaunching opens the start URL at the top.
// So we keep saving "where am I" (screen + position) and restore it on launch.
// In a chapter, the position is anchored to a paragraph (index + fraction into it)
// rather than pixels, so it survives font-size changes and images loading above.

const barHeight = () => $("bar").getBoundingClientRect().height;

function readerSpot() {
  const blocks = view.querySelector(".body")?.children;
  if (!blocks) return null;
  const top = barHeight() + 8;
  const max = document.documentElement.scrollHeight - innerHeight;
  const pct = max > 0 ? +(scrollY / max).toFixed(3) : 0;
  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect();
    if (r.bottom > top) return { i, f: r.height ? +Math.max(0, (top - r.top) / r.height).toFixed(3) : 0, pct };
  }
  return { i: blocks.length - 1, f: 1, pct };
}

function scrollToSpot(spot) {
  const el = view.querySelector(".body")?.children[spot.i];
  if (!el) return;
  const r = el.getBoundingClientRect();
  scrollTo(0, r.top + scrollY - barHeight() - 8 + spot.f * r.height);
}

let pinUntil = 0;
function restoreReader(spot) {
  if (!spot) {
    scrollTo(0, 0);
    return;
  }
  scrollToSpot(spot);
  // Images above the spot may load late and push text down; keep re-pinning
  // for a few seconds, unless the reader starts scrolling themselves.
  pinUntil = Date.now() + 4000;
  const repin = () => Date.now() < pinUntil && scrollToSpot(spot);
  for (const img of view.querySelectorAll(".body img")) if (!img.complete) img.addEventListener("load", repin, { once: true });
  requestAnimationFrame(repin);
  document.fonts?.ready.then(repin);
}
for (const ev of ["touchstart", "wheel", "keydown"]) addEventListener(ev, () => (pinUntil = 0), { passive: true });

function saveSpot() {
  const r = route();
  const here = { hash: location.hash || "#/", at: Date.now() };
  if (r.name === "post") {
    // While a restore is still settling, keep the saved spot rather than re-measuring.
    const spot = Date.now() < pinUntil ? progress[r.id] : readerSpot();
    if (spot) {
      progress[r.id] = spot;
      LS.set("progress", progress);
      here.spot = spot;
    }
  } else {
    here.y = scrollY;
  }
  LS.set("here", here);
}

let saveTimer;
addEventListener("scroll", () => {
  if (Date.now() < pinUntil) return; // don't save while we're still restoring
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSpot, 250);
}, { passive: true });
// Save immediately when the app is backgrounded; it may never come back to life.
addEventListener("visibilitychange", () => document.visibilityState === "hidden" && saveSpot());
addEventListener("pagehide", saveSpot);

// ---------------------------------------------------------------- settings view

function renderSettings() {
  view.dataset.view = "settings";
  lastFeedKey = "";
  $("bar-title").textContent = "Settings";

  const session = h("input", { id: "f-session", type: "password", autocomplete: "off", spellcheck: "false", value: settings.session });
  const key = h("input", { id: "f-key", type: "password", autocomplete: "off", spellcheck: "false", value: settings.key });
  const paidOnly = h("input", { id: "f-paid", type: "checkbox", checked: settings.paidOnly });
  const hideLocked = h("input", { id: "f-locked", type: "checkbox", checked: settings.hideLocked });
  const voice = h("select", { id: "f-voice" }, h("option", { value: "" }, "Device default"));
  const fillVoices = () => {
    const list = (speech?.voices() || []).slice().sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    const lang = (navigator.language || "en").slice(0, 2);
    // Voices in the device language first; others are rarely wanted.
    const mine = list.filter((v) => v.lang.toLowerCase().startsWith(lang));
    voice.replaceChildren(
      h("option", { value: "" }, "Device default"),
      ...(mine.length ? mine : list).map((v) => h("option", { value: v.id, selected: v.id === settings.voice }, `${v.name} (${v.lang})`))
    );
  };
  fillVoices();
  speech?.onVoicesChanged(fillVoices);
  const theme = h(
    "select",
    { id: "f-theme" },
    [["auto", "Match device"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => h("option", { value: v, selected: settings.theme === v }, l))
  );

  // Every change saves straight away. A new session or key also reloads the feed.
  const save = () => {
    const newSession = session.value.trim().replace(/^session_id=/, "").replace(/;.*$/, "");
    const newKey = key.value.trim();
    const changedAuth = newSession !== settings.session || newKey !== settings.key;
    Object.assign(settings, {
      session: newSession,
      key: newKey,
      paidOnly: paidOnly.checked,
      hideLocked: hideLocked.checked,
      theme: theme.value,
      voice: voice.value,
    });
    saveSettings();
    applyLook();
    lastFeedKey = "";
    if (changedAuth && settings.session && settings.key) {
      toast("Saved. Loading your feed…");
      sync().then(() => toast("Feed loaded."), handleError);
    }
  };
  let typing;
  for (const el of [session, key]) {
    el.addEventListener("input", () => {
      clearTimeout(typing);
      typing = setTimeout(save, 700);
    });
    el.addEventListener("change", () => {
      clearTimeout(typing);
      save();
    });
  }
  for (const el of [paidOnly, hideLocked, theme, voice]) el.addEventListener("change", save);

  const form = h(
    "form",
    { class: "settings", onsubmit: (ev) => ev.preventDefault() },
    h("h2", {}, "Connect to Patreon"),
    h("p", { class: "lede" }, "Both values stay on this device. They're sent only to your own proxy, which passes the session on to Patreon."),
    h(
      "div",
      { class: "field" },
      h("label", { for: "f-session" }, "Patreon session"),
      session,
      h(
        "details",
        {},
        h("summary", {}, "Where to find it"),
        h(
          "ol",
          {},
          h("li", {}, "Sign in at patreon.com in a desktop browser."),
          h("li", {}, "Open developer tools, then Application (Chrome) or Storage (Firefox, Safari)."),
          h("li", {}, "Under Cookies › https://www.patreon.com, copy the value of session_id."),
          h("li", {}, "It lasts until you sign out of Patreon on that browser.")
        )
      )
    ),
    h(
      "div",
      { class: "field" },
      h("label", { for: "f-key" }, "Access key"),
      key,
      h("p", { class: "hint" }, "The PROXY_KEY you set on your Cloudflare Worker.")
    ),
    h("div", { class: "field" }, h("label", { class: "check" }, paidOnly, h("span", {}, "Only show creators I pay"))),
    h("div", { class: "field" }, h("label", { class: "check" }, hideLocked, h("span", {}, "Hide posts my tier doesn't include"))),
    h("div", { class: "field" }, h("label", { for: "f-theme" }, "Appearance"), theme),
    speech
      ? h("div", { class: "field" }, h("label", { for: "f-voice" }, "Listening voice"), voice,
          h("p", { class: "hint" }, "More voices: Android Settings › Accessibility › Text-to-speech output."))
      : null,
    settings.session ? signOutButton() : null
  );
  // A new device most likely wants to scan; one that's set up offers its code.
  if (settings.session && settings.key) view.replaceChildren(form, deviceSection());
  else view.replaceChildren(receiveSection(), form);
}

function signOutButton() {
  let armed = 0;
  const btn = h("button", { class: "secondary danger", type: "button" }, "Sign out on this device");
  btn.addEventListener("click", async () => {
    if (Date.now() - armed > 4000) {
      armed = Date.now();
      btn.textContent = "Tap again to sign out";
      setTimeout(() => Date.now() - armed >= 4000 && (btn.textContent = "Sign out on this device"), 4100);
      return;
    }
    stopListening();
    for (const store of ["posts", "bodies", "meta"]) await idb(store, "readwrite", (st) => st.clear());
    for (const k of Object.keys(localStorage)) if (k.startsWith("pr.")) localStorage.removeItem(k);
    location.replace(location.pathname + "#/settings");
    location.reload();
  });
  return btn;
}

// ---------------------------------------------------------------- set up another device
//
// A QR code (or link) carrying the session and access key, so a phone can be
// set up by scanning instead of typing. They ride in the #fragment, which
// browsers never send to a server; the app reads it, saves it, and wipes it
// from the address bar straight away.

const b64url = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

function connectLink() {
  const payload = b64url(JSON.stringify({ v: 1, s: settings.session, k: settings.key, b: settings.base || undefined }));
  return location.origin + location.pathname + "#/connect/" + payload;
}

// Accepts a full setup link (or just its payload); returns true if it was applied.
function applySetup(text) {
  const m = String(text).trim().match(/(?:#\/connect\/)?([\w-]{8,})\s*$/);
  try {
    const d = JSON.parse(unb64url(m[1]));
    if (!d.s || !d.k) throw new Error("incomplete");
    const changed = d.s !== settings.session || d.k !== settings.key;
    Object.assign(settings, { session: d.s, key: d.k, base: d.b || "" });
    saveSettings();
    showStatus(null);
    toast("This device is set up. Loading your feed…");
    if (changed) sync().then(() => toast("Feed loaded."), handleError);
    return true;
  } catch {
    showStatus("That setup code is damaged. Show a fresh code on your other device and try again.", { error: true, sticky: true });
    return false;
  }
}

function takeConnectLink() {
  if (!/^#\/connect\//.test(location.hash)) return false;
  const link = location.hash;
  history.replaceState(null, "", "#/");
  lastHash = "#/";
  applySetup(link);
  return true;
}

// Scan a setup code with this device's camera, so it lands in *this* browser
// (opening a scanned link would go to the default browser instead).
async function scanSetupCode(area) {
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const video = h("video", { class: "scanner", playsinline: true, muted: true });
  const cancel = h("button", { class: "secondary", type: "button" }, "Cancel");
  area.replaceChildren(video, h("p", { class: "hint" }, "Point the camera at the setup code on your other device."), cancel);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch {
    area.replaceChildren(h("p", { class: "warn" }, "The camera isn't available. Allow camera access for this site, or paste the setup link below."));
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  video.scrollIntoView({ block: "center", behavior: "smooth" });
  let done = false;
  const stop = () => {
    done = true;
    stream.getTracks().forEach((t) => t.stop());
    area.replaceChildren();
  };
  cancel.addEventListener("click", stop);
  addEventListener("hashchange", stop, { once: true });
  while (!done) {
    try {
      const codes = await detector.detect(video);
      const hit = codes.find((c) => /#\/connect\//.test(c.rawValue));
      if (hit) {
        stop();
        if (applySetup(hit.rawValue)) location.hash = "#/";
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
}

function receiveSection() {
  const area = h("div", { class: "scan-area" });
  const paste = h("input", { id: "f-setup", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "Paste a setup link" });
  const canScan = "BarcodeDetector" in window && navigator.mediaDevices?.getUserMedia;
  return h(
    "section",
    { class: "device" },
    h("h2", {}, "Copy setup from another device"),
    h("p", { class: "lede" }, "On a device that's already set up, open Settings and tap Show setup code. Then scan it from here."),
    canScan
      ? h("button", { class: "secondary", type: "button", onclick: () => scanSetupCode(area) }, "Scan setup code")
      : h("p", { class: "hint" }, "This browser can't scan codes. Paste the setup link instead."),
    area,
    h(
      "div",
      { class: "field paste-row" },
      h("label", { for: "f-setup" }, "Or paste a setup link"),
      paste,
      h("button", {
        class: "secondary",
        type: "button",
        onclick: () => {
          if (paste.value.trim() && applySetup(paste.value)) location.hash = "#/";
        },
      }, "Use link")
    )
  );
}

async function qrSvg(text) {
  const { qrMatrix } = await import("./vendor/qrcode.js");
  const q = qrMatrix(text, "L");
  const pad = 4;
  const n = q.size + pad * 2;
  let d = "";
  for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Setup QR code");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", n);
  bg.setAttribute("height", n);
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return svg;
}

function deviceSection() {
  const box = h("div", { class: "qr-box", hidden: true });
  const toggle = h("button", { class: "secondary", type: "button" }, "Show setup code");
  let shown = false;
  toggle.addEventListener("click", async () => {
    shown = !shown;
    if (shown) {
      const link = connectLink();
      const copy = h("button", { class: "secondary", type: "button" }, "Copy setup link");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(link);
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Couldn't copy";
        }
      });
      box.replaceChildren(
        await qrSvg(link),
        h("p", { class: "hint" }, "On your phone, open this site in the browser you'll use it from, go to Settings, and tap Scan setup code."),
        h("p", { class: "warn" }, "This code contains your Patreon session: anyone who scans it can use your account. Hide it once your phone is set up."),
        copy
      );
      box.hidden = false;
      toggle.textContent = "Hide setup code";
      // Don't leave it on screen if you walk away.
      setTimeout(() => shown && toggle.click(), 2 * 60 * 1000);
    } else {
      box.replaceChildren();
      box.hidden = true;
      toggle.textContent = "Show setup code";
    }
  });
  return h(
    "section",
    { class: "device" },
    h("h2", {}, "Set up another device"),
    h("p", { class: "lede" }, "Show a code here and scan it with your phone to copy your session and access key across."),
    toggle,
    box
  );
}

// ---------------------------------------------------------------- start

function refreshNow() {
  showStatus(null);
  return sync().then(() => toast("Up to date."), handleError);
}
$("refresh").addEventListener("click", refreshNow);

// Coming back to the app after a while also refreshes.
const STALE = 10 * 60 * 1000;
async function refreshIfStale() {
  if (!settings.session || !settings.key) return;
  if (Date.now() - ((await getMeta("lastSync")) || 0) > STALE) sync().catch(handleError);
}
addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshIfStale());

// Pull down at the top of the feed to refresh.
{
  const ptr = $("ptr");
  const THRESHOLD = 70;
  let startY = null;
  let pull = 0;
  const reset = () => {
    startY = null;
    pull = 0;
    ptr.style.transform = "";
    ptr.classList.remove("ready", "pulling");
  };
  addEventListener("touchstart", (e) => {
    if (view.dataset.view === "feed" && scrollY <= 0 && !syncing) startY = e.touches[0].clientY;
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (startY == null) return;
    pull = Math.max(0, e.touches[0].clientY - startY);
    if (pull <= 0 || scrollY > 0) return;
    const d = Math.min(pull * 0.5, THRESHOLD * 0.9);
    ptr.classList.add("pulling");
    ptr.classList.toggle("ready", pull * 0.5 >= THRESHOLD * 0.75);
    ptr.style.transform = `translate(-50%, ${d}px) rotate(${pull * 2}deg)`;
  }, { passive: true });
  addEventListener("touchend", () => {
    if (startY == null) return;
    const go = ptr.classList.contains("ready");
    reset();
    if (go) refreshNow();
  });
  addEventListener("touchcancel", reset);
}

applyLook();
takeConnectLink();

// Cold launch (opened at the start URL): go back to where we were.
const here = LS.get("here", null);
const coldLaunch = !location.hash || location.hash === "#/" || location.hash === "#";
if (coldLaunch && here?.hash && here.hash !== "#/" && settings.session) {
  history.replaceState(null, "", here.hash);
  lastHash = location.hash;
}
await render();
if (here && here.hash === (location.hash || "#/") && route().name !== "post" && here.y) {
  requestAnimationFrame(() => scrollTo(0, here.y));
}

if (settings.session && settings.key) refreshIfStale();
else if (route().name !== "settings") location.hash = "#/settings";

// "App updated": fingerprint our own code; if it changed since last launch, say so.
(async () => {
  try {
    const parts = await Promise.all(["app.js", "listen.js", "style.css", "index.html"].map((f) => fetch(f, { cache: "no-cache" }).then((r) => r.text())));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
    const build = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    const seen = LS.get("build", null);
    if (seen && seen !== build) toast("App updated.");
    LS.set("build", build);
  } catch {}
})();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
