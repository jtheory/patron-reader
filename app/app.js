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

async function render() {
  const r = route();
  $("back").hidden = r.name === "feed" && !r.creator;
  $("refresh").hidden = r.name === "settings";
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

async function renderPost(id) {
  view.dataset.view = "post";
  lastFeedKey = "";
  const p = await getPost(id);
  if (!p) {
    view.replaceChildren(h("p", { class: "empty" }, "This post isn't in your library. ", h("a", { href: "#/" }, "Back to the feed")));
    return;
  }
  const creators = (await getMeta("creators")) || [];
  const creator = creators.find((c) => c.id === p.campaignId);
  $("bar-title").textContent = "";
  $("back").setAttribute("href", "#/c/" + p.campaignId);
  $("back").textContent = "‹ " + (creator?.name || "Feed");

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

  const sizeBtn = (label, delta, name) =>
    h("button", {
      "aria-label": name,
      onclick: () => {
        settings.size = Math.min(1.6, Math.max(0.95, +(settings.size + delta).toFixed(4)));
        saveSettings();
        applyLook();
      },
    }, label);

  article.append(
    h(
      "footer",
      { class: "reader-end" },
      newer ? h("a", { class: "next", href: "#/p/" + newer.id }, "Next: " + newer.title) : h("a", { href: "#/" }, "Back to the feed"),
      older ? h("a", { href: "#/p/" + older.id }, "Previous") : null,
      p.url ? h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, "Comments on Patreon") : null,
      h("span", { class: "size-controls", role: "group", "aria-label": "Text size" }, sizeBtn("A−", -0.0625, "Smaller text"), sizeBtn("A+", 0.0625, "Larger text"))
    )
  );
  view.replaceChildren(article);

  if (p.canView && !readSet[id]) {
    readSet[id] = 1;
    LS.set("read", readSet);
  }

  // Resume where you left off: back to the saved paragraph, or the top.
  const saved = progress[id];
  restoreReader(typeof saved === "object" && saved.pct < 0.97 ? saved : null);
}

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
  $("back").setAttribute("href", "#/");
  $("back").textContent = "‹ Feed";

  const session = h("input", { id: "f-session", type: "password", autocomplete: "off", spellcheck: "false", value: settings.session });
  const key = h("input", { id: "f-key", type: "password", autocomplete: "off", spellcheck: "false", value: settings.key });
  const base = h("input", { id: "f-base", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "Same as this page", value: settings.base });
  const paidOnly = h("input", { id: "f-paid", type: "checkbox", checked: settings.paidOnly });
  const hideLocked = h("input", { id: "f-locked", type: "checkbox", checked: settings.hideLocked });
  const theme = h(
    "select",
    { id: "f-theme" },
    [["auto", "Match device"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => h("option", { value: v, selected: settings.theme === v }, l))
  );
  const err = h("p", { class: "form-error", role: "alert", hidden: true });

  const form = h(
    "form",
    {
      class: "settings",
      onsubmit: async (ev) => {
        ev.preventDefault();
        const newSession = session.value.trim().replace(/^session_id=/, "").replace(/;.*$/, "");
        const changedAuth = newSession !== settings.session || key.value.trim() !== settings.key;
        Object.assign(settings, {
          session: newSession,
          key: key.value.trim(),
          base: base.value.trim(),
          paidOnly: paidOnly.checked,
          hideLocked: hideLocked.checked,
          theme: theme.value,
        });
        saveSettings();
        applyLook();
        if (!settings.session || !settings.key) {
          err.textContent = "Both the Patreon session and the access key are needed to load your feed.";
          err.hidden = false;
          return;
        }
        showStatus(null);
        location.hash = "#/";
        if (changedAuth) sync().catch(handleError);
      },
    },
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
    h(
      "details",
      { class: "field" },
      h("summary", {}, "Advanced"),
      h("div", { class: "field", style: "margin-top:.75rem" }, h("label", { for: "f-base" }, "Proxy address"), base, h("p", { class: "hint" }, "Only needed if the proxy runs somewhere other than this page."))
    ),
    h("button", { class: "primary", type: "submit" }, "Save and load feed"),
    h(
      "button",
      {
        class: "secondary",
        type: "button",
        onclick: async () => {
          await idb("posts", "readwrite", (s) => s.clear());
          await idb("bodies", "readwrite", (s) => s.clear());
          await idb("meta", "readwrite", (s) => s.clear());
          readSet = {};
          progress = {};
          LS.set("read", readSet);
          LS.set("progress", progress);
          showStatus("Cleared saved posts and reading history.");
        },
      },
      "Clear saved posts"
    ),
    err
  );
  view.replaceChildren(form, ...(settings.session && settings.key ? [deviceSection()] : []));
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

function takeConnectLink() {
  const m = location.hash.match(/^#\/connect\/([\w-]+)/);
  if (!m) return false;
  history.replaceState(null, "", "#/");
  lastHash = "#/";
  try {
    const d = JSON.parse(unb64url(m[1]));
    if (!d.s || !d.k) throw new Error("incomplete");
    const changed = d.s !== settings.session || d.k !== settings.key;
    Object.assign(settings, { session: d.s, key: d.k, base: d.b || "" });
    saveSettings();
    showStatus("This device is set up. Loading your feed…");
    if (changed) sync().then(() => showStatus("Up to date."), handleError);
  } catch {
    showStatus("That setup link is damaged. Show a fresh QR code on your other device and scan again.", { error: true, sticky: true });
  }
  return true;
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
        h("p", { class: "hint" }, "Scan with your phone's camera. On Android, scan from Chrome (tap the address bar, then the camera icon) so it opens in Chrome rather than another browser."),
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

$("refresh").addEventListener("click", () => {
  showStatus(null);
  sync().then(() => showStatus("Up to date."), handleError);
});

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

if (settings.session && settings.key) {
  const last = (await getMeta("lastSync")) || 0;
  if (Date.now() - last > 10 * 60 * 1000) sync().catch(handleError);
} else if (route().name !== "settings") {
  location.hash = "#/settings";
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
