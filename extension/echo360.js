/* eClass Exporter 1.1.0 — https://github.com/dattodigm/eclass-exporter — built from src/ by build.mjs; do not edit. */
(() => {
  'use strict';
  const host = location.hostname;

/*
 * Shared core of the exporters: naming, folder/ZIP writers, HTML template, panel CSS.
 * Not a standalone script: build.mjs wraps it, together with the site files
 * (eclass.js, echo360.js), into one function scope per bundle.
 */
  const VERSION = '1.1.0';
  const ORIGIN = location.origin;
  // Path segment limits keep full paths under Windows' 260-char MAX_PATH.
  const LIMITS = { course: 64, section: 36, item: 40, file: 60, child: 48, folderSeg: 36 };
  const ZIP_PART_LIMIT = 3.5 * 1024 ** 3; // split ZIPs before the 4 GB ZIP32 limit

  // ------------------------------------------------------------------ utils

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parser = new DOMParser();
  // DOMParser documents are inert: no scripts run and no images load, so it
  // is safe to put untrusted course HTML into them.
  const parseHtml = (html) => parser.parseFromString(html, 'text/html');
  const decode = (s) => (s == null ? '' : parseHtml(String(s)).documentElement.textContent);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');
  const fmtBytes = (n) => {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  // Errors that stop the whole export rather than a single item.
  const isAbort = (e) => e && ['AbortError', 'SessionExpired', 'Blocked'].includes(e.name);

  function hash6(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36).slice(0, 6);
  }

  const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
  const cleanChars = (s) => s
    .replace(/[\u0000-\u001f\u007f?*]/g, '')
    .replace(/"/g, "'")
    .replace(/[/\\|:]/g, '-')
    .replace(/[<>]/g, '_');

  function splitExt(name) {
    const m = /^(.+?)(\.[A-Za-z0-9]{1,8})?$/.exec(name);
    return m ? [m[1], m[2] || ''] : [name, ''];
  }

  /** Make a string safe as a single Windows/macOS/Linux path segment. */
  function safeName(raw, max = LIMITS.file, keepExt = true) {
    let s = cleanChars(String(raw ?? '')).replace(/\s+/g, ' ').trim();
    if (s.length > max) {
      // Keep the extension, or a trailing "(Winter 2025-2026)"-style suffix.
      const [base, ext] = keepExt ? splitExt(s) : /^(.+?)((?:\s*\([^()]{1,30}\))+)$/.exec(s)?.slice(1) || [s, ''];
      s = base.slice(0, Math.max(1, max - ext.length)).trim() + ext;
    }
    s = s.replace(/[. ]+$/, '');
    if (!s) s = '_';
    if (RESERVED.test(s)) s = `_${s}`;
    return s;
  }

  /** Hands out unique names per directory. Collisions get a suffix derived
   *  from `salt` (usually the source URL) so names stay stable across runs. */
  class Names {
    constructor() { this.used = new Map(); }
    take(dir, name, { salt = '', isDir = false } = {}) {
      const key = dir.toLowerCase();
      let set = this.used.get(key);
      if (!set) this.used.set(key, (set = new Set()));
      const [base, ext] = isDir ? [name, ''] : splitExt(name);
      let cand = name;
      if (set.has(cand.toLowerCase())) cand = `${base} (${hash6(salt || name)})${ext}`;
      for (let i = 2; set.has(cand.toLowerCase()); i++) cand = `${base} (${i})${ext}`;
      set.add(cand.toLowerCase());
      return dir ? `${dir}/${cand}` : cand;
    }
    reserve(path) {
      const i = path.lastIndexOf('/');
      const dir = i < 0 ? '' : path.slice(0, i);
      const key = dir.toLowerCase();
      if (!this.used.has(key)) this.used.set(key, new Set());
      this.used.get(key).add(path.slice(i + 1).toLowerCase());
    }
  }

  const dirname = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

  /** Relative href from the file at `fromFile` to the file at `toPath`. */
  function relHref(fromFile, toPath, hash) {
    const a = dirname(fromFile).split('/').filter(Boolean);
    const b = toPath.split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    const parts = [...Array(a.length - i).fill('..'), ...b.slice(i).map(encodeURIComponent)];
    return parts.join('/') + (hash ? `#${hash}` : '');
  }

  function abs(u, base) {
    try { return new URL(u, base || ORIGIN).href; } catch { return null; }
  }

  function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

  const isPluginfile = (u) => {
    try {
      const url = new URL(u);
      return url.origin === ORIGIN && /\/(webservice\/|token)?pluginfile\.php\//.test(url.pathname);
    } catch { return false; }
  };

  /** Canonical key for a URL so different spellings of the same target match. */
  function normKey(u) {
    let url;
    try { url = new URL(u, ORIGIN); } catch { return null; }
    if (url.origin !== ORIGIN) return url.href.split('#')[0];
    const p = url.pathname;
    const pf = p.match(/\/(?:webservice\/|token)?pluginfile\.php\/(?:[0-9a-f]{32}\/)?(.*)$/);
    if (pf) return `F:${safeDecode(pf[1])}`;
    url.hash = '';
    ['forceview', 'redirect', 'lang'].forEach((k) => url.searchParams.delete(k));
    if (/^\/mod\/[a-z0-9_]+\/view\.php$/.test(p) && url.searchParams.get('id') && [...url.searchParams.keys()].length === 1) {
      return `CM:${url.searchParams.get('id')}`;
    }
    url.searchParams.sort();
    return url.pathname + url.search;
  }

  function fileNameFromUrl(u) {
    try {
      const segs = new URL(u).pathname.split('/').filter(Boolean);
      const last = segs[segs.length - 1];
      return last && !/\.php$/.test(last) ? safeDecode(last) : '';
    } catch { return ''; }
  }

  function filenameFromDisposition(cd) {
    if (!cd) return '';
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
    if (star) return safeDecode(star[1].trim().replace(/^"|"$/g, ''));
    const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/.exec(cd);
    return plain ? (plain[1] || plain[2]).trim() : '';
  }

  const MIME_EXT = {
    'application/pdf': '.pdf', 'application/zip': '.zip', 'text/html': '.html', 'text/plain': '.txt',
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/msword': '.doc', 'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.ms-excel': '.xls',
  };

  function limiter(n) {
    let active = 0;
    const q = [];
    const next = () => {
      if (active >= n || !q.length) return;
      active++;
      const { fn, res, rej } = q.shift();
      Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
  }

  async function runPool(list, n, fn, x) {
    let i = 0;
    const worker = async () => {
      while (i < list.length && !x.abort.signal.aborted) await fn(list[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  }

  // ------------------------------------------------------------------ sinks

  /** Writes into a real folder via the File System Access API (Chrome/Edge). */
  class DirSink {
    constructor(root) {
      this.root = root;
      this.kind = 'folder';
      this.dirs = new Map([['', Promise.resolve(root)]]);
    }
    dir(path) {
      if (!this.dirs.has(path)) {
        const i = path.lastIndexOf('/');
        const parent = this.dir(i < 0 ? '' : path.slice(0, i));
        this.dirs.set(path, parent.then((d) => d.getDirectoryHandle(path.slice(i + 1), { create: true })));
      }
      return this.dirs.get(path);
    }
    async handle(path, create) {
      const d = await this.dir(dirname(path));
      return d.getFileHandle(path.slice(path.lastIndexOf('/') + 1), { create });
    }
    async exists(path) {
      try { return (await (await this.handle(path, false)).getFile()).size; } catch { return 0; }
    }
    async read(path) {
      try { return await (await (await this.handle(path, false)).getFile()).text(); } catch { return null; }
    }
    async write(path, data) {
      const w = await (await this.handle(path, true)).createWritable();
      if (data instanceof ReadableStream) return data.pipeTo(w); // pipeTo closes or aborts w
      try {
        await w.write(data);
        await w.close();
      } catch (e) {
        await w.abort().catch(() => {});
        throw e;
      }
    }
    async open() {}
    async close() {}
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  async function crc32(blob) {
    let c = 0xffffffff;
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) c = CRC_TABLE[(c ^ value[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Builds store-only ZIP archives (one per course) and hands each to `deliver`. */
  class ZipSink {
    constructor(deliver) {
      this.kind = 'zip';
      this.deliver = deliver;
      this.name = null;
    }
    reset() { this.parts = []; this.central = []; this.offset = 0; this.count = 0; }
    async open(name) { this.name = name; this.part = 1; this.reset(); }
    async close() {
      if (this.count) this.flush();
      this.name = null;
    }
    async exists() { return 0; }
    async read() { return null; }
    async write(path, data) {
      let blob;
      if (data instanceof Blob) blob = data;
      else if (data instanceof ReadableStream) blob = await new Response(data).blob();
      else blob = new Blob([data]);
      if (blob.size >= 0xffffffff) throw new Error('File is larger than 4 GB; use folder mode for this course');
      const crc = await crc32(blob);
      // Everything below is synchronous, so concurrent writes cannot interleave.
      if (this.count && this.offset + blob.size > ZIP_PART_LIMIT) { this.flush(); this.part++; this.reset(); }
      const name = new TextEncoder().encode(path);
      const d = new Date();
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, blob.size, true);
      local.setUint32(22, blob.size, true);
      local.setUint16(26, name.length, true);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, blob.size, true);
      cen.setUint32(24, blob.size, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, this.offset, true);
      this.parts.push(local.buffer, name, blob);
      this.central.push(cen.buffer, name);
      this.offset += 30 + name.length + blob.size;
      this.count++;
    }
    flush() {
      const size = this.central.reduce((s, p) => s + p.byteLength, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, this.count, true);
      end.setUint16(10, this.count, true);
      end.setUint32(12, size, true);
      end.setUint32(16, this.offset, true);
      const blob = new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
      this.deliver(`${this.name}${this.part > 1 ? `-part${this.part}` : ''}.zip`, blob);
    }
  }

  function downloadBlob(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  }

  // ------------------------------------------------------------ HTML output

  const PAGE_CSS = `
body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1d2125;background:#fff}
a{color:#0f6cbf}
.xp-top{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;gap:4px 16px;justify-content:space-between;align-items:center;padding:8px 20px;background:#f5f6f8;border-bottom:1px solid #dee2e6;font-size:13px}
.xp-top nav a{text-decoration:none}
.xp-meta,.xp-src{color:#6a737b;font-size:13px}
.xp-main{max-width:1000px;margin:0 auto;padding:16px 20px 64px}
.xp-title{font-size:26px;line-height:1.25;margin:12px 0 16px}
img,video,iframe,object,embed{max-width:100%}
img{height:auto}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
.generaltable,.user-grade,.submissionstatustable table,.feedbacktable table,.quizattemptsummary,.quizreviewsummary{border-collapse:collapse;margin:8px 0}
.generaltable td,.generaltable th,.user-grade td,.user-grade th,.quizreviewsummary td,.quizreviewsummary th,.quizattemptsummary td,.quizattemptsummary th{border:1px solid #dee2e6;padding:4px 8px;vertical-align:top;text-align:left}
.accesshide,.visually-hidden,.sr-only,.d-none,[hidden]{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;white-space:nowrap!important}
.xp-embed{display:inline-block;margin:4px 0 12px;padding:4px 10px;border:1px solid #dee2e6;border-radius:6px;background:#f5f6f8;font-size:13px;word-break:break-all}
.xp-missing{outline:2px dashed #e0a800;outline-offset:2px}
.xp-course-head{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.xp-course-head img{width:220px;border-radius:8px}
.xp-facts{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;font-size:14px}
.xp-facts dt{color:#6a737b}
.xp-facts dd{margin:0}
.xp-links{margin:14px 0;display:flex;gap:8px;flex-wrap:wrap}
.xp-links a{padding:5px 12px;border:1px solid #dee2e6;border-radius:6px;text-decoration:none;background:#f5f6f8}
.xp-section{margin:28px 0;padding-top:4px;border-top:2px solid #e9ecef}
.xp-section .xp-section{margin:14px 0 6px;border-top:1px dashed #dee2e6}
.xp-section h2{font-size:21px;margin:12px 0 8px}
.xp-section h3{font-size:17px;margin:10px 0 6px}
.xp-items{list-style:none;margin:0;padding:0}
.xp-item{padding:8px 0;border-bottom:1px solid #f1f3f5}
.xp-item>.xp-row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.xp-badge{display:inline-block;min-width:66px;padding:1px 6px;border-radius:4px;background:#e9ecef;color:#495057;font-size:11px;text-transform:uppercase;letter-spacing:.03em;text-align:center}
.xp-name{font-weight:600}
.xp-note{color:#6a737b;font-size:13px}
.xp-note.err{color:#b02a37}
.xp-desc{margin:4px 0 0 76px;font-size:14px}
.xp-label{padding:8px 0;border-bottom:1px solid #f1f3f5}
.xp-post{border:1px solid #dee2e6;border-radius:8px;padding:10px 14px;margin:10px 0;background:#fff}
.xp-post header{margin-bottom:6px}
.xp-post .xp-subject{font-weight:600}
.xp-attach{margin:8px 0 0;padding-left:18px;font-size:14px}
.xp-courses{width:100%;border-collapse:collapse}
.xp-courses td,.xp-courses th{padding:6px 8px;border-bottom:1px solid #e9ecef;text-align:left;vertical-align:top}
.xp-courses th{font-size:12px;color:#6a737b;text-transform:uppercase}
`;

  function pageHtml({ title, body, crumbs = [], pagePath, source, heading = true, sourceLabel = 'Open on eClass ↗' }) {
    const nav = crumbs
      .map((c) => (c.path ? `<a href="${esc(relHref(pagePath, c.path, c.hash))}">${esc(c.title)}</a>` : `<span>${esc(c.title)}</span>`))
      .join(' › ');
    const src = source ? `<a href="${esc(source)}" target="_blank" rel="noopener">${esc(sourceLabel)}</a> · ` : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="eClass Exporter ${VERSION}"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head>
<body><header class="xp-top"><nav>${nav}</nav><div class="xp-src">${src}Saved ${esc(new Date().toLocaleString())}</div></header>
<main class="xp-main">${heading ? `<h1 class="xp-title">${esc(title)}</h1>` : ''}
${body}
</main></body></html>`;
  }

  // ------------------------------------------------------------- panel CSS

  const UI_CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
[hidden]{display:none!important}
.fab{position:fixed;right:20px;bottom:20px;z-index:2147483646;border:0;border-radius:24px;padding:10px 16px;background:#e31837;color:#fff;font-size:14px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
.fab:hover{background:#c3122d}
.panel{position:fixed;right:20px;bottom:72px;z-index:2147483647;width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 100px);display:flex;flex-direction:column;background:#fff;color:#1d2125;border:1px solid #dee2e6;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:13px;overflow:hidden}
.panel[hidden]{display:none}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #eef0f2}
header b{font-size:15px}
header button{border:0;background:none;font-size:18px;cursor:pointer;color:#6a737b}
.body{padding:12px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{border:1px solid #c9ced3;background:#fff;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;color:#1d2125}
.btn.primary{background:#e31837;border-color:#e31837;color:#fff;font-weight:600}
.btn:disabled{opacity:.5;cursor:default}
fieldset{border:1px solid #eef0f2;border-radius:8px;padding:8px 10px;margin:0}
legend{color:#6a737b;font-size:12px;padding:0 4px}
label{display:flex;gap:6px;align-items:center;margin:3px 0;cursor:pointer}
input[type=number]{width:70px;padding:3px 6px;border:1px solid #c9ced3;border-radius:6px}
input[type=search]{flex:1;padding:6px 8px;border:1px solid #c9ced3;border-radius:6px}
.list{max-height:220px;overflow:auto;border:1px solid #eef0f2;border-radius:8px;padding:4px 8px}
.list label{align-items:flex-start}
.list .cat{color:#6a737b;font-size:11px}
.muted{color:#6a737b;font-size:12px}
.bar{height:8px;background:#eef0f2;border-radius:4px;overflow:hidden}
.bar>div{height:100%;width:0;background:#e31837;transition:width .3s}
.log{height:170px;overflow:auto;background:#f7f8f9;border:1px solid #eef0f2;border-radius:8px;padding:6px 8px;font:11.5px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.log .error{color:#b02a37}.log .warn{color:#946200}.log .ok{color:#1e7b34}
`;

  const site_echo360 = () => {
/*
 * Echo360 Exporter — back up your Echo360 course recordings' companions for offline use:
 * lesson list, transcripts (VTT + TXT), slide decks (original PDF + slide text),
 * Q&A discussions, your notes, posters, and the recordings themselves where the
 * instructor allows downloads.
 *
 * Videos are only saved through Echo360's own download option. When an instructor
 * has turned downloads off, the lesson page records that and links to the online
 * player instead; the exporter never pulls the streaming copy.
 *
 * Read-only: GET requests only. Not a standalone script: build.mjs runs this file
 * as the body of a function, after src/core.js, on echo360.ca pages.
 */
  const NS = '__echo360Exporter';
  if (window[NS]) return;

  const EORIGIN = location.origin;
  const ROOT = 'Echo360';
  const E_INTERVAL_MS = 350; // ≈3 Echo360 requests per second; CDN files are not throttled

  const isoTime = (s) => (s ? new Date(s).toLocaleString() : '');
  const isoDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  function fmtDuration(iso) {
    const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(iso || '');
    if (!m) return '';
    const total = Math.round((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0));
    return fmtClock(total * 1000);
  }
  function fmtClock(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
    return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
  }
  const paragraphs = (s) => esc(s || '').replace(/\r?\n/g, '<br>');
  const page = (o) => pageHtml({ sourceLabel: 'Open on Echo360 ↗', ...o });

  class EchoSessionExpired extends Error {
    constructor() {
      super('Your Echo360 session has expired. Open Echo360 again from an eClass course (or sign in), then re-run the export; saved files will be skipped.');
      this.name = 'SessionExpired';
    }
  }

  /** Throttled fetch: Echo360 pages/API spaced out, CDN downloads limited to 3 at a time. */
  class EchoHttp {
    constructor(x) {
      this.x = x;
      this.nextAt = 0;
      this.pausedUntil = 0;
      this.interval = E_INTERVAL_MS;
      this.cdn = limiter(3);
    }

    get signal() { return this.x.abort.signal; }

    async gate() {
      for (;;) {
        if (this.signal.aborted) throw this.x.fatal || new DOMException('Aborted', 'AbortError');
        const wait = Math.max(this.pausedUntil, this.nextAt) - Date.now();
        if (wait <= 0) break;
        await sleep(Math.min(wait, 2000));
      }
      this.nextAt = Date.now() + this.interval;
      this.x.stats.requests++;
    }

    async fetch(url, init = {}) {
      const own = new URL(url, EORIGIN).origin === EORIGIN;
      let last;
      for (let i = 0; i < 4; i++) {
        try {
          if (own) await this.gate();
          else if (this.signal.aborted) throw this.x.fatal || new DOMException('Aborted', 'AbortError');
          // The file CDN (files./content./thumbnails.echo360.ca) needs Echo360's signed cookies.
          const r = await fetch(url, { ...init, credentials: own ? 'same-origin' : 'include', signal: this.signal });
          if (own && r.status === 429) {
            r.body?.cancel();
            this.interval = Math.min(this.interval * 2, 3000);
            this.pausedUntil = Date.now() + 60000;
            this.x.log('⏸ Echo360 is limiting requests (HTTP 429). Pausing 60 s, then continuing more slowly…', 'warn');
            i--;
            continue;
          }
          if (r.status >= 500 && i < 3) {
            r.body?.cancel();
            last = new Error(`HTTP ${r.status}`);
            await sleep(1500 * 2 ** i);
            continue;
          }
          if (own && (/\/login|\/sso\//.test(new URL(r.url).pathname) || new URL(r.url).origin !== EORIGIN)) {
            r.body?.cancel();
            throw this.expired();
          }
          return r;
        } catch (e) {
          if (isAbort(e)) throw e;
          last = e;
          await sleep(1500 * 2 ** i);
        }
      }
      throw last;
    }

    expired() {
      const err = new EchoSessionExpired();
      this.x.cancel(err);
      return err;
    }

    /** Echo360 UI API: {status: "ok", data} envelope. */
    async json(path) {
      const r = await this.fetch(abs(path, EORIGIN), { headers: { Accept: 'application/json' } });
      if (r.status === 401) throw this.expired();
      if (!/json/.test(r.headers.get('content-type') || '')) {
        r.body?.cancel();
        const err = new Error(`HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      const j = await r.json();
      if (j && j.status && j.status !== 'ok') {
        const err = new Error(j.message || j.status);
        err.status = r.status;
        throw err;
      }
      return j && 'data' in j ? j.data : j;
    }

    /** The JSON the classroom player is booted with (lesson, video, slides, captions…). */
    async player(lessonId) {
      const r = await this.fetch(`${EORIGIN}/lesson/${lessonId}/classroom`);
      const html = await r.text();
      const m = /Echo\["echoPlayerV2FullApp"\]\("((?:\\.|[^"\\])*)"\)/.exec(html);
      if (!m) return null;
      return JSON.parse(JSON.parse(`"${m[1]}"`));
    }
  }

  // -------------------------------------------------------------- section job

  class SectionJob {
    constructor(x, section, dir) {
      this.x = x;
      this.http = x.http;
      this.opts = x.opts;
      this.section = section;
      this.dir = dir;
      this.indexPath = `${dir}/index.html`;
      this.names = new Names();
      this.names.reserve(this.indexPath);
      this.lessons = [];
      this.counts = { lessons: 0, ok: 0, errors: 0, files: 0, transcripts: 0, slides: 0, videos: 0, videosLocked: 0, questions: 0 };
    }

    log(msg, level) { this.x.log(msg, level); }

    crumbs() {
      return [{ title: 'Echo360', path: `${ROOT}/index.html` }, { title: this.section.label, path: this.indexPath }];
    }

    async run() {
      const s = this.section;
      const syllabus = await this.http.json(`/section/${s.sectionId}/syllabus`);
      this.syllabus = syllabus;
      // Flatten groups (folders/weeks) and loose lessons into one ordered list.
      let gi = 0;
      for (const item of syllabus || []) {
        if (item.type === 'SyllabusGroupType') {
          gi++;
          const gdir = this.names.take(this.dir, safeName(`${pad(gi)} - ${item.groupInfo?.name || 'Group'}`, LIMITS.section, false), { isDir: true });
          (item.lessons || []).forEach((l, li) => this.addLesson(l, { name: item.groupInfo?.name, dir: gdir }, li + 1));
        } else if (item.lesson) {
          this.addLesson(item, null, this.lessons.length + 1);
        }
      }
      this.counts.lessons = this.lessons.length;
      this.x.stats.lessonsTotal = this.lessons.length;
      this.x.stats.lessonsDone = 0;
      this.x.ui.update();

      await runPool(this.lessons, 2, (l) => this.exportLesson(l), this.x);
      if (this.x.abort.signal.aborted) throw this.x.fatal || new DOMException('Aborted', 'AbortError');

      if (this.opts.notes) await this.saveNotes();
      await this.writeIndex();
      await this.x.sink.write(`${this.dir}/section.json`, JSON.stringify({
        exporter: `eClass Exporter ${VERSION} (Echo360)`, exportedAt: new Date().toISOString(),
        source: `${EORIGIN}/section/${s.sectionId}/home`, section: s, counts: this.counts,
        lessons: this.lessons.map((l) => ({ id: l.id, name: l.name, group: l.group?.name || null, date: l.date, path: l.path ? l.path.slice(this.dir.length + 1) : null, status: l.status, notes: l.notes, files: l.files.map((f) => ({ ...f, path: f.path && f.path.slice(this.dir.length + 1) })) })),
        syllabus,
      }, null, 2));
      return { status: 'ok', ...this.counts };
    }

    addLesson(entry, group, index) {
      const L = entry.lesson;
      const info = L.lesson || {};
      const name = info.displayName || info.name || 'Lesson';
      this.lessons.push({
        id: info.id, name, group, index, raw: L,
        date: L.startTimeUTC || info.createdAt || null,
        medias: L.medias || [],
        hasContent: !!(L.hasContent || (L.medias || []).length),
        questionCount: L.questionCount || 0,
        files: [], notes: [],
        dirName: safeName(`${pad(index)} - ${name}`, LIMITS.item, false),
        parentDir: group ? group.dir : this.dir,
      });
    }

    async exportLesson(l) {
      try {
        if (!l.hasContent) {
          l.status = 'empty';
          l.notes.push(l.raw.isFuture ? 'Scheduled, no recording yet' : 'No media');
          return;
        }
        l.dir = this.names.take(l.parentDir, l.dirName, { isDir: true });
        l.path = `${l.dir}/index.html`;
        const player = await this.http.player(l.id);
        l.player = player;
        for (const m of playableMedias(l)) await this.exportMedia(l, m, player);
        if (player?.slides?.slideDeck && this.opts.slides) await this.exportSlides(l, player.slides);
        if (l.questionCount && this.opts.discussions) await this.exportDiscussions(l);
        if (player?.video?.posterMedia?.[0]?.uri) {
          await this.saveFile(l, player.video.posterMedia[0].uri, `${l.dir}/poster.jpg`, 'poster');
        }
        await this.writeLesson(l);
        l.status = 'ok';
        this.counts.ok++;
      } catch (e) {
        if (isAbort(e)) throw e;
        l.status = 'error';
        l.notes.push(e.message);
        this.counts.errors++;
        this.log(`   ✗ ${l.name}: ${e.message}`, 'error');
      } finally {
        this.x.stats.lessonsDone++;
        this.x.ui.update();
      }
    }

    async exportMedia(l, m, player) {
      const base = `/api/ui/echoplayer/lessons/${l.id}/medias/${m.id}`;
      let info = null;
      try {
        info = await this.http.json(`${base}/download-info`);
      } catch (e) {
        if (isAbort(e)) throw e;
        if (e.status !== 404) l.notes.push(`${m.title || 'Media'}: download info unavailable (${e.message})`);
      }
      if (Array.isArray(info)) info = {}; // "data": [] means nothing is offered
      info = info || {};
      const label = m.title || m.mediaType;
      const prefix = playableMedias(l).length > 1 ? `${safeName(splitExt(label)[0], 30, false)} - ` : '';

      // Recording: only via Echo360's own download option.
      const offered = [...(info.primaryFiles?.files || []), ...(info.secondaryFiles?.files || []), ...(info.audioFiles || [])];
      if (!offered.length) {
        l.locked = true;
        this.counts.videosLocked++;
        l.notes.push(`${label}: video download is turned off for this course — watch it online`);
      } else if (this.opts.videos) {
        const pick = offered.find((f) => /hd|high|1080|720/i.test(`${f.label} ${f.fileName}`)) || offered[0];
        try {
          const file = await this.http.json(`${base}/file/${encodeURIComponent(pick.fileName)}`);
          const uri = file?.downloadUri || file;
          if (typeof uri !== 'string') throw new Error('no download link returned');
          const ok = await this.saveFile(l, uri, `${l.dir}/${prefix}${safeName(pick.fileName, LIMITS.file)}`, 'video');
          if (ok) this.counts.videos++;
        } catch (e) {
          if (isAbort(e)) throw e;
          l.notes.push(`${label}: video download failed (${e.message})`);
        }
      } else {
        l.notes.push(`${label}: video download available on Echo360 (videos disabled in options)`);
      }

      // Transcripts: offered as files when a transcript exists.
      if (this.opts.transcripts && (info.transcriptFiles || []).length) {
        for (const [format, ext] of [['vtt', 'vtt'], ['text', 'txt']]) {
          const path = `${l.dir}/${prefix}transcript.${ext}`;
          if (this.opts.skipExisting && (await this.x.sink.exists(path)) > 0) {
            this.x.stats.existing++;
            if (ext === 'txt') l.transcriptText = await this.x.sink.read(path);
            l.files.push({ kind: `transcript-${ext}`, path });
            continue;
          }
          try {
            const r = await this.http.fetch(`${EORIGIN}${base}/transcript-file?format=${format}`);
            if (!r.ok) { r.body?.cancel(); throw new Error(`HTTP ${r.status}`); }
            const body = await r.text();
            await this.x.sink.write(path, body);
            if (ext === 'txt') l.transcriptText = body;
            l.files.push({ kind: `transcript-${ext}`, path });
            this.x.stats.files++;
            this.counts.files++;
          } catch (e) {
            if (isAbort(e)) throw e;
            l.notes.push(`${label}: transcript (${ext}) failed: ${e.message}`);
          }
        }
        this.counts.transcripts++;
      }
      if (player?.video?.mediaId === m.id) l.duration = player.video.duration;
    }

    async exportSlides(l, slides) {
      const deck = slides.slideDeck;
      const file = deck.originalFile;
      if (file?.url) {
        const name = safeName(file.name || `slides.${file.ext || 'pdf'}`, LIMITS.file);
        await this.saveFile(l, file.url, `${l.dir}/${name}`, 'slides');
      }
      const list = slides.slidesWithImages || [];
      const doc = parseHtml('<div></div>');
      const root = doc.body.firstChild;
      for (const [i, item] of list.entries()) {
        const s = item.slide || item;
        const sec = doc.createElement('section');
        sec.className = 'xp-post';
        let img = '';
        if (!file?.url && s.thumbnailUrl) {
          // No original file to fall back on: keep the slide images instead.
          const path = `${l.dir}/slides/${pad(i + 1, 3)}.png`;
          if (await this.saveFile(l, s.thumbnailUrl, path, 'slide-image')) img = `<img src="${esc(relHref(`${l.dir}/slides.html`, path))}" alt="">`;
        }
        sec.innerHTML = `<header><div class="xp-subject">Slide ${i + 1}</div></header>${img}<div>${paragraphs(s.text)}</div>`;
        root.appendChild(sec);
      }
      if (list.length) {
        const pdf = l.files.find((f) => f.kind === 'slides');
        const head = pdf ? `<p><a href="${esc(relHref(`${l.dir}/slides.html`, pdf.path))}">${esc(pdf.path.split('/').pop())}</a> · ${list.length} slides</p>` : '';
        await this.x.sink.write(`${l.dir}/slides.html`, page({
          title: `${l.name} — slides`, body: head + root.innerHTML, pagePath: `${l.dir}/slides.html`,
          crumbs: [...this.crumbs(), { title: l.name, path: l.path }], source: `${EORIGIN}/lesson/${l.id}/classroom`,
        }));
        l.files.push({ kind: 'slides-text', path: `${l.dir}/slides.html` });
      }
      this.counts.slides++;
    }

    async exportDiscussions(l) {
      let data;
      try {
        data = await this.http.json(`/api/ui/discussions/lessons/${l.id}/questions`);
      } catch (e) {
        if (isAbort(e)) throw e;
        l.notes.push(`Discussions unavailable: ${e.message}`);
        return;
      }
      const qs = data?.questions || [];
      if (!qs.length) return;
      const who = (o) => [o.authorFirstName, o.authorLastName].filter(Boolean).join(' ') || 'Anonymous';
      const when = (o) => `${isoTime(o.createdAt)}${o.updatedAt && o.updatedAt !== o.createdAt ? ` · edited ${isoTime(o.updatedAt)}` : ''}`;
      const body = qs.map(({ question: q, responses = [] }) => {
        const at = q.videoContentRef?.timestampMillis != null ? ` · at ${fmtClock(q.videoContentRef.timestampMillis)} in the recording` : '';
        const slide = q.slideContentRef ? ' · on a slide' : '';
        const replies = responses.map((r) => `<article class="xp-post" style="margin-left:24px"><header><div class="xp-meta">${esc(who(r))} · ${esc(when(r))}${r.likeCount ? ` · ♥ ${r.likeCount}` : ''}</div></header><div>${paragraphs(r.body)}</div></article>`).join('');
        return `<article class="xp-post"><header><div class="xp-subject">${q.pinned ? '📌 ' : ''}Question</div><div class="xp-meta">${esc(who(q))} · ${esc(when(q))}${esc(at)}${slide}${q.likeCount ? ` · ♥ ${q.likeCount}` : ''}</div></header><div>${paragraphs(q.body)}</div></article>${replies}`;
      }).join('\n');
      const path = `${l.dir}/discussions.html`;
      await this.x.sink.write(path, page({
        title: `${l.name} — Q&A`, body, pagePath: path,
        crumbs: [...this.crumbs(), { title: l.name, path: l.path }], source: `${EORIGIN}/lesson/${l.id}/classroom`,
      }));
      l.files.push({ kind: 'discussions', path, count: qs.length });
      this.counts.questions += qs.length;
    }

    /** Download a CDN file to `path`; resumes by skipping files that already exist. */
    saveFile(l, url, path, kind) {
      return this.http.cdn(async () => {
        try {
          if (this.opts.skipExisting) {
            const size = await this.x.sink.exists(path);
            if (size > 0) { this.x.stats.existing++; l.files.push({ kind, path, size }); return true; }
          }
          const r = await this.http.fetch(url);
          if (!r.ok) { r.body?.cancel(); throw new Error(`HTTP ${r.status}`); }
          const max = this.opts.maxMB > 0 ? this.opts.maxMB * 1024 * 1024 : 0;
          const len = +r.headers.get('content-length') || 0;
          if (max && len > max) {
            r.body?.cancel();
            l.notes.push(`${path.split('/').pop()}: skipped, ${fmtBytes(len)} is over the size limit`);
            return false;
          }
          let size = 0;
          const x = this.x;
          const counted = r.body.pipeThrough(new TransformStream({
            transform(chunk, ctl) {
              size += chunk.byteLength;
              x.stats.bytes += chunk.byteLength;
              if (max && size > max) { ctl.error(new Error('over the size limit')); return; }
              ctl.enqueue(chunk);
            },
          }));
          await this.x.sink.write(path, counted);
          this.x.stats.files++;
          this.counts.files++;
          l.files.push({ kind, path, size });
          this.x.ui.update();
          return true;
        } catch (e) {
          if (isAbort(e)) throw e;
          if (kind !== 'poster') l.notes.push(`${path.split('/').pop()}: ${e.message}`); // a missing poster is cosmetic
          return false;
        }
      });
    }

    async writeLesson(l) {
      const rel = (p) => esc(relHref(l.path, p));
      const p = l.player;
      const link = (f, text) => `<li><a href="${rel(f.path)}">${esc(text || f.path.split('/').pop())}</a>${f.size ? ` <span class="xp-note">${esc(fmtBytes(f.size))}</span>` : ''}</li>`;
      const labels = { video: 'Recording', 'transcript-vtt': 'Transcript (VTT captions)', 'transcript-txt': 'Transcript (text)', slides: 'Slides (original file)', 'slides-text': 'Slides (text)', discussions: 'Q&A discussions', poster: 'Poster image' };
      const files = l.files.filter((f) => f.kind !== 'slide-image')
        .map((f) => link(f, `${labels[f.kind] || f.kind}: ${f.path.split('/').pop()}${f.count ? ` (${f.count})` : ''}`)).join('');
      const facts = [
        ['Course', this.section.label],
        ['Group', l.group?.name],
        ['Date', isoTime(l.date)],
        ['Duration', fmtDuration(l.duration)],
        ['Media', l.medias.map((m) => `${m.mediaType}: ${m.title}`).join(' · ')],
      ].filter(([, v]) => v);
      const chapters = (p?.chapters || []).map((c) => `<li>${esc(fmtClock(c.timestampMillis ?? c.startTimeMillis ?? 0))} — ${esc(c.title || c.name || '')}</li>`).join('');
      const transcript = l.transcriptText ? `<details><summary>Transcript</summary><pre>${esc(l.transcriptText)}</pre></details>` : '';
      const poster = l.files.find((f) => f.kind === 'poster');
      const body = `${poster ? `<p><img src="${rel(poster.path)}" alt="" style="max-width:480px;border-radius:8px"></p>` : ''}
<dl class="xp-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
<div class="xp-links"><a href="${esc(`${EORIGIN}/lesson/${l.id}/classroom`)}" target="_blank" rel="noopener">Watch on Echo360 ↗</a></div>
${l.notes.length ? `<ul>${l.notes.map((n) => `<li class="xp-note">${esc(n)}</li>`).join('')}</ul>` : ''}
${files ? `<h2>Saved files</h2><ul>${files}</ul>` : ''}
${chapters ? `<h2>Chapters</h2><ul>${chapters}</ul>` : ''}
${transcript}`;
      await this.x.sink.write(l.path, page({ title: l.name, body, pagePath: l.path, crumbs: this.crumbs(), source: `${EORIGIN}/lesson/${l.id}/classroom` }));
      await this.x.sink.write(`${l.dir}/lesson.json`, JSON.stringify({ syllabus: l.raw, player: p && { ...p, user: undefined, heatmapData: undefined } }, null, 2));
    }

    async saveNotes() {
      try {
        const r = await this.http.fetch(`${EORIGIN}/section/${this.section.sectionId}/notes/download`);
        const t = r.ok ? await r.text() : '';
        if (t.trim()) {
          await this.x.sink.write(`${this.dir}/my-notes.txt`, t);
          this.hasNotes = true;
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        this.log(`   notes: ${e.message}`, 'warn');
      }
    }

    async writeIndex() {
      const s = this.section;
      const rows = [];
      let group;
      for (const l of this.lessons) {
        if (l.group?.name !== group) {
          group = l.group?.name;
          if (group) rows.push(`<tr><th colspan="4">${esc(group)}</th></tr>`);
        }
        const name = l.status === 'ok' ? `<a href="${esc(relHref(this.indexPath, l.path))}">${esc(l.name)}</a>` : esc(l.name);
        const has = [
          l.files.some((f) => f.kind === 'video') ? '🎬 video' : l.locked ? '🔒 online only' : '',
          l.files.some((f) => f.kind.startsWith('transcript')) ? '📝 transcript' : '',
          l.files.some((f) => f.kind === 'slides' || f.kind === 'slides-text') ? '📑 slides' : '',
          l.files.some((f) => f.kind === 'discussions') ? `💬 ${l.files.find((f) => f.kind === 'discussions').count} Q&A` : '',
        ].filter(Boolean).join(' · ');
        const note = l.status === 'ok' ? '' : (l.notes[0] || l.status || '');
        rows.push(`<tr><td>${name}${note ? `<div class="xp-note${l.status === 'error' ? ' err' : ''}">${esc(note)}</div>` : ''}</td><td class="xp-note">${esc(isoDate(l.date))}</td><td class="xp-note">${esc(fmtDuration(l.duration))}</td><td class="xp-note">${has}</td></tr>`);
      }
      const c = this.counts;
      const body = `<dl class="xp-facts"><dt>Course</dt><dd>${esc(`${s.courseCode} — ${s.courseName}`)}</dd><dt>Section</dt><dd>${esc(s.sectionName)}</dd><dt>Term</dt><dd>${esc(s.termName || '')}</dd>
<dt>Saved</dt><dd>${c.ok}/${c.lessons} lessons · ${c.transcripts} transcripts · ${c.slides} slide decks · ${c.questions} questions · ${c.videos} videos${c.videosLocked ? ` (${c.videosLocked} online only)` : ''}</dd></dl>
<div class="xp-links"><a href="${esc(`${EORIGIN}/section/${s.sectionId}/home`)}" target="_blank" rel="noopener">Open on Echo360 ↗</a>${this.hasNotes ? '<a href="my-notes.txt">My notes</a>' : ''}<a href="section.json">section.json</a></div>
${c.videosLocked ? '<p class="xp-note">🔒 The instructor turned off video downloads for these recordings, so they are listed with their transcripts, slides and discussions and link to the online player.</p>' : ''}
<table class="xp-courses"><thead><tr><th>Lesson</th><th>Date</th><th>Length</th><th>Saved</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>`;
      await this.x.sink.write(this.indexPath, page({ title: s.label, body, pagePath: this.indexPath, crumbs: [{ title: 'Echo360', path: `${ROOT}/index.html` }] }));
    }
  }

  const playableMedias = (l) => l.medias.filter((m) => m.mediaType === 'Video' || m.mediaType === 'Audio');

  // --------------------------------------------------------------- exporter

  class EchoExporter {
    constructor(opts, sink, ui) {
      this.opts = opts;
      this.sink = sink;
      this.ui = ui;
      this.abort = new AbortController();
      this.fatal = null;
      this.stats = { requests: 0, files: 0, bytes: 0, existing: 0, errors: 0, warnings: 0, lessonsTotal: 0, lessonsDone: 0, courseIndex: 0, courseTotal: 0 };
      this.http = new EchoHttp(this);
    }

    log(msg, level = 'info') {
      if (level === 'error') this.stats.errors++;
      if (level === 'warn') this.stats.warnings++;
      this.ui.log(msg, level);
    }

    cancel(reason) {
      if (!this.fatal) this.fatal = reason || Object.assign(new Error('Export cancelled'), { name: 'AbortError' });
      this.abort.abort();
    }

    async listSections() {
      const data = await this.http.json('/user/enrollments');
      const out = [];
      for (const block of Array.isArray(data) ? data : [data]) {
        const terms = block.termsById || {};
        for (const s of block.userSections || []) {
          const term = terms[s.termId] || {};
          out.push({
            ...s, termName: term.name || '', termStart: term.startDate || '',
            label: `${s.courseCode} ${s.sectionName} - ${s.courseName}${term.name ? ` (${term.name})` : ''}`,
          });
        }
      }
      return out.sort((a, b) => String(b.termStart).localeCompare(String(a.termStart)) || a.label.localeCompare(b.label));
    }

    async run(sectionIds) {
      const started = Date.now();
      const all = await this.listSections();
      const targets = sectionIds.map((id) => all.find((s) => s.sectionId === id)).filter(Boolean);
      let prev = { sections: [] };
      try { prev = JSON.parse((await this.sink.read(`${ROOT}/courses.json`)) || '{"sections":[]}'); } catch { /* fresh folder */ }
      const names = new Names();
      names.reserve(`${ROOT}/index.html`);
      names.reserve(`${ROOT}/courses.json`);
      const dirFor = new Map();
      for (const p of prev.sections) if (p.dir) { names.reserve(p.dir); dirFor.set(p.sectionId, p.dir); }
      const results = new Map(prev.sections.map((p) => [p.sectionId, p]));
      this.stats.courseTotal = targets.length;
      try {
        for (const s of targets) {
          this.stats.courseIndex++;
          const dir = dirFor.get(s.sectionId) || names.take(ROOT, safeName(s.label, LIMITS.course, false), { salt: s.sectionId, isDir: true });
          this.log(`▶ [${this.stats.courseIndex}/${targets.length}] ${s.label}`);
          this.ui.update();
          await this.sink.open(dir.replace(`${ROOT}/`, 'Echo360 - '));
          let r;
          try {
            r = await new SectionJob(this, s, dir).run();
          } catch (e) {
            if (isAbort(e)) throw e;
            this.log(`✗ ${s.label}: ${e.message}`, 'error');
            r = { status: 'error', note: e.message };
          } finally {
            if (!this.abort.signal.aborted) await this.sink.close();
          }
          results.set(s.sectionId, {
            sectionId: s.sectionId, label: s.label, courseCode: s.courseCode, courseName: s.courseName, sectionName: s.sectionName,
            termName: s.termName, termStart: s.termStart, dir: r.status === 'ok' ? dir : dirFor.get(s.sectionId) || null,
            exportedAt: new Date().toISOString(), ...r,
          });
          if (r.status === 'ok') this.log(`✓ ${s.label}: ${r.ok}/${r.lessons} lessons, ${r.transcripts} transcripts, ${r.slides} slide decks, ${r.questions} questions${r.videosLocked ? `, ${r.videosLocked} videos online only` : ''}`, 'ok');
        }
      } catch (e) {
        throw this.fatal || e;
      } finally {
        if (results.size) {
          try { await this.writeRootIndex([...results.values()]); } catch (e) { this.log(`index.html: ${e.message}`, 'error'); }
        }
      }
      const secs = Math.round((Date.now() - started) / 1000);
      this.log(`Done in ${Math.floor(secs / 60)}m ${secs % 60}s — ${this.stats.files} files (${fmtBytes(this.stats.bytes)}), ${this.stats.existing} already saved, ${this.stats.errors} errors.`, 'ok');
    }

    async writeRootIndex(sections) {
      sections.sort((a, b) => String(b.termStart).localeCompare(String(a.termStart)) || String(a.label).localeCompare(b.label));
      const rows = sections.map((s) => {
        const name = s.dir ? `<a href="${esc(relHref(`${ROOT}/index.html`, `${s.dir}/index.html`))}">${esc(s.label)}</a>` : esc(s.label);
        const status = s.status === 'ok'
          ? `${s.ok}/${s.lessons} lessons · ${s.transcripts} transcripts · ${s.slides} slide decks · ${s.questions} Q&A${s.videos ? ` · ${s.videos} videos` : ''}${s.errors ? ` · <span class="xp-note err">${s.errors} errors</span>` : ''}`
          : `<span class="xp-note">${esc(s.note || s.status)}</span>`;
        return `<tr><td>${name}</td><td>${esc(s.termName || '')}</td><td>${status}</td><td class="xp-note">${esc(new Date(s.exportedAt).toLocaleString())}</td></tr>`;
      }).join('\n');
      const eclass = this.sink.kind === 'folder' && (await this.sink.exists('index.html')) > 0;
      const body = `${eclass ? '<p><a href="../index.html">← eClass backup</a></p>' : ''}<p class="xp-note">${sections.filter((s) => s.status === 'ok').length} of ${sections.length} Echo360 courses saved from <a href="${EORIGIN}">${EORIGIN}</a>.</p>
<table class="xp-courses"><thead><tr><th>Course</th><th>Term</th><th>Contents</th><th>Saved</th></tr></thead><tbody>${rows}</tbody></table>`;
      if (this.sink.kind === 'zip') await this.sink.open('Echo360-index');
      await this.sink.write(`${ROOT}/index.html`, pageHtml({ title: 'Echo360 backup', body, pagePath: `${ROOT}/index.html` }));
      await this.sink.write(`${ROOT}/courses.json`, JSON.stringify({ exporter: `eClass Exporter ${VERSION} (Echo360)`, updatedAt: new Date().toISOString(), sections }, null, 2));
      if (this.sink.kind === 'zip') await this.sink.close();
    }
  }

  // --------------------------------------------------------------------- UI

  class EchoPanel {
    constructor() {
      this.sectionId = (/\/section\/([0-9a-f-]{36})/.exec(location.pathname) || [])[1] || null;
      const host = document.createElement('div');
      host.id = 'echo360-exporter';
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${UI_CSS}</style>
<button class="fab">⬇ Export Echo360</button>
<div class="panel" hidden>
  <header><b>Echo360 Exporter <span class="muted">v${VERSION}</span></b><button class="close" title="Close">×</button></header>
  <div class="body">
    <div class="row">
      <button class="btn primary" data-act="this" ${this.sectionId ? '' : 'hidden'}>Export this course</button>
      <button class="btn" data-act="pick">Choose courses…</button>
    </div>
    <div class="picker" hidden>
      <div class="row"><input type="search" placeholder="Filter courses"><button class="btn" data-act="all">All</button><button class="btn" data-act="none">None</button></div>
      <div class="list muted">Loading…</div>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-act="selected" disabled>Export selected</button><span class="muted sel"></span></div>
    </div>
    <fieldset><legend>Options</legend>
      <label><input type="radio" name="mode" value="folder"> Save to a folder <span class="muted">(Chrome/Edge; can be your eClass backup folder)</span></label>
      <label><input type="radio" name="mode" value="zip"> Download a ZIP per course</label>
      <label><input type="checkbox" name="transcripts" checked> Transcripts</label>
      <label><input type="checkbox" name="slides" checked> Slides</label>
      <label><input type="checkbox" name="discussions" checked> Q&amp;A discussions</label>
      <label><input type="checkbox" name="notes" checked> My notes</label>
      <label><input type="checkbox" name="videos" checked> Recordings, where the instructor allows downloads</label>
      <label><input type="checkbox" name="skipExisting" checked> Skip files already in the folder</label>
      <label>Skip files larger than <input type="number" name="maxMB" min="0" value="0"> MB <span class="muted">(0 = no limit)</span></label>
    </fieldset>
    <div class="progress" hidden><div class="bar"><div></div></div><div class="muted stat" style="margin-top:6px"></div></div>
    <div class="log" hidden></div>
    <div class="row run" hidden><button class="btn" data-act="cancel">Cancel</button></div>
  </div>
</div>`;
      this.root = root;
      this.$ = (s) => root.querySelector(s);
      const canFolder = typeof window.showDirectoryPicker === 'function';
      root.querySelector(`input[value="${canFolder ? 'folder' : 'zip'}"]`).checked = true;
      if (!canFolder) root.querySelector('input[value="folder"]').disabled = true;
      this.$('.fab').onclick = () => { this.$('.panel').hidden = !this.$('.panel').hidden; };
      this.$('.close').onclick = () => { this.$('.panel').hidden = true; };
      root.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act) this.onAction(act);
      });
      this.$('input[type=search]').oninput = () => {
        const q = this.$('input[type=search]').value.toLowerCase().trim();
        root.querySelectorAll('.list label').forEach((l) => { l.hidden = q && !l.dataset.q.includes(q); });
      };
      this.x = null;
      window.addEventListener('beforeunload', (e) => { if (this.x) { e.preventDefault(); e.returnValue = ''; } });
    }

    options() {
      const v = (n) => this.root.querySelector(`input[name=${n}]`);
      return {
        mode: this.root.querySelector('input[name=mode]:checked').value,
        transcripts: v('transcripts').checked, slides: v('slides').checked, discussions: v('discussions').checked,
        notes: v('notes').checked, videos: v('videos').checked, skipExisting: v('skipExisting').checked,
        maxMB: Math.max(0, +v('maxMB').value || 0),
      };
    }

    async onAction(act) {
      if (act === 'this') return this.start([this.sectionId]);
      if (act === 'pick') return this.showPicker();
      if (act === 'all' || act === 'none') {
        this.root.querySelectorAll('.list label:not([hidden]) input').forEach((i) => { i.checked = act === 'all'; });
        return this.updateSel();
      }
      if (act === 'selected') return this.start([...this.root.querySelectorAll('.list input:checked')].map((i) => i.value));
      if (act === 'cancel' && this.x) this.x.cancel();
    }

    async showPicker() {
      const p = this.$('.picker');
      p.hidden = !p.hidden;
      if (p.hidden || this.sections) return;
      const list = this.$('.list');
      try {
        this.sections = await new EchoExporter({}, null, this).listSections();
      } catch (e) {
        list.textContent = `Could not load courses: ${e.message}`;
        return;
      }
      list.textContent = '';
      list.classList.remove('muted');
      for (const s of this.sections) {
        const l = document.createElement('label');
        const i = document.createElement('input');
        i.type = 'checkbox';
        i.value = s.sectionId;
        i.checked = s.lessonCount > 0;
        i.onchange = () => this.updateSel();
        const t = document.createElement('span');
        t.textContent = `${s.courseCode} ${s.sectionName} - ${s.courseName}`;
        const cat = document.createElement('div');
        cat.className = 'cat';
        cat.textContent = `${s.termName} · ${s.lessonCount} lessons`;
        t.appendChild(cat);
        l.append(i, t);
        l.dataset.q = s.label.toLowerCase();
        list.appendChild(l);
      }
      this.updateSel();
    }

    updateSel() {
      const n = this.root.querySelectorAll('.list input:checked').length;
      this.$('.sel').textContent = `${n} selected`;
      this.$('[data-act=selected]').disabled = !n || !!this.x;
    }

    async start(ids) {
      if (this.x || !ids.length) return;
      const opts = this.options();
      let sink;
      try {
        sink = opts.mode === 'folder'
          ? new DirSink(await window.showDirectoryPicker({ id: 'eclass-export', mode: 'readwrite', startIn: 'documents' }))
          : new ZipSink(downloadBlob);
      } catch (e) {
        if (e.name !== 'AbortError') alert(`Could not open the folder: ${e.message}`);
        return;
      }
      await this.runWith(ids, opts, sink);
    }

    async runWith(ids, opts, sink) {
      if (this.x) throw new Error('An export is already running');
      for (const s of ['.panel', '.log', '.progress', '.run']) this.$(s).hidden = false;
      this.$('.log').textContent = '';
      this.root.querySelectorAll('[data-act=this],[data-act=selected],[data-act=pick]').forEach((b) => { b.disabled = true; });
      const x = (this.x = new EchoExporter(opts, sink, this));
      this.log(`Saving ${ids.length} Echo360 course${ids.length > 1 ? 's' : ''} ${sink.kind === 'folder' ? `into folder "${sink.root.name}/${ROOT}"` : 'as ZIP downloads'}…`);
      try {
        await x.run(ids);
      } catch (e) {
        this.log(e.name === 'AbortError' ? 'Cancelled.' : `Stopped: ${e.message}`, 'error');
      } finally {
        this.x = null;
        this.render(x);
        this.$('.run').hidden = true;
        this.root.querySelectorAll('[data-act=this],[data-act=selected],[data-act=pick]').forEach((b) => { b.disabled = false; });
        this.updateSel();
      }
      return x.stats;
    }

    log(msg, level = 'info') {
      const box = this.$('.log');
      const line = document.createElement('div');
      line.className = level;
      line.textContent = msg;
      box.appendChild(line);
      while (box.childNodes.length > 600) box.firstChild.remove();
      box.scrollTop = box.scrollHeight;
      (level === 'error' ? console.warn : console.log)('[Echo360 Exporter]', msg);
    }

    update() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        if (this.x) this.render(this.x);
      });
    }

    render(x) {
      const s = x.stats;
      const pct = s.courseTotal ? ((Math.max(0, s.courseIndex - 1) + (s.lessonsTotal ? s.lessonsDone / s.lessonsTotal : 0)) / s.courseTotal) * 100 : 0;
      this.$('.bar>div').style.width = `${Math.max(2, Math.min(100, pct)).toFixed(1)}%`;
      this.$('.stat').textContent = `Course ${s.courseIndex}/${s.courseTotal} · lessons ${s.lessonsDone}/${s.lessonsTotal} · ${s.files} files (${fmtBytes(s.bytes)}) · ${s.existing} already saved · ${s.errors} errors`;
    }
  }

  // ------------------------------------------------------------- bootstrap

  let panel = null;
  const api = {
    version: VERSION,
    EchoExporter, SectionJob, DirSink, ZipSink,
    /** Console entry point: echo360Exporter.run(['<sectionId>'], { mode: 'zip' }) */
    async run(ids, opts = {}, sink) {
      const o = { mode: 'zip', transcripts: true, slides: true, discussions: true, notes: true, videos: true, skipExisting: true, maxMB: 0, ...opts };
      const s = sink || (o.mode === 'folder' ? new DirSink(await window.showDirectoryPicker({ mode: 'readwrite' })) : new ZipSink(downloadBlob));
      if (panel) return panel.runWith(ids, o, s);
      const x = new EchoExporter(o, s, { log: (m, l) => console.log('[Echo360 Exporter]', l || 'info', m), update() {} });
      await x.run(ids);
      return x.stats;
    },
    get current() { return panel && panel.x; },
  };
  window[NS] = api;
  window.echo360Exporter = api;

  const boot = () => {
    if (!document.body || document.getElementById('echo360-exporter')) return;
    panel = new EchoPanel();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  };

  if (host === 'echo360.ca') site_echo360();
})();
