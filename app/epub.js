// Reading ePub files in the app. An ePub is a zip of XHTML pages plus a
// package file (OPF) giving the reading order. Unzip in the browser (no
// library: the zip directory is simple, and DecompressionStream inflates),
// follow the order, and hand back each chapter's HTML; the reader cleans it
// up exactly like a post's own HTML.

// Minimal zip reader: the central directory at the end lists every file.
async function unzip(buf) {
  const v = new DataView(buf);
  let end = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("This file isn't an ePub (not a zip archive).");
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const utf8 = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("This ePub is damaged.");
    const nameLen = v.getUint16(p + 28, true);
    entries.set(utf8.decode(new Uint8Array(buf, p + 46, nameLen)), {
      method: v.getUint16(p + 10, true),
      size: v.getUint32(p + 20, true), // compressed
      local: v.getUint32(p + 42, true),
    });
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  const bytes = async (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
    const data = new Uint8Array(buf, start, e.size);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error("This ePub uses an unsupported compression.");
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  return {
    bytes,
    text: async (name) => {
      const b = await bytes(name);
      return b && utf8.decode(b);
    },
  };
}

// A path inside the book, from a link relative to the file it appears in.
export function resolve(from, href) {
  try {
    const u = new URL(href, "epub://book/" + from);
    return u.protocol === "epub:" ? decodeURIComponent(u.pathname.slice(1)) : null;
  } catch {
    return null;
  }
}

// → { title, chapters: [{ path, html }], image(path) → Blob | null }
export async function openEpub(buf) {
  const zip = await unzip(buf);
  const xml = (s) => new DOMParser().parseFromString(s || "", "application/xml");
  const tags = (doc, name) => [...doc.getElementsByTagNameNS("*", name)];

  const container = xml(await zip.text("META-INF/container.xml"));
  const opfPath = tags(container, "rootfile")[0]?.getAttribute("full-path");
  if (!opfPath) throw new Error("This ePub has no book inside.");
  const opf = xml(await zip.text(opfPath));

  const items = new Map(
    tags(opf, "item").map((i) => [
      i.getAttribute("id"),
      { path: resolve(opfPath, i.getAttribute("href") || ""), type: i.getAttribute("media-type") || "", props: i.getAttribute("properties") || "" },
    ])
  );
  const chapters = [];
  for (const ref of tags(opf, "itemref")) {
    if (ref.getAttribute("linear") === "no") continue; // notes, extras outside the reading order
    const it = items.get(ref.getAttribute("idref"));
    if (!it?.path || !/html/.test(it.type) || /\bnav\b/.test(it.props)) continue; // the table of contents
    const html = await zip.text(it.path);
    if (html) chapters.push({ path: it.path, html });
  }
  const types = new Map([...items.values()].map((i) => [i.path, i.type]));
  return {
    title: tags(opf, "title")[0]?.textContent.trim() || "",
    chapters,
    async image(path) {
      const b = path && (await zip.bytes(path));
      return b ? new Blob([b], { type: types.get(path) || "" }) : null;
    },
  };
}
