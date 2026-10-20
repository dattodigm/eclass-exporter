// ==UserScript==
// @name         eClass & Echo360 Exporter (YorkU)
// @namespace    https://eclass.yorku.ca/
// @version      1.1.0
// @description  Back up YorkU eClass courses and Echo360 lectures (content, files, assignments, forums, transcripts, slides, Q&A, grades) for offline use.
// @homepageURL  https://github.com/dattodigm/eclass-exporter
// @supportURL   https://github.com/dattodigm/eclass-exporter/issues
// @downloadURL  https://github.com/dattodigm/eclass-exporter/releases/latest/download/eclass-exporter.user.js
// @updateURL    https://github.com/dattodigm/eclass-exporter/releases/latest/download/eclass-exporter.user.js
// @match        https://eclass.yorku.ca/*
// @match        https://echo360.ca/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

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

  const site_eclass = () => {
/*
 * eClass Exporter — back up YorkU eClass (Moodle 5.x) courses for offline use.
 *
 * Read-only by design: it only issues GET requests plus three read-only AJAX
 * calls (course state, course list, forum posts). It never submits forms,
 * starts quiz attempts or changes preferences. Opening activity pages is
 * logged by eClass as a "view", the same as clicking through them yourself.
 *
 * Not a standalone script: build.mjs runs this file as the body of a function,
 * after src/core.js, on eclass.yorku.ca pages.
 */
  const NS = '__eclassExporter';
  if (window[NS]) return;

  const MIN_INTERVAL_MS = 350; // ≈3 eClass requests per second
  const MAX_INTERVAL_MS = 3000;
  const MAX_PAUSES = 6; // 1+2+4+8+10+10 minutes of waiting before giving up

  // ------------------------------------------------------------------- HTTP

  class SessionExpired extends Error {
    constructor() {
      super('Your eClass session has expired. Log in again and re-run the export; files that were already saved will be skipped.');
      this.name = 'SessionExpired';
    }
  }

  function findSesskey() {
    for (const s of document.scripts) {
      const m = /"sesskey":"([^"]+)"/.exec(s.textContent);
      if (m) return m[1];
    }
    const a = document.querySelector('a[href*="sesskey="]');
    if (a) return new URL(a.href).searchParams.get('sesskey');
    const i = document.querySelector('input[name="sesskey"]');
    return i ? i.value : null;
  }

  class Http {
    constructor(x) {
      this.x = x;
      this.pages = limiter(3);
      this.files = limiter(3);
      this.sesskey = findSesskey();
      // eClass sits behind an AWS load balancer that answers 403 to every request from a
      // client that sends too many (~9 req/s for a few minutes was enough), so requests to
      // eClass are spaced out. File bodies come from the CDN and are not throttled.
      this.interval = MIN_INTERVAL_MS;
      this.nextAt = 0;
      this.pausedUntil = 0;
      this.pauses = 0;
    }

    get signal() { return this.x.abort.signal; }

    /** Wait for this request's turn: at most one eClass request per `interval`, none while paused. */
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

    async isRateLimited(r) {
      if (r.status === 429) return true;
      if (r.status !== 403) return false;
      const body = await r.clone().text().catch(() => '');
      return body.length < 3000 && /<h1>\s*403 Forbidden\s*<\/h1>/i.test(body) && !/moodle|eclass/i.test(body);
    }

    rateLimited() {
      if (Date.now() < this.pausedUntil) return; // already pausing
      this.pauses++;
      if (this.pauses > MAX_PAUSES) {
        const err = new Error('eClass keeps refusing requests (HTTP 403 from its load balancer). Wait 15–30 minutes and run the export again into the same folder; saved files will be skipped.');
        err.name = 'Blocked';
        this.x.cancel(err);
        throw err;
      }
      const secs = Math.min(60 * 2 ** (this.pauses - 1), 600);
      this.pausedUntil = Date.now() + secs * 1000;
      this.interval = Math.min(this.interval * 2, MAX_INTERVAL_MS);
      this.x.log(`⏸ eClass is limiting requests (HTTP 403). Pausing ${secs} s, then continuing at ${(1000 / this.interval).toFixed(1)} requests/s…`, 'warn');
    }

    async fetch(url, init = {}) {
      const toEclass = new URL(url, ORIGIN).origin === ORIGIN;
      let last;
      for (let i = 0; i < 4; i++) {
        try {
          if (toEclass) await this.gate();
          else if (this.signal.aborted) throw this.x.fatal || new DOMException('Aborted', 'AbortError');
          // Default credentials ("same-origin"): eClass cookies are sent, but files
          // redirect to a CloudFront CDN whose wildcard CORS rejects credentialed requests.
          const r = await fetch(url, { ...init, signal: this.signal });
          if (toEclass && (await this.isRateLimited(r))) {
            r.body?.cancel();
            this.rateLimited();
            i--; // waiting out a rate limit does not use up a retry
            continue;
          }
          if (r.status >= 500 && i < 3) {
            r.body?.cancel();
            last = new Error(`HTTP ${r.status}`);
            await sleep(1500 * 2 ** i);
            continue;
          }
          if (/\/login\/index\.php/.test(r.url)) throw this.expired();
          return r;
        } catch (e) {
          if (isAbort(e)) throw e;
          last = e;
          // A cross-origin redirect to Passport York fails CORS with a TypeError.
          if (e instanceof TypeError && !(await this.sessionAlive())) throw this.expired();
          await sleep(1500 * 2 ** i);
        }
      }
      throw last;
    }

    expired() {
      const err = new SessionExpired();
      this.x.cancel(err); // stop every other in-flight request too
      return err;
    }

    async sessionAlive() {
      try {
        const r = await fetch(`${ORIGIN}/lib/ajax/service.php?sesskey=${encodeURIComponent(this.sesskey)}&info=core_session_time_remaining`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([{ index: 0, methodname: 'core_session_time_remaining', args: {} }]),
        });
        const j = await r.json();
        return !!(j[0] && !j[0].error && j[0].data.timeremaining > 0);
      } catch { return true; } // network trouble: don't misreport as logout
    }

    /** Fetch and parse an HTML page. */
    page(url) {
      return this.pages(async () => {
        const r = await this.fetch(abs(url));
        const html = await r.text();
        this.x.stats.pages++;
        return { url: r.url, status: r.status, doc: parseHtml(html) };
      });
    }

    async ajax(methodname, args) {
      const r = await this.fetch(`${ORIGIN}/lib/ajax/service.php?sesskey=${encodeURIComponent(this.sesskey)}&info=${methodname}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ index: 0, methodname, args }]),
      });
      if (!/json/.test(r.headers.get('content-type') || '')) {
        r.body?.cancel();
        throw new Error(`${methodname}: HTTP ${r.status}, unexpected response`);
      }
      const j = await r.json();
      const res = Array.isArray(j) ? j[0] : j;
      if (!res || res.error) {
        const ex = (res && res.exception) || j || {};
        if (['servicerequireslogin', 'invalidsesskey'].includes(ex.errorcode)) throw this.expired();
        const err = new Error(`${methodname}: ${ex.errorcode || ''} ${ex.message || ''}`.trim());
        err.code = ex.errorcode;
        throw err;
      }
      return res.data;
    }
  }

  const REMOVE_SELECTORS = [
    'script', 'noscript', 'template', 'link[rel="stylesheet"]', '.activity-navigation', '#ai-drawer', '.ai-drawer',
    '.completion-info', '[data-region="completion-info"]', 'button[data-action="toggle-manual-completion"]',
    '.tertiary-navigation', '.urlselect', '[data-container="discussion-tools"]', '.drawer', '.drawer-toggles',
    'input[name="sesskey"]', '.modal', '.bulkselect', '#user-notifications', '.skip-block', '.skip-links', '.singlebutton',
    '[data-region="footer-container-popover"]', '.comment-ctrl .comment-template',
  ];

  function cleanDom(root) {
    root.querySelectorAll(REMOVE_SELECTORS.join(',')).forEach((e) => e.remove());
    for (const el of root.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        else if ((a.name === 'href' || a.name === 'src') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      }
    }
    // Make embedded players visible offline as plain links.
    for (const f of root.querySelectorAll('iframe[src]')) {
      const src = abs(f.getAttribute('src'));
      if (!src) continue;
      const a = root.ownerDocument.createElement('a');
      a.className = 'xp-embed';
      a.target = '_blank';
      const h5p = /\/h5p\/embed\.php/.test(src) ? new URL(src).searchParams.get('url') : null;
      if (h5p) {
        a.href = h5p;
        a.textContent = `H5P package: ${safeDecode(fileNameFromUrl(h5p)) || 'download'}`;
      } else {
        a.href = src;
        a.textContent = `Embedded content: ${src}`;
      }
      f.after(a);
    }
  }

  const mainOf = (doc) => doc.querySelector('#region-main') || doc.querySelector('[role="main"]') || doc.body;

  function isBounce(finalUrl, requested) {
    try {
      const f = new URL(finalUrl);
      const r = new URL(requested, ORIGIN);
      if (f.origin !== ORIGIN) return /passport|\/login/i.test(f.href); // files are served from a CDN
      if (f.pathname === r.pathname) return false;
      return /^\/(course\/view\.php|my\/|enrol\/index\.php|login\/|index\.php$|$)/.test(f.pathname);
    } catch { return false; }
  }

  // ------------------------------------------------------------ course job

  class CourseJob {
    constructor(x, course, dir) {
      this.x = x;
      this.http = x.http;
      this.opts = x.opts;
      this.course = course;
      this.id = course.id;
      this.dir = dir;
      this.names = new Names();
      this.assets = new Map(); // normKey -> { path, promise }
      this.links = new Map(); // normKey -> { path, hash }
      this.visited = new Set();
      this.cmById = new Map();
      this.secById = new Map();
      this.cmDom = new Map(); // cmid -> element on the section page
      this.secDom = new Map(); // sectionid -> { summary, availability }
      this.extraSections = [];
      this.previous = new Map(); // cmid -> path from the last export
      this.instructors = [];
      this.counts = { items: 0, ok: 0, errors: 0, restricted: 0, files: 0 };
      this.indexPath = `${dir}/index.html`;
      this.names.reserve(this.indexPath);
    }

    log(msg, level) { this.x.log(msg, level); }

    courseCrumbs() {
      return [{ title: 'All courses', path: 'index.html' }, { title: this.course.fullname, path: this.indexPath }];
    }

    // ---- main flow

    async run() {
      const c = this.course;
      let state;
      try {
        state = JSON.parse(await this.http.ajax('core_courseformat_get_state', { courseid: c.id }));
      } catch (e) {
        if (isAbort(e)) throw e;
        return this.unavailable(e);
      }
      this.state = state;
      for (const s of state.section) { s.title = decode(s.title); this.secById.set(String(s.id), s); }
      for (const m of state.cm) { m.name = decode(m.name); this.cmById.set(String(m.id), m); }

      this.previous = await this.loadPrevious();
      await this.loadSectionPages();
      this.plan();
      await this.saveExtras();

      const items = [...this.cmById.values()].filter((cm) => cm.planned && !['label', 'subsection'].includes(cm.module));
      this.counts.items = items.length;
      this.x.stats.itemsTotal = items.length;
      this.x.stats.itemsDone = 0;
      this.x.ui.update();
      // Files first, so pages that link to them can point at the local copy.
      const early = new Set(['resource', 'url', 'folder']);
      await runPool(items.filter((cm) => early.has(cm.module)), 3, (cm) => this.exportItem(cm), this.x);
      await runPool(items.filter((cm) => !early.has(cm.module)), 2, (cm) => this.exportItem(cm), this.x);
      await Promise.all([...this.assets.values()].map((a) => a.promise));
      if (this.x.abort.signal.aborted) throw this.x.fatal || new DOMException('Aborted', 'AbortError');

      await this.writeIndex();
      await this.writeJson();
      return { status: 'ok', ...this.counts };
    }

    /** Paths saved by the last export of this course (cmid -> path), so files are not fetched again. */
    async loadPrevious() {
      if (!this.opts.skipExisting) return new Map();
      try {
        const j = JSON.parse((await this.x.sink.read(`${this.dir}/course.json`)) || 'null');
        return new Map((j?.items || []).filter((i) => i.status === 'ok' && i.path).map((i) => [String(i.id), `${this.dir}/${i.path}`]));
      } catch {
        return new Map();
      }
    }

    async unavailable(err) {
      let note = err.code === 'requireloginerror' ? 'Course is not available to students' : err.message;
      try {
        const { doc } = await this.http.page(`${ORIGIN}/course/view.php?id=${this.id}`);
        const msg = text(doc.querySelector('#notice, .alert, [role="main"] .box'));
        if (msg) note = msg.replace(/\s*Continue\s*$/, '');
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      this.log(`   ${this.course.fullname}: ${note}`, 'warn');
      return { status: 'unavailable', note };
    }

    // ---- read section pages for summaries, labels, descriptions

    async loadSectionPages() {
      const top = this.state.section.filter((s) => !s.component);
      const read = async (s) => {
        let res;
        try {
          res = await this.http.page(s.sectionurl || `${ORIGIN}/course/view.php?id=${this.id}&section=${s.number}`);
        } catch (e) {
          if (isAbort(e)) throw e;
          this.log(`   section "${s.title}": ${e.message}`, 'warn');
          return;
        }
        const doc = res.doc;
        for (const el of doc.querySelectorAll('[data-for="cmitem"][data-id]')) {
          if (!this.cmDom.has(el.dataset.id)) this.cmDom.set(el.dataset.id, el);
        }
        for (const el of doc.querySelectorAll('[data-for="section"][data-id]')) {
          if (this.secDom.has(el.dataset.id)) continue;
          const own = (sel) => [...el.querySelectorAll(sel)].find((n) => n.closest('[data-for="section"]') === el);
          this.secDom.set(el.dataset.id, {
            summary: own('[data-for="sectioninfo"] .summarytext, .summarytext')?.innerHTML || '',
            availability: text(own('.section_availability')),
          });
        }
      };
      await Promise.all(top.map(read));
      // Delegated sections (subsections) are normally rendered inside their parent.
      const missing = this.state.section.filter((s) => s.component && !this.secDom.has(String(s.id)));
      await Promise.all(missing.map(read));
    }

    // ---- decide where everything goes on disk

    plan() {
      const topSections = this.state.course.sectionlist.map((id) => this.secById.get(String(id))).filter((s) => s && !s.component);
      this.links.set(normKey(`${ORIGIN}/course/view.php?id=${this.id}`), { path: this.indexPath });
      for (const s of this.state.section) {
        const target = { path: this.indexPath, hash: `section-${s.id}` };
        this.links.set(normKey(s.sectionurl || `${ORIGIN}/course/section.php?id=${s.id}`), target);
        this.links.set(normKey(`${ORIGIN}/course/view.php?id=${this.id}&section=${s.number}`), target);
      }
      for (const s of topSections) {
        const dir = this.names.take(this.dir, safeName(`${pad(s.number)} - ${s.title || `Section ${s.number}`}`, LIMITS.section, false), { isDir: true });
        this.planSection(s, dir);
      }
      // Activities you can open but that no visible section lists (e.g. "stealth" activities in hidden sections).
      const unlisted = [...this.cmById.values()].filter((cm) => !cm.planned && cm.uservisible && !['label', 'subsection'].includes(cm.module));
      if (unlisted.length) {
        const sec = { id: 'unlisted', number: 99, title: 'Unlisted activities', cmlist: unlisted.map((cm) => String(cm.id)) };
        this.secDom.set('unlisted', { summary: '<p class="xp-note">Available to you, but not shown on the course page (for example inside a hidden section).</p>' });
        this.extraSections.push(sec);
        this.planSection(sec, this.names.take(this.dir, '_Unlisted activities', { isDir: true }));
      }
    }

    planSection(sec, dir) {
      sec.dir = dir;
      sec.planned = true;
      sec.cmlist.forEach((cmid, idx) => {
        const cm = this.cmById.get(String(cmid));
        if (!cm || cm.planned) return;
        cm.planned = true;
        cm.sec = sec;
        cm.prefix = pad(idx + 1);
        cm.crumbs = [...this.courseCrumbs(), { title: sec.title, path: this.indexPath, hash: `section-${sec.id}` }];
        if (cm.module === 'label') return;
        if (cm.module === 'subsection') {
          const child = this.secById.get(String(cm.delegatesectionid));
          if (child && !child.planned) {
            const cdir = this.names.take(dir, safeName(`${cm.prefix} - ${cm.name}`, LIMITS.item, false), { isDir: true });
            this.planSection(child, cdir);
          }
          return;
        }
        if (cm.module === 'resource') return; // file name is known only after download
        if (cm.module === 'url') {
          cm.path = this.names.take(dir, `${safeName(`${cm.prefix} - ${cm.name}`, LIMITS.item, false)} (link).html`);
        } else {
          cm.dir = this.names.take(dir, safeName(`${cm.prefix} - ${cm.name}`, LIMITS.item, false), { isDir: true });
          cm.path = `${cm.dir}/index.html`;
        }
        this.links.set(`CM:${cm.id}`, { path: cm.path });
      });
    }

    // ---- course-level pages

    async saveExtras() {
      const crumbs = this.courseCrumbs();
      const assetDir = `${this.dir}/_files`;
      try {
        const r = await this.savePage({
          url: `${ORIGIN}/course/info.php?id=${this.id}`, path: `${this.dir}/course-info.html`, title: 'Course information',
          crumbs, assetDir, main: '[role="main"]',
          prepare: ({ main }) => {
            this.instructors = [...main.querySelectorAll('.course-contacts .contact')]
              .map((c) => [text(c.querySelector('.name')), text(c.querySelector('.role'))].filter(Boolean).join(' — '))
              .filter(Boolean);
          },
        });
        this.hasInfo = r.status === 'ok';
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      if (this.opts.grades) {
        try {
          const r = await this.savePage({
            url: `${ORIGIN}/grade/report/user/index.php?id=${this.id}`, path: `${this.dir}/grades.html`, title: 'My grades',
            crumbs, assetDir, main: '[role="main"]',
          });
          this.hasGrades = r.status === 'ok';
        } catch (e) {
          if (isAbort(e)) throw e;
          this.log(`   grades: ${e.message}`, 'warn');
        }
      }
    }

    // ---- per-activity export

    async exportItem(cm) {
      try {
        if (!cm.uservisible) {
          cm.status = 'restricted';
          cm.note = this.availabilityOf(cm) || 'Not available to you';
          this.counts.restricted++;
          return;
        }
        if (cm.module === 'forum' && !this.opts.forums) {
          cm.status = 'skipped';
          cm.note = 'Forums disabled in options';
          return;
        }
        const handler = this[`export_${cm.module}`] || this.exportGeneric;
        const r = (await handler.call(this, cm)) || {};
        cm.status = r.status || 'ok';
        if (r.note) cm.note = r.note;
        if (r.path) cm.path = r.path;
        if (r.target) cm.target = r.target;
        if (cm.status === 'ok') this.counts.ok++;
        if (cm.status === 'unavailable') this.counts.restricted++;
      } catch (e) {
        if (isAbort(e)) throw e;
        cm.status = 'error';
        cm.note = e.message;
        this.counts.errors++;
        this.log(`   ✗ ${cm.name} [${cm.module}]: ${e.message}`, 'error');
      } finally {
        // Pages written later should link to eClass, not to a local file that does not exist.
        if (cm.status !== 'ok') this.links.delete(`CM:${cm.id}`);
        this.x.stats.itemsDone++;
        this.x.ui.update();
      }
    }

    availabilityOf(cm) {
      const el = this.cmDom.get(String(cm.id));
      return el ? text(el.querySelector('.availabilityinfo, [data-region="availabilityinfo"]')) : '';
    }

    exportGeneric(cm) {
      return this.savePage({ url: cm.url, path: cm.path, title: cm.name, crumbs: cm.crumbs });
    }

    async export_resource(cm) {
      if (!this.opts.files) return { status: 'ok', note: 'Files disabled in options' };
      // The CDN often omits Content-Length and the name comes from the response,
      // so resuming relies on the path recorded in the previous course.json.
      const saved = this.previous.get(String(cm.id));
      if (saved && (await this.x.sink.exists(saved)) > 0) {
        this.names.reserve(saved);
        this.links.set(`CM:${cm.id}`, { path: saved });
        this.x.stats.existing++;
        return { status: 'ok', path: saved, note: 'already saved' };
      }
      const url = `${ORIGIN}/mod/resource/view.php?id=${cm.id}&redirect=1`;
      return this.http.files(async () => {
        let r = await this.http.fetch(url);
        if (isBounce(r.url, url)) {
          r.body?.cancel();
          return { status: 'unavailable', note: 'Not accessible' };
        }
        const ct = r.headers.get('content-type') || '';
        if (ct.startsWith('text/html') && new URL(r.url).pathname.startsWith('/mod/resource/')) {
          // Display mode "embed"/"popup" without redirect: find the file on the page.
          const doc = parseHtml(await r.text());
          const el = mainOf(doc).querySelector('a[href*="/mod_resource/content/"], [src*="/mod_resource/content/"], object[data*="/mod_resource/content/"]');
          const fileUrl = el && abs(el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data'), r.url);
          if (!fileUrl) return { status: 'error', note: 'No file found on resource page' };
          r = await this.http.fetch(fileUrl);
        }
        if (!r.ok) {
          r.body?.cancel();
          return { status: 'error', note: `HTTP ${r.status}` };
        }
        let filename = filenameFromDisposition(r.headers.get('content-disposition')) || fileNameFromUrl(r.url);
        let [, ext] = splitExt(filename || '');
        if (!ext) ext = MIME_EXT[(r.headers.get('content-type') || '').split(';')[0].trim()] || '';
        let base = `${cm.prefix} - ${cm.name}`;
        if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length);
        const path = this.names.take(cm.sec.dir, safeName(base, LIMITS.item, false) + ext, { salt: String(cm.id) });
        const res = await this.saveResponse(r, path);
        if (!res.ok) return { status: res.tooBig ? 'skipped' : 'error', note: res.note };
        this.links.set(`CM:${cm.id}`, { path });
        return { status: 'ok', path, note: res.size ? fmtBytes(res.size) : '' };
      });
    }

    async export_url(cm) {
      const url = `${ORIGIN}/mod/url/view.php?id=${cm.id}&forceview=1`;
      const res = await this.http.page(url);
      if (isBounce(res.url, url)) return { status: 'unavailable', note: 'Not accessible' };
      const doc = res.doc;
      const main = mainOf(doc);
      let target = main.querySelector('.urlworkaround a')?.getAttribute('href');
      if (!target) {
        const f = [...doc.querySelectorAll('frame[src], iframe[src], object[data], embed[src]')]
          .map((e) => e.getAttribute('src') || e.getAttribute('data'))
          .find((s) => s && !/\/mod\/url\/view\.php/.test(s));
        target = f || [...main.querySelectorAll('[role="main"] a[href]')].map((a) => a.getAttribute('href')).find((h) => !/eclass\.yorku\.ca/.test(h));
      }
      target = target ? abs(target, res.url) : null;
      const desc = mainOf(doc).querySelector('.activity-description, #intro');
      const holder = parseHtml('<div></div>').body.firstChild;
      holder.innerHTML = `${target ? `<p style="font-size:18px">🔗 <a href="${esc(target)}" target="_blank" rel="noopener">${esc(target)}</a></p>` : '<p>Link target not found.</p>'}${desc ? desc.outerHTML : ''}`;
      await this.writeLocalized(cm.path, cm.name, holder, res.url, cm.crumbs, `${cm.sec.dir}/_files`);
      return { status: target ? 'ok' : 'error', target, note: target ? '' : 'Link target not found' };
    }

    async export_folder(cm) {
      const res = await this.http.page(cm.url);
      let scope;
      if (isBounce(res.url, cm.url)) {
        // "Display inline on course page": the file tree lives on the section page.
        const el = this.cmDom.get(String(cm.id));
        if (!el) return { status: 'unavailable', note: 'Not accessible' };
        scope = el.cloneNode(true);
      } else {
        scope = mainOf(res.doc);
      }
      cleanDom(scope);
      if (this.opts.files) {
        for (const a of scope.querySelectorAll('a[href*="/mod_folder/content/"]')) {
          const u = abs(a.getAttribute('href'), res.url);
          if (!u || new URL(u).searchParams.has('preview')) continue;
          const key = normKey(u);
          if (this.assets.has(key)) continue;
          const m = /\/mod_folder\/content\/\d+\/(.+)$/.exec(new URL(u).pathname);
          const segs = (m ? m[1] : fileNameFromUrl(u)).split('/').map(safeDecode).filter(Boolean);
          const file = segs.pop() || 'file';
          const sub = segs.map((s) => safeName(s, LIMITS.folderSeg, false)).join('/');
          const path = this.names.take(sub ? `${cm.dir}/${sub}` : cm.dir, safeName(file, LIMITS.file), { salt: key });
          this.assets.set(key, { path, promise: this.download(u, path) });
        }
      }
      await this.writeLocalized(cm.path, cm.name, scope, res.url, cm.crumbs, `${cm.dir}/files`);
      return { status: 'ok' };
    }

    async export_book(cm) {
      const r = await this.savePage({
        url: `${ORIGIN}/mod/book/tool/print/index.php?id=${cm.id}`, path: cm.path, title: cm.name, crumbs: cm.crumbs, main: '[role="main"]',
      });
      return r.status === 'ok' ? r : this.exportGeneric(cm);
    }

    async export_glossary(cm) {
      const r = await this.savePage({
        url: `${ORIGIN}/mod/glossary/print.php?id=${cm.id}&mode=letter&hook=ALL&sortkey=&sortorder=asc&page=-1`,
        path: cm.path, title: cm.name, crumbs: cm.crumbs, main: '[role="main"]',
      });
      return r.status === 'ok' ? r : this.exportGeneric(cm);
    }

    export_data(cm) {
      // Follow the paging bar instead of passing perpage=, which eClass saves as a user preference.
      const pages = ({ main, url }) => {
        const kids = [];
        for (const a of main.querySelectorAll('a[href*="/mod/data/view.php"][href*="page="]')) {
          const u = new URL(abs(a.getAttribute('href'), url));
          const p = +u.searchParams.get('page');
          if (!p || [...u.searchParams.keys()].some((k) => !['id', 'd', 'page'].includes(k))) continue;
          kids.push({ keys: [normKey(u.href)], url: u.href, path: `${cm.dir}/index-p${p + 1}.html`, title: `${cm.name} (page ${p + 1})`, children: pages });
        }
        return kids;
      };
      return this.savePage({ url: cm.url, path: cm.path, title: cm.name, crumbs: cm.crumbs, children: pages });
    }

    export_quiz(cm) {
      return this.savePage({
        url: cm.url, path: cm.path, title: cm.name, crumbs: cm.crumbs,
        children: ({ main, url }) => {
          const kids = [];
          const seen = new Set();
          for (const a of main.querySelectorAll('a[href*="/mod/quiz/review.php"]')) {
            const u = new URL(abs(a.getAttribute('href'), url));
            const attempt = u.searchParams.get('attempt');
            if (!attempt || seen.has(attempt)) continue;
            seen.add(attempt);
            u.searchParams.set('showall', '1');
            u.searchParams.delete('page');
            kids.push({
              keys: [normKey(a.getAttribute('href') && abs(a.getAttribute('href'), url))],
              url: u.href, path: `${cm.dir}/attempt-${attempt}.html`, title: `${cm.name} — attempt review`,
            });
          }
          return kids;
        },
      });
    }

    export_lesson(cm) {
      // Only follows the lesson's own GET navigation menu; never posts answers.
      return this.savePage({
        url: cm.url, path: cm.path, title: cm.name, crumbs: cm.crumbs,
        children: ({ doc, url }) => {
          const kids = [];
          const seen = new Set();
          let n = 0;
          for (const a of doc.querySelectorAll('a[href*="/mod/lesson/view.php"][href*="pageid="]')) {
            const u = abs(a.getAttribute('href'), url);
            const pid = new URL(u).searchParams.get('pageid');
            if (!pid || seen.has(pid)) continue;
            seen.add(pid);
            const title = text(a) || `Page ${pid}`;
            kids.push({ keys: [normKey(u)], url: u, path: `${cm.dir}/pages/${pad(++n)} - ${safeName(title, LIMITS.child - 10, false)}.html`, title });
          }
          return kids;
        },
      });
    }

    export_wiki(cm) {
      return this.savePage({
        url: cm.url, path: cm.path, title: cm.name, crumbs: cm.crumbs,
        children: async ({ doc, url }) => {
          const pages = new Map(); // pageid -> title
          const collect = (root, base) => {
            for (const a of root.querySelectorAll('a[href*="/mod/wiki/view.php?pageid="], a[href*="/mod/wiki/prettyview.php?pageid="]')) {
              const pid = new URL(abs(a.getAttribute('href'), base)).searchParams.get('pageid');
              if (pid && (!pages.has(pid) || !pages.get(pid))) pages.set(pid, /prettyview/.test(a.getAttribute('href')) ? pages.get(pid) || '' : text(a));
            }
            for (const o of root.querySelectorAll('option[value*="/mod/wiki/view.php?pageid="]')) {
              const pid = new URL(abs(o.value, base)).searchParams.get('pageid');
              if (pid && !pages.has(pid)) pages.set(pid, '');
            }
          };
          collect(doc, url);
          const first = [...pages.keys()][0];
          const kids = [];
          if (!first) return kids;
          try {
            const map = await this.http.page(`${ORIGIN}/mod/wiki/map.php?pageid=${first}&option=5`);
            collect(mainOf(map.doc), map.url);
          } catch (e) {
            if (isAbort(e)) throw e;
          }
          for (const [pid, title] of pages) {
            const t = title || (pid === first ? cm.name : `Page ${pid}`);
            kids.push({
              keys: [`/mod/wiki/view.php?pageid=${pid}`, `/mod/wiki/prettyview.php?pageid=${pid}`],
              url: `${ORIGIN}/mod/wiki/prettyview.php?pageid=${pid}`,
              path: this.names.take(`${cm.dir}/pages`, `${safeName(t, LIMITS.child, false)}.html`, { salt: pid }),
              title: t, main: '[role="main"]',
            });
          }
          kids.push({
            keys: [`/mod/wiki/files.php?pageid=${first}`], url: `${ORIGIN}/mod/wiki/files.php?pageid=${first}`,
            path: `${cm.dir}/wiki-files.html`, title: `${cm.name} — files`,
          });
          return kids;
        },
      });
    }

    export_forum(cm) {
      const forumChildren = ({ main, url }) => {
        const kids = [];
        const seen = new Set();
        for (const a of main.querySelectorAll('a[href*="/mod/forum/discuss.php"]')) {
          const u = new URL(abs(a.getAttribute('href'), url));
          const d = u.searchParams.get('d');
          if (!d || u.searchParams.has('parent') || seen.has(d)) continue;
          seen.add(d);
          const title = (a.getAttribute('title') || text(a) || `Discussion ${d}`).trim();
          const path = `${cm.dir}/discussions/d${d} - ${safeName(title, LIMITS.child - 12, false)}.html`;
          kids.push({ keys: [`/mod/forum/discuss.php?d=${d}`], path, title, run: (k) => this.exportDiscussion(cm, +d, k) });
        }
        const forumUrl = new URL(cm.url);
        for (const a of main.querySelectorAll('a[href*="/mod/forum/view.php"]')) {
          const u = new URL(abs(a.getAttribute('href'), url));
          const p = +u.searchParams.get('p');
          if (!p || u.searchParams.get('id') !== forumUrl.searchParams.get('id')) continue;
          kids.push({ keys: [normKey(u.href)], url: u.href, path: `${cm.dir}/index-p${p + 1}.html`, title: `${cm.name} (page ${p + 1})`, children: forumChildren });
        }
        return kids;
      };
      return this.savePage({ url: cm.url, path: cm.path, title: cm.name, crumbs: cm.crumbs, children: forumChildren });
    }

    async exportDiscussion(cm, d, k) {
      let data;
      try {
        data = await this.http.ajax('mod_forum_get_discussion_posts', {
          discussionid: d, sortby: 'created', sortdirection: 'ASC', includeinlineattachments: true,
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        return this.savePage({ ...k, url: `${ORIGIN}/mod/forum/discuss.php?d=${d}`, main: '[role="main"]' });
      }
      const posts = data.posts || [];
      const doc = parseHtml('<div class="xp-discussion"></div>');
      const root = doc.body.firstChild;
      const children = new Map();
      for (const p of posts) {
        const parent = p.parentid || 0;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(p);
      }
      const ids = new Set(posts.map((p) => p.id));
      const render = (p, depth) => {
        const art = doc.createElement('article');
        art.className = 'xp-post';
        art.id = `p${p.id}`;
        art.style.marginLeft = `${Math.min(depth, 8) * 24}px`;
        const files = (p.attachments || [])
          .map((f) => `<li><a href="${esc(f.url || f.fileurl)}">${esc(f.filename)}</a> <span class="xp-note">${esc(fmtBytes(f.filesize))}</span></li>`)
          .join('');
        art.innerHTML = `<header><div class="xp-subject">${esc(p.subject)}${p.isprivatereply ? ' <span class="xp-badge">private</span>' : ''}</div>
<div class="xp-meta">by ${esc(p.author?.fullname || 'Unknown')} · ${esc(fmtTime(p.timecreated))}${p.timemodified && p.timemodified !== p.timecreated ? ` · edited ${esc(fmtTime(p.timemodified))}` : ''}</div></header>
<div class="xp-post-body">${p.isdeleted ? '<em>(deleted)</em>' : p.message || ''}</div>${files ? `<ul class="xp-attach">${files}</ul>` : ''}`;
        root.appendChild(art);
        for (const c of children.get(p.id) || []) render(c, depth + 1);
      };
      for (const p of posts) if (!p.parentid || !ids.has(p.parentid)) render(p, 0);
      cleanDom(root);
      await this.writeLocalized(k.path, k.title, root, `${ORIGIN}/mod/forum/discuss.php?d=${d}`, k.crumbs, `${cm.dir}/files`);
      return { status: 'ok' };
    }

    // ---- generic page saving with optional child pages

    async savePage({ url, path, title, crumbs, main: mainSel, prepare, children, assetDir }) {
      const res = await this.http.page(url);
      if (isBounce(res.url, url)) return { status: 'unavailable', note: 'Not accessible' };
      if (res.status >= 400) return { status: 'error', note: `HTTP ${res.status}` };
      const doc = res.doc;
      const main = (mainSel && doc.querySelector(mainSel)) || mainOf(doc);
      cleanDom(main);
      const ctx = { doc, main, url: res.url };
      if (prepare) await prepare(ctx);
      const kids = children ? (await children(ctx)).filter((k) => {
        k.keys = k.keys.filter(Boolean);
        return k.keys.every((key) => !this.visited.has(key));
      }) : [];
      for (const k of kids) {
        for (const key of k.keys) { this.visited.add(key); this.links.set(key, { path: k.path }); }
        this.names.reserve(k.path);
      }
      await this.writeLocalized(path, title || doc.title, main, res.url, crumbs, assetDir);
      const childCrumbs = [...crumbs, { title, path }];
      await Promise.all(kids.map(async (k) => {
        try {
          const kk = { ...k, crumbs: childCrumbs, assetDir: assetDir || `${dirname(path)}/files` };
          const r = k.run ? await k.run(kk) : await this.savePage(kk);
          if (r && r.status !== 'ok') this.log(`   · ${k.title}: ${r.note || r.status}`, 'warn');
        } catch (e) {
          if (isAbort(e)) throw e;
          this.log(`   ✗ ${k.title}: ${e.message}`, 'error');
        }
      }));
      return { status: 'ok', path };
    }

    /** Rewrite links/assets in `root` to local paths, download assets, write the page. */
    async writeLocalized(path, title, root, baseUrl, crumbs, assetDir, { heading = true } = {}) {
      assetDir = assetDir || `${dirname(path)}/files`;
      const pending = [];
      for (const el of root.querySelectorAll('[href],[src],[data],[poster]')) {
        if (el.hasAttribute('data-xp-keep')) { el.removeAttribute('data-xp-keep'); continue; }
        for (const attr of ['href', 'src', 'data', 'poster']) {
          const raw = el.getAttribute(attr);
          if (!raw || raw.startsWith('#') || /^(mailto|tel|data|blob):/i.test(raw)) continue;
          if (attr === 'data' && el.tagName !== 'OBJECT') continue;
          const u = abs(raw, baseUrl);
          if (!u) continue;
          const key = normKey(u);
          const link = el.tagName !== 'IMG' && this.links.get(key);
          if (link) {
            el.setAttribute(attr, relHref(path, link.path, link.hash || new URL(u).hash.slice(1)));
            continue;
          }
          if (isPluginfile(u)) {
            if (/\/user\/icon\//.test(u)) { if (el.tagName === 'IMG') el.remove(); continue; }
            if (new URL(u).searchParams.has('preview')) { if (el.tagName === 'IMG') el.remove(); continue; }
            if (!this.opts.files) { el.setAttribute(attr, u); continue; }
            const asset = this.asset(u, assetDir);
            el.setAttribute(attr, relHref(path, asset.path));
            pending.push({ el, attr, u, asset });
            continue;
          }
          el.setAttribute(attr, u);
          if (el.tagName === 'A' && new URL(u).origin !== ORIGIN) el.setAttribute('target', '_blank');
        }
      }
      root.querySelectorAll('[srcset]').forEach((e) => e.removeAttribute('srcset'));
      const results = await Promise.all(pending.map((p) => p.asset.promise));
      results.forEach((r, i) => {
        if (r.ok) return;
        const { el, attr, u } = pending[i];
        el.setAttribute(attr, u); // fall back to the online copy
        el.classList.add('xp-missing');
        el.setAttribute('title', `Not saved: ${r.note || 'download failed'}`);
      });
      await this.x.sink.write(path, pageHtml({ title, body: root.innerHTML, crumbs, pagePath: path, source: baseUrl, heading }));
    }

    asset(u, dir) {
      const key = normKey(u);
      let a = this.assets.get(key);
      if (!a) {
        const path = this.names.take(dir, safeName(fileNameFromUrl(u) || 'file', LIMITS.file), { salt: key });
        a = { path, promise: this.download(u, path) };
        this.assets.set(key, a);
      }
      return a;
    }

    /** Download `url` to `path`. Never throws except on abort/session expiry. */
    download(url, path) {
      return this.http.files(async () => {
        try {
          if (this.opts.skipExisting) {
            const size = await this.x.sink.exists(path);
            if (size > 0) { this.x.stats.existing++; return { ok: true, size, existed: true }; }
          }
          const r = await this.http.fetch(url);
          if (!r.ok) { r.body?.cancel(); return { ok: false, note: `HTTP ${r.status}` }; }
          return await this.saveResponse(r, path);
        } catch (e) {
          if (isAbort(e)) throw e;
          this.log(`   ✗ file ${fileNameFromUrl(url) || url}: ${e.message}`, 'error');
          return { ok: false, note: e.message };
        }
      });
    }

    async saveResponse(r, path) {
      const max = this.opts.maxMB > 0 ? this.opts.maxMB * 1024 * 1024 : 0;
      const len = +r.headers.get('content-length') || 0;
      if (max && len > max) {
        r.body?.cancel();
        this.x.stats.tooBig++;
        this.log(`   ⤼ skipped ${path.split('/').pop()} (${fmtBytes(len)} > ${this.opts.maxMB} MB)`, 'warn');
        return { ok: false, tooBig: true, note: `skipped: ${fmtBytes(len)} is over the size limit` };
      }
      if (this.opts.skipExisting && len) {
        const have = await this.x.sink.exists(path);
        if (have === len) { r.body?.cancel(); this.x.stats.existing++; return { ok: true, size: len, existed: true }; }
      }
      let size = 0;
      const x = this.x;
      const counted = r.body
        ? r.body.pipeThrough(new TransformStream({
          transform(chunk, ctl) {
            size += chunk.byteLength;
            x.stats.bytes += chunk.byteLength;
            if (max && size > max) { ctl.error(new Error('over the size limit')); return; }
            ctl.enqueue(chunk);
          },
        }))
        : new Blob([]);
      await this.x.sink.write(path, counted);
      this.x.stats.files++;
      this.counts.files++;
      this.x.ui.update();
      return { ok: true, size };
    }

    // ---- course index & metadata

    async writeIndex() {
      const c = this.course;
      const doc = parseHtml('<div class="xp-course"></div>');
      const root = doc.body.firstChild;
      const facts = [
        ['Course', c.shortname],
        ['Category', c.coursecategory],
        ['Dates', [fmtDate(c.startdate), fmtDate(c.enddate)].filter(Boolean).join(' – ')],
        ['Instructors', this.instructors.join(', ')],
        ['Progress', c.hasprogress ? `${Math.round(c.progress)}% complete` : ''],
      ].filter(([, v]) => v);
      const img = c.courseimage && isPluginfile(c.courseimage) ? `<img src="${esc(c.courseimage)}" alt="">` : '';
      const links = [
        this.hasInfo && `<a data-xp-keep href="course-info.html">Course information</a>`,
        this.hasGrades && `<a data-xp-keep href="grades.html">My grades</a>`,
        `<a data-xp-keep href="course.json">course.json</a>`,
        `<a data-xp-keep href="${esc(`${ORIGIN}/course/view.php?id=${this.id}`)}" target="_blank" rel="noopener">Open on eClass ↗</a>`,
      ].filter(Boolean).join('');
      root.innerHTML = `<div class="xp-course-head">${img}<dl class="xp-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
<div class="xp-links">${links}</div>${c.summary ? `<div class="xp-summary">${c.summary}</div>` : ''}`;
      const topSections = this.state.course.sectionlist.map((id) => this.secById.get(String(id))).filter((s) => s && !s.component);
      for (const s of [...topSections, ...this.extraSections]) root.appendChild(this.renderSection(doc, s, 2));
      cleanDom(root);
      await this.writeLocalized(this.indexPath, c.fullname, root, `${ORIGIN}/course/view.php?id=${this.id}`,
        [{ title: 'All courses', path: 'index.html' }], `${this.dir}/_files`);
    }

    renderSection(doc, s, level) {
      const sec = doc.createElement('section');
      sec.className = 'xp-section';
      sec.id = `section-${s.id}`;
      const info = this.secDom.get(String(s.id)) || {};
      sec.innerHTML = `<h${level}>${esc(s.title || `Section ${s.number}`)}</h${level}>${info.availability ? `<p class="xp-note">${esc(info.availability)}</p>` : ''}${info.summary || ''}`;
      const ul = doc.createElement('ul');
      ul.className = 'xp-items';
      for (const cmid of s.cmlist) {
        const cm = this.cmById.get(String(cmid));
        if (!cm || cm.sec !== s) continue;
        const el = this.cmDom.get(String(cm.id));
        const alt = el?.querySelector('.activity-altcontent')?.innerHTML || '';
        const li = doc.createElement('li');
        if (cm.module === 'label') {
          li.className = 'xp-label';
          li.innerHTML = alt;
        } else if (cm.module === 'subsection') {
          li.className = 'xp-subsection';
          const child = this.secById.get(String(cm.delegatesectionid));
          if (child) li.appendChild(this.renderSection(doc, child, Math.min(level + 1, 6)));
        } else {
          li.className = 'xp-item';
          // The eClass URL is mapped to the local copy by writeLocalized (via the CM: link key).
          const note = cm.status && cm.status !== 'ok' ? `${cm.status}${cm.note ? `: ${cm.note}` : ''}` : cm.note || '';
          const dates = text(el?.querySelector('[data-region="activity-dates"]'));
          li.innerHTML = `<div class="xp-row"><span class="xp-badge">${esc(decode(cm.modname || cm.module))}</span>
<a class="xp-name" href="${esc(cm.url || `${ORIGIN}/mod/${cm.module}/view.php?id=${cm.id}`)}">${esc(cm.name)}</a>
${cm.target ? `<a class="xp-note" href="${esc(cm.target)}" target="_blank" rel="noopener">${esc(cm.target)}</a>` : ''}
${note ? `<span class="xp-note${cm.status === 'error' ? ' err' : ''}">${esc(note)}</span>` : ''}
${cm.url ? `<a class="xp-note" data-xp-keep href="${esc(cm.url)}" target="_blank" rel="noopener">eClass ↗</a>` : ''}</div>
${dates ? `<div class="xp-desc xp-note">${esc(dates)}</div>` : ''}${alt ? `<div class="xp-desc">${alt}</div>` : ''}`;
        }
        ul.appendChild(li);
      }
      sec.appendChild(ul);
      return sec;
    }

    async writeJson() {
      const items = [...this.cmById.values()].map((cm) => ({
        id: +cm.id, name: cm.name, module: cm.module, section: cm.sec ? cm.sec.title : null, url: cm.url || null,
        path: cm.path ? cm.path.slice(this.dir.length + 1) : null, status: cm.status || (cm.module === 'label' ? 'inline' : null),
        note: cm.note || null, target: cm.target || null, visible: cm.uservisible,
      }));
      const data = {
        exporter: `eClass Exporter ${VERSION}`, exportedAt: new Date().toISOString(), source: `${ORIGIN}/course/view.php?id=${this.id}`,
        course: this.course, instructors: this.instructors, counts: this.counts, items, state: this.state,
      };
      await this.x.sink.write(`${this.dir}/course.json`, JSON.stringify(data, null, 2));
    }
  }

  // --------------------------------------------------------------- exporter

  class Exporter {
    constructor(opts, sink, ui) {
      this.opts = opts;
      this.sink = sink;
      this.ui = ui;
      this.abort = new AbortController();
      this.fatal = null;
      this.stats = { requests: 0, pages: 0, files: 0, bytes: 0, existing: 0, tooBig: 0, errors: 0, warnings: 0, itemsTotal: 0, itemsDone: 0, courseIndex: 0, courseTotal: 0 };
      this.http = new Http(this);
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

    async listCourses() {
      let data;
      try {
        data = await this.http.ajax('core_course_get_enrolled_courses_by_timeline_classification', { classification: 'allincludinghidden', limit: 0, offset: 0, sort: 'fullname' });
      } catch (e) {
        if (isAbort(e)) throw e;
        data = await this.http.ajax('core_course_get_enrolled_courses_by_timeline_classification', { classification: 'all', limit: 0, offset: 0, sort: 'fullname' });
      }
      return data.courses.map((c) => ({ ...c, fullname: decode(c.fullname), shortname: decode(c.shortname), coursecategory: decode(c.coursecategory) }));
    }

    async run(courseIds) {
      const started = Date.now();
      const all = await this.listCourses();
      const targets = courseIds.map((id) => all.find((c) => c.id === id) || { id, fullname: `Course ${id}`, shortname: '' });
      let prev = { courses: [] };
      try { prev = JSON.parse((await this.sink.read('courses.json')) || '{"courses":[]}'); } catch { /* fresh folder */ }
      const names = new Names();
      names.reserve('index.html');
      names.reserve('courses.json');
      const dirFor = new Map();
      for (const p of prev.courses) if (p.dir) { names.reserve(p.dir); dirFor.set(p.id, p.dir); }
      this.stats.courseTotal = targets.length;
      const results = new Map(prev.courses.map((p) => [p.id, p]));
      try {
        for (const c of targets) {
          this.stats.courseIndex++;
          const dir = dirFor.get(c.id) || names.take('', safeName(c.fullname, LIMITS.course, false), { salt: String(c.id), isDir: true });
          this.log(`▶ [${this.stats.courseIndex}/${targets.length}] ${c.fullname}`);
          this.ui.update();
          await this.sink.open(dir);
          let r;
          try {
            r = await new CourseJob(this, c, dir).run();
          } catch (e) {
            if (isAbort(e)) throw e;
            this.log(`✗ ${c.fullname}: ${e.message}`, 'error');
            r = { status: 'error', note: e.message };
          } finally {
            if (!this.abort.signal.aborted) await this.sink.close();
          }
          results.set(c.id, {
            id: c.id, fullname: c.fullname, shortname: c.shortname, category: c.coursecategory, startdate: c.startdate, enddate: c.enddate,
            dir: r.status === 'ok' ? dir : dirFor.get(c.id) || null, exportedAt: new Date().toISOString(), ...r,
          });
          if (r.status === 'ok') this.log(`✓ ${c.fullname}: ${r.ok}/${r.items} items, ${r.files} files${r.errors ? `, ${r.errors} errors` : ''}`, 'ok');
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

    async writeRootIndex(courses) {
      courses.sort((a, b) => (b.startdate || 0) - (a.startdate || 0) || String(a.fullname).localeCompare(b.fullname));
      const rows = courses.map((c) => {
        const name = c.dir ? `<a href="${esc(`${encodeURIComponent(c.dir)}/index.html`)}">${esc(c.fullname)}</a>` : esc(c.fullname);
        const status = c.status === 'ok' ? `${c.ok}/${c.items} items · ${c.files} new files${c.errors ? ` · <span class="xp-note err">${c.errors} errors</span>` : ''}` : `<span class="xp-note">${esc(c.note || c.status)}</span>`;
        return `<tr><td>${name}<div class="xp-note">${esc(c.shortname || '')}</div></td><td>${esc(c.category || '')}</td><td>${esc([fmtDate(c.startdate), fmtDate(c.enddate)].filter(Boolean).join(' – '))}</td><td>${status}</td><td class="xp-note">${esc(new Date(c.exportedAt).toLocaleString())}</td></tr>`;
      }).join('\n');
      const echo = this.sink.kind === 'folder' && (await this.sink.exists('Echo360/index.html')) > 0;
      const body = `${echo ? '<p><a href="Echo360/index.html">Echo360 lecture recordings →</a></p>' : ''}<p class="xp-note">${courses.filter((c) => c.status === 'ok').length} of ${courses.length} courses saved from <a href="${ORIGIN}">${ORIGIN}</a>.</p>
<table class="xp-courses"><thead><tr><th>Course</th><th>Term</th><th>Dates</th><th>Contents</th><th>Saved</th></tr></thead><tbody>${rows}</tbody></table>`;
      if (this.sink.kind === 'zip') await this.sink.open('eClass-index');
      await this.sink.write('index.html', pageHtml({ title: 'eClass backup', body, pagePath: 'index.html' }));
      await this.sink.write('courses.json', JSON.stringify({ exporter: `eClass Exporter ${VERSION}`, updatedAt: new Date().toISOString(), courses }, null, 2));
      if (this.sink.kind === 'zip') await this.sink.close();
    }
  }

  // --------------------------------------------------------------------- UI

  class Panel {
    constructor() {
      this.courseId = (() => {
        const m = /(?:^|\s)course-(\d+)(?:\s|$)/.exec(document.body.className);
        return m && m[1] !== '1' ? +m[1] : null;
      })();
      const host = document.createElement('div');
      host.id = 'eclass-exporter';
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${UI_CSS}</style>
<button class="fab" part="fab">⬇ Export eClass</button>
<div class="panel" hidden>
  <header><b>eClass Exporter <span class="muted">v${VERSION}</span></b><button class="close" title="Close">×</button></header>
  <div class="body">
    <div class="row">
      <button class="btn primary" data-act="this" ${this.courseId ? '' : 'hidden'}>Export this course</button>
      <button class="btn" data-act="pick">Choose courses…</button>
    </div>
    <div class="picker" hidden>
      <div class="row"><input type="search" placeholder="Filter courses"><button class="btn" data-act="all">All</button><button class="btn" data-act="none">None</button></div>
      <div class="list muted">Loading…</div>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-act="selected" disabled>Export selected</button><span class="muted sel"></span></div>
    </div>
    <fieldset><legend>Options</legend>
      <label><input type="radio" name="mode" value="folder"> Save to a folder <span class="muted">(Chrome/Edge, resumable)</span></label>
      <label><input type="radio" name="mode" value="zip"> Download a ZIP per course</label>
      <label><input type="checkbox" name="files" checked> Download files and attachments</label>
      <label><input type="checkbox" name="forums" checked> Forums and discussions</label>
      <label><input type="checkbox" name="grades" checked> My grades</label>
      <label><input type="checkbox" name="skipExisting" checked> Skip files already in the folder</label>
      <label>Skip files larger than <input type="number" name="maxMB" min="0" value="0"> MB <span class="muted">(0 = no limit)</span></label>
    </fieldset>
    <div class="progress" hidden>
      <div class="bar"><div></div></div>
      <div class="muted stat" style="margin-top:6px"></div>
    </div>
    <div class="log" hidden></div>
    <div class="row run" hidden><button class="btn" data-act="cancel">Cancel</button></div>
  </div>
</div>`;
      this.root = root;
      this.$ = (s) => root.querySelector(s);
      const canFolder = typeof window.showDirectoryPicker === 'function';
      const mode = canFolder ? 'folder' : 'zip';
      root.querySelector(`input[value="${mode}"]`).checked = true;
      if (!canFolder) root.querySelector('input[value="folder"]').disabled = true;
      this.$('.fab').onclick = () => { this.$('.panel').hidden = !this.$('.panel').hidden; };
      this.$('.close').onclick = () => { this.$('.panel').hidden = true; };
      root.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act) this.onAction(act);
      });
      this.$('input[type=search]').oninput = () => this.filter();
      this.x = null;
      window.addEventListener('beforeunload', (e) => {
        if (this.x) { e.preventDefault(); e.returnValue = ''; }
      });
    }

    options() {
      const r = this.root;
      return {
        mode: r.querySelector('input[name=mode]:checked').value,
        files: r.querySelector('input[name=files]').checked,
        forums: r.querySelector('input[name=forums]').checked,
        grades: r.querySelector('input[name=grades]').checked,
        skipExisting: r.querySelector('input[name=skipExisting]').checked,
        maxMB: Math.max(0, +r.querySelector('input[name=maxMB]').value || 0),
      };
    }

    async onAction(act) {
      if (act === 'this') return this.start([this.courseId]);
      if (act === 'pick') return this.showPicker();
      if (act === 'all' || act === 'none') {
        this.root.querySelectorAll('.list label:not([hidden]) input').forEach((i) => { i.checked = act === 'all'; });
        return this.updateSel();
      }
      if (act === 'selected') return this.start([...this.root.querySelectorAll('.list input:checked')].map((i) => +i.value));
      if (act === 'cancel' && this.x) this.x.cancel();
    }

    async showPicker() {
      const p = this.$('.picker');
      p.hidden = !p.hidden;
      if (p.hidden || this.courses) return;
      const list = this.$('.list');
      try {
        const x = new Exporter({}, null, this);
        this.courses = await x.listCourses();
      } catch (e) {
        list.textContent = `Could not load courses: ${e.message}`;
        return;
      }
      this.courses.sort((a, b) => (b.startdate || 0) - (a.startdate || 0));
      list.textContent = '';
      list.classList.remove('muted');
      for (const c of this.courses) {
        const l = document.createElement('label');
        const i = document.createElement('input');
        i.type = 'checkbox';
        i.value = c.id;
        i.checked = true;
        i.onchange = () => this.updateSel();
        const t = document.createElement('span');
        t.textContent = c.fullname;
        const cat = document.createElement('div');
        cat.className = 'cat';
        cat.textContent = `${c.coursecategory || ''} · ${fmtDate(c.startdate)}`;
        t.appendChild(cat);
        l.append(i, t);
        l.dataset.q = `${c.fullname} ${c.shortname} ${c.coursecategory}`.toLowerCase();
        list.appendChild(l);
      }
      this.updateSel();
    }

    filter() {
      const q = this.$('input[type=search]').value.toLowerCase().trim();
      this.root.querySelectorAll('.list label').forEach((l) => { l.hidden = q && !l.dataset.q.includes(q); });
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
        if (opts.mode === 'folder') {
          const dir = await window.showDirectoryPicker({ id: 'eclass-export', mode: 'readwrite', startIn: 'documents' });
          sink = new DirSink(dir);
        } else {
          sink = new ZipSink(downloadBlob);
        }
      } catch (e) {
        if (e.name !== 'AbortError') alert(`Could not open the folder: ${e.message}`);
        return;
      }
      await this.runWith(ids, opts, sink);
    }

    async runWith(ids, opts, sink) {
      if (this.x) throw new Error('An export is already running');
      this.$('.panel').hidden = false;
      this.$('.log').hidden = false;
      this.$('.log').textContent = '';
      this.$('.progress').hidden = false;
      this.$('.run').hidden = false;
      this.root.querySelectorAll('[data-act=this],[data-act=selected],[data-act=pick]').forEach((b) => { b.disabled = true; });
      const x = (this.x = new Exporter(opts, sink, this));
      this.log(`Saving ${ids.length} course${ids.length > 1 ? 's' : ''} ${sink.kind === 'folder' ? `into folder "${sink.root.name}"` : 'as ZIP downloads'}…`);
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
      if (!box) return;
      const line = document.createElement('div');
      line.className = level;
      line.textContent = msg;
      box.appendChild(line);
      while (box.childNodes.length > 600) box.firstChild.remove();
      box.scrollTop = box.scrollHeight;
      (level === 'error' ? console.warn : console.log)('[eClass Exporter]', msg);
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
      const pct = s.courseTotal ? ((Math.max(0, s.courseIndex - 1) + (s.itemsTotal ? s.itemsDone / s.itemsTotal : 0)) / s.courseTotal) * 100 : 0;
      this.$('.bar>div').style.width = `${Math.max(2, Math.min(100, pct)).toFixed(1)}%`;
      this.$('.stat').textContent = `Course ${s.courseIndex}/${s.courseTotal} · items ${s.itemsDone}/${s.itemsTotal} · ${s.files} files (${fmtBytes(s.bytes)}) · ${s.existing} already saved · ${s.errors} errors`;
    }
  }

  // ------------------------------------------------------------- bootstrap

  const api = {
    version: VERSION,
    Exporter, CourseJob, DirSink, ZipSink, Names, safeName, normKey, relHref,
    /** Scriptable entry point, e.g. from the console: eclassExporter.run([12345], { mode: 'zip' }) */
    async run(ids, opts = {}, sink) {
      const o = { mode: 'zip', files: true, forums: true, grades: true, skipExisting: true, maxMB: 0, ...opts };
      const s = sink || (o.mode === 'folder' ? new DirSink(await window.showDirectoryPicker({ mode: 'readwrite' })) : new ZipSink(downloadBlob));
      if (panel) return panel.runWith(ids, o, s);
      const x = new Exporter(o, s, { log: (m, l) => console.log('[eClass Exporter]', l || 'info', m), update() {} });
      await x.run(ids);
      return x.stats;
    },
    /** The exporter currently running from the panel, if any (for cancel()/stats). */
    get current() { return panel && panel.x; },
  };
  window[NS] = api;
  window.eclassExporter = api;

  let panel = null;
  const boot = () => {
    if (!document.body || document.getElementById('eclass-exporter')) return;
    if (!/\bpagelayout-/.test(document.body.className) && !document.querySelector('[data-region="drawer"]')) return; // not a Moodle page
    panel = new Panel();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  };

  const site_echo360 = () => {
/*
 * Echo360 Exporter — back up your Echo360 course recordings' companions for offline use:
 * lesson list, transcripts (VTT + TXT), slide decks (original PDF + slide text),
 * Q&A discussions, your notes, posters, and the recordings themselves.
 *
 * Recordings use Echo360's download when the instructor allows it. Otherwise the
 * exporter downloads the same HLS stream the player plays (video and audio are
 * usually separate renditions), muxes the fragments into one MP4 without
 * re-encoding, and never touches DRM-protected streams.
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
      this.hlsKeys = new Map();
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

    /** An HLS master or media playlist (Echo360 serves both from content.echo360.ca). */
    async hlsPlaylist(url) {
      const r = await this.fetch(url);
      if (!r.ok) {
        r.body?.cancel();
        const err = new Error(`HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      const text = await r.text();
      return /^#EXT-X-STREAM-INF:/m.test(text)
        ? { master: true, ...parseHlsMaster(text, url) }
        : { master: false, ...parseHlsMedia(text, url) };
    }

    /** Resolve a playable media URI to a concrete variant and fetch its init segment. */
    async hlsTrack(url) {
      let pl = await this.hlsPlaylist(url);
      let master = null;
      let variant = null;
      if (pl.master) {
        master = pl;
        variant = pickHlsVariant(pl.variants);
        if (!variant?.url) throw new Error('the HLS master playlist has no playable variant');
        pl = await this.hlsPlaylist(variant.url);
        if (pl.master) throw new Error('nested HLS master playlist');
      }
      if (!pl.segments.length) throw new Error('the HLS playlist has no segments');
      const bad = pl.segments.find((s) => s.key?.unsupported);
      if (bad) throw new Error(`the stream is encrypted with ${bad.key.method}, which this exporter cannot save`);
      let initBytes = null;
      let info = null;
      if (pl.init?.url) {
        initBytes = await this.hlsPart(pl.init);
        info = mp4Info(initBytes);
        if (info && mp4Boxes(initBytes, info.moov.body, info.moov.end).some((b) => b.type === 'pssh')) {
          throw new Error('the stream is DRM-protected, which this exporter cannot save');
        }
      }
      return { url, master, variant, media: pl, initBytes, info };
    }

    /** Fetch one playlist resource, honouring byte ranges and AES-128 keys. */
    async hlsPart(part) {
      const headers = {};
      if (part.range?.length) headers.Range = `bytes=${part.range.offset}-${part.range.offset + part.range.length - 1}`;
      // Keep the limiter while the body is read, like saveFile does.
      const res = await this.cdn(async () => {
        const r = await this.fetch(part.url, Object.keys(headers).length ? { headers } : {});
        if (!r.ok) {
          r.body?.cancel();
          const err = new Error(`HTTP ${r.status}`);
          err.status = r.status;
          throw err;
        }
        return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
      });
      let bytes = res.bytes;
      if (part.range?.length) {
        if (res.status === 200 && bytes.length > part.range.length) bytes = bytes.subarray(part.range.offset, part.range.offset + part.range.length);
        else if (bytes.length < part.range.length) throw new Error(`short read (${bytes.length}/${part.range.length} bytes)`);
      }
      if (part.key) bytes = await this.decryptHls(bytes, part.key, part.seq);
      return bytes;
    }

    async decryptHls(bytes, key, seq) {
      if (key.unsupported) throw new Error(`unsupported encryption ${key.method}`);
      if (!key.url) throw new Error('the stream key has no URL');
      let k = this.hlsKeys.get(key.url);
      if (!k) {
        const r = await this.fetch(key.url);
        if (!r.ok) {
          r.body?.cancel();
          throw new Error(`HTTP ${r.status} for the stream key`);
        }
        k = crypto.subtle.importKey('raw', await r.arrayBuffer(), { name: 'AES-CBC' }, false, ['decrypt']);
        this.hlsKeys.set(key.url, k);
      }
      let iv;
      if (key.iv) iv = hexBytes(key.iv);
      else {
        iv = new Uint8Array(16);
        new DataView(iv.buffer).setBigUint64(8, BigInt(seq || 0));
      }
      try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await k, bytes));
      } catch (e) {
        throw new Error(`could not decrypt the stream (${e.message})`);
      }
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

      // Recording: use Echo360's own download when it is offered. When the
      // instructor turned downloads off, save the HLS stream the player uses
      // instead (video and audio are separate renditions and get muxed).
      const offered = [...(info.primaryFiles?.files || []), ...(info.secondaryFiles?.files || []), ...(info.audioFiles || [])];
      if (!this.opts.videos) {
        l.locked = true;
        this.counts.videosLocked++;
        l.notes.push(offered.length ? `${label}: video download available on Echo360 (videos disabled in options)` : `${label}: recording not saved (videos disabled in options)`);
      } else {
        let saved = false;
        let downloadError = null;
        if (offered.length) {
          const pick = offered.find((f) => /hd|high|1080|720/i.test(`${f.label} ${f.fileName}`)) || offered[0];
          try {
            const file = await this.http.json(`${base}/file/${encodeURIComponent(pick.fileName)}`);
            const uri = file?.downloadUri || file;
            if (typeof uri !== 'string') throw new Error('no download link returned');
            saved = await this.saveFile(l, uri, `${l.dir}/${prefix}${safeName(pick.fileName, LIMITS.file)}`, 'video');
          } catch (e) {
            if (isAbort(e)) throw e;
            downloadError = e.message;
          }
        }
        if (!saved) {
          try {
            saved = await this.captureStream(l, m, player, prefix);
          } catch (e) {
            if (isAbort(e)) throw e;
            l.notes.push(`${label}: could not save the recording (${e.message})`);
          }
        }
        if (saved) this.counts.videos++;
        else {
          l.locked = true;
          this.counts.videosLocked++;
          if (downloadError) l.notes.push(`${label}: video download failed (${downloadError})`);
          l.notes.push(`${label}: recording not saved — watch it online`);
        }
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

    /** Save one media from the HLS stream, muxing separate video/audio renditions. */
    async captureStream(l, m, player, prefix) {
      if (this.opts.skipExisting) {
        for (const ext of ['.mp4', '.m4a', '.ts']) {
          const existing = `${l.dir}/${prefix}recording${ext}`;
          const size = await this.x.sink.exists(existing);
          if (size > 0) {
            this.x.stats.existing++;
            l.files.push({ kind: 'video', path: existing, size });
            return true;
          }
        }
      }
      const streams = player?.video?.mediaId === m.id
        ? (player.video.playableMedias || [])
        : (m.uri ? [m] : []);
      const source = streams.find((p) => p.trackType?.includes('Audio') && p.trackType?.includes('Video'))
        || streams.find((p) => p.trackType?.includes('Video'))
        || streams.find((p) => p.trackType?.includes('Audio'));
      if (!source?.uri) throw new Error('the player data has no streaming URL for this media');
      const main = await this.http.hlsTrack(source.uri);
      const has = (track, type) => !!track.info?.traks.some((t) => t.handler === type);

      // Echo360 often serves video and audio as separate renditions; the
      // master playlist groups them. Load the matching audio when needed.
      let audio = null;
      if (main.info && has(main, 'vide') && !has(main, 'soun')) {
        const group = main.variant?.audioGroup;
        let url = group ? pickHlsRendition(main.master?.renditions || [], group)?.url : null;
        if (!url) {
          const alt = streams.find((x) => x.trackType?.includes('Audio') && !x.trackType?.includes('Video') && x.uri);
          if (alt) url = alt.uri;
        }
        if (url) {
          try {
            const a = await this.http.hlsTrack(url);
            if (has(a, 'soun')) audio = a;
            else l.notes.push('audio track: no audio stream found');
          } catch (e) {
            if (isAbort(e)) throw e;
            l.notes.push(`audio track: ${e.message}`);
          }
        }
      }

      const mux = !!(audio && has(main, 'vide'));
      const ext = main.info && !has(main, 'vide') ? '.m4a' : main.info ? '.mp4' : '.ts';
      const path = `${l.dir}/${prefix}recording${ext}`;

      const max = this.opts.maxMB > 0 ? this.opts.maxMB * 1024 * 1024 : 0;
      const sizeOf = (t) => (t.initBytes?.length || 0) + (t.media.segments.every((s) => s.range?.length)
        ? t.media.segments.reduce((n, s) => n + s.range.length, 0) : 0);
      const estimate = sizeOf(main) + (mux ? sizeOf(audio) : 0);
      if (max && estimate && estimate > max) {
        l.notes.push(`${path.split('/').pop()}: skipped, the stream is about ${fmtBytes(estimate)}, over the size limit`);
        return false;
      }

      let init = main.initBytes;
      let audioId = null;
      if (mux) {
        const merged = mp4MergeInit(main, audio);
        init = merged.init;
        audioId = merged.audioId;
      }

      let written = 0;
      let lastUpdate = 0;
      const x = this.x;
      const counted = this.hlsStream(main, mux ? audio : null, init, audioId).pipeThrough(new TransformStream({
        transform(chunk, ctl) {
          written += chunk.byteLength;
          x.stats.bytes += chunk.byteLength;
          if (max && written > max) { ctl.error(new Error('over the size limit')); return; }
          ctl.enqueue(chunk);
          if (Date.now() - lastUpdate > 500) { lastUpdate = Date.now(); x.ui.update(); }
        },
      }));
      try {
        await this.x.sink.write(path, counted);
      } catch (e) {
        if (isAbort(e)) throw e;
        if (/over the size limit/.test(e.message)) {
          l.notes.push(`${path.split('/').pop()}: skipped, over the size limit`);
          return false;
        }
        throw e;
      }
      this.x.stats.files++;
      this.counts.files++;
      l.files.push({ kind: 'video', path, size: written });
      this.x.ui.update();
      return true;
    }

    /** Read the player's HLS stream as one continuous file, in decode order. */
    hlsStream(main, audio, init, audioId) {
      const job = this;
      async function* chunks() {
        if (init) yield init;
        const vIt = job.hlsFragments(main);
        if (!audio) {
          for await (const f of vIt) yield f.bytes;
          return;
        }
        const aIt = job.hlsFragments(audio, audioId);
        let v = await vIt.next();
        let a = await aIt.next();
        while (!v.done || !a.done) {
          if (a.done || (!v.done && v.value.time <= a.value.time)) {
            yield v.value.bytes;
            v = await vIt.next();
          } else {
            yield a.value.bytes;
            a = await aIt.next();
          }
        }
      }
      const it = chunks();
      return new ReadableStream({
        async pull(ctl) {
          try {
            const { done, value } = await it.next();
            if (done) ctl.close();
            else ctl.enqueue(value);
          } catch (e) { ctl.error(e); }
        },
        async cancel() { await it.return?.(); },
      });
    }

    async *hlsFragments(track, newId) {
      const timescale = track.info?.traks[0]?.timescale || 1;
      const oldId = newId != null ? track.info?.traks.find((t) => t.handler === 'soun')?.id : null;
      let n = 0;
      for (const seg of track.media.segments) {
        n++;
        let bytes;
        try {
          bytes = await this.http.hlsPart(seg);
        } catch (e) {
          if (isAbort(e)) throw e;
          throw new Error(`segment ${Math.round(seg.start)}s (${n}/${track.media.segments.length}): ${e.message}`);
        }
        for (const frag of mp4Fragments(bytes, timescale, seg.start)) {
          yield { time: frag.time, bytes: oldId != null ? mp4PatchTrackId(frag.bytes, oldId, newId) : frag.bytes };
        }
      }
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
<dt>Saved</dt><dd>${c.ok}/${c.lessons} lessons · ${c.transcripts} transcripts · ${c.slides} slide decks · ${c.questions} questions · ${c.videos} recordings${c.videosLocked ? ` (${c.videosLocked} not saved)` : ''}</dd></dl>
<div class="xp-links"><a href="${esc(`${EORIGIN}/section/${s.sectionId}/home`)}" target="_blank" rel="noopener">Open on Echo360 ↗</a>${this.hasNotes ? '<a href="my-notes.txt">My notes</a>' : ''}<a href="section.json">section.json</a></div>
${c.videosLocked ? '<p class="xp-note">🔒 Some recordings could not be saved — their lessons list the reason and link to the online player.</p>' : ''}
<table class="xp-courses"><thead><tr><th>Lesson</th><th>Date</th><th>Length</th><th>Saved</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>`;
      await this.x.sink.write(this.indexPath, page({ title: s.label, body, pagePath: this.indexPath, crumbs: [{ title: 'Echo360', path: `${ROOT}/index.html` }] }));
    }
  }

  const playableMedias = (l) => l.medias.filter((m) => m.mediaType === 'Video' || m.mediaType === 'Audio');

  // ------------------------------------------------------------ HLS capture

  // Echo360 serves recordings as HLS with fragmented MP4 segments (and often
  // separate video and audio renditions, because the player muxes them itself).
  // The exporter downloads the same playlist the player uses and joins the
  // fragments: video-only and audio-only renditions are combined by merging
  // their moov headers and interleaving the fragments by decode time. Nothing
  // is re-encoded, so the saved file has the original quality.
  //
  // Only unencrypted or AES-128 HLS is supported. DRM (SAMPLE-AES / FairPlay)
  // is detected and reported instead of being bypassed.

  function mp4Boxes(buf, start = 0, end = buf.length) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = [];
    for (let o = start; o + 8 <= end;) {
      let size = dv.getUint32(o);
      const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
      let header = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); header = 16; }
      else if (size === 0) size = end - o;
      if (size < header || o + size > end) break;
      out.push({ type, start: o, size, header, body: o + header, end: o + size });
      o += size;
    }
    return out;
  }

  const mp4Slice = (buf, box) => buf.slice(box.start, box.end);
  const mp4Set = (buf, off, value) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(off, value);
  const mp4Get = (buf, off) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(off);

  function concatBytes(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function mp4Box(type, ...parts) {
    const body = concatBytes(parts);
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
  }

  /** Tracks and headers of an fMP4 init segment (ftyp + moov). */
  function mp4Info(buf) {
    const top = mp4Boxes(buf);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) return null;
    const kids = mp4Boxes(buf, moov.body, moov.end);
    const mvhd = kids.find((b) => b.type === 'mvhd');
    if (!mvhd) return null;
    const traks = [];
    for (const trak of kids.filter((b) => b.type === 'trak')) {
      const tk = mp4Boxes(buf, trak.body, trak.end);
      const mdia = tk.find((b) => b.type === 'mdia');
      const tkhd = tk.find((b) => b.type === 'tkhd');
      if (!mdia || !tkhd) continue;
      const mdiaKids = mp4Boxes(buf, mdia.body, mdia.end);
      const hdlr = mdiaKids.find((b) => b.type === 'hdlr');
      const mdhd = mdiaKids.find((b) => b.type === 'mdhd');
      if (!hdlr || !mdhd) continue;
      traks.push({
        trak, tkhd, mdia,
        handler: String.fromCharCode(buf[hdlr.body + 8], buf[hdlr.body + 9], buf[hdlr.body + 10], buf[hdlr.body + 11]),
        id: mp4Get(buf, tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12)),
        timescale: mp4Get(buf, mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12)) || 1,
      });
    }
    const mvex = kids.find((b) => b.type === 'mvex');
    const trexs = mvex ? mp4Boxes(buf, mvex.body, mvex.end).filter((b) => b.type === 'trex') : [];
    return { top, moov, kids, traks, trexs, mvhd, nextOff: 8 + (buf[mvhd.body] === 1 ? 108 : 96) };
  }

  /** Merge a video init segment and an audio init segment into one movie. */
  function mp4MergeInit(video, audio) {
    const v = video.info;
    const a = audio.info;
    const vTrak = v?.traks.find((t) => t.handler === 'vide') || v?.traks[0];
    const aTrak = a?.traks.find((t) => t.handler === 'soun') || a?.traks[0];
    if (!vTrak || !aTrak) throw new Error('could not read the MP4 track headers');
    if (!v.trexs[0] || !a.trexs[0]) throw new Error('fragmented MP4 headers have no track defaults');

    const used = new Set(v.traks.map((t) => t.id));
    let audioId = 1;
    while (used.has(audioId)) audioId++;

    const aTrakBox = mp4Slice(audio.initBytes, aTrak.trak);
    const tkhdRel = aTrak.tkhd.body - aTrak.trak.start;
    mp4Set(aTrakBox, tkhdRel + (aTrakBox[tkhdRel] === 1 ? 20 : 12), audioId);

    const vTrex = mp4Slice(video.initBytes, v.trexs[0]);
    mp4Set(vTrex, 12, vTrak.id);
    const aTrex = mp4Slice(audio.initBytes, a.trexs[0]);
    mp4Set(aTrex, 12, audioId);

    const mvhd = mp4Slice(video.initBytes, v.mvhd);
    mp4Set(mvhd, v.nextOff, Math.max(audioId, ...used) + 1);

    const ftypBox = v.top.find((b) => b.type === 'ftyp');
    const ftyp = ftypBox ? mp4Slice(video.initBytes, ftypBox) : new Uint8Array(0);
    const others = v.kids
      .filter((b) => !['mvhd', 'trak', 'mvex'].includes(b.type))
      .map((b) => mp4Slice(video.initBytes, b));
    const moov = mp4Box('moov', mvhd, ...v.traks.map((t) => mp4Slice(video.initBytes, t.trak)), aTrakBox, mp4Box('mvex', vTrex, aTrex), ...others);
    return { init: concatBytes([ftyp, moov]), audioId };
  }

  /** Renumber the track in a fragment so it matches the merged movie. */
  function mp4PatchTrackId(bytes, oldId, newId) {
    const copy = bytes.slice();
    for (const moof of mp4Boxes(copy)) {
      if (moof.type !== 'moof') continue;
      for (const traf of mp4Boxes(copy, moof.body, moof.end)) {
        if (traf.type !== 'traf') continue;
        for (const tfhd of mp4Boxes(copy, traf.body, traf.end)) {
          if (tfhd.type === 'tfhd' && mp4Get(copy, tfhd.body + 4) === oldId) mp4Set(copy, tfhd.body + 4, newId);
        }
      }
    }
    return copy;
  }

  /** A media segment as one or more moof+mdat fragments, with decode times. */
  function mp4Fragments(bytes, timescale, startTime) {
    const top = mp4Boxes(bytes);
    if (!top.some((b) => b.type === 'moof')) return [{ time: startTime, bytes }]; // MPEG-TS
    const out = [];
    for (let i = 0; i < top.length; i++) {
      const moof = top[i];
      if (moof.type !== 'moof') continue;
      let end = moof.end;
      for (let j = i + 1; j < top.length; j++) {
        if (top[j].type === 'mdat') { end = top[j].end; break; }
        if (top[j].type === 'moof') break;
      }
      let time = startTime;
      const traf = mp4Boxes(bytes, moof.body, moof.end).find((b) => b.type === 'traf');
      const tfdt = traf && mp4Boxes(bytes, traf.body, traf.end).find((b) => b.type === 'tfdt');
      if (tfdt) {
        const t = bytes[tfdt.body] === 1 ? Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(tfdt.body + 4)) : mp4Get(bytes, tfdt.body + 4);
        time = t / (timescale || 1);
      }
      out.push({ time, bytes: bytes.subarray(moof.start, end) });
    }
    return out;
  }

  // HLS playlists are line-oriented; attributes look like KEY="value",KEY=value.
  function hlsAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  function hlsRange(s) {
    const m = /^(\d+)(?:@(\d+))?$/.exec(String(s || '').trim());
    return m ? { length: +m[1], offset: m[2] == null ? null : +m[2] } : null;
  }

  function parseHlsMaster(text, base) {
    const variants = [];
    const renditions = [];
    let pending = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-STREAM-INF:')) { pending = hlsAttrs(line.slice(18)); continue; }
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = hlsAttrs(line.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) renditions.push({ ...a, url: abs(a.URI, base), bandwidth: +a.BANDWIDTH || 0 });
        continue;
      }
      if (!line.startsWith('#') && pending) {
        variants.push({ ...pending, url: abs(line, base), bandwidth: +pending.BANDWIDTH || 0, resolution: pending.RESOLUTION || '', audioGroup: pending.AUDIO || null });
        pending = null;
      }
    }
    return { variants, renditions };
  }

  function parseHlsMedia(text, base) {
    const segments = [];
    let init = null;
    let key = null;
    let range = null;
    let lastEnd = 0;
    let lastUrl = null;
    let seq = 0;
    let dur = 0;
    let start = 0;
    let expect = false;
    let disc = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { seq = +line.slice(22) || 0; continue; }
      if (line.startsWith('#EXT-X-MAP:')) {
        const a = hlsAttrs(line.slice(11));
        init = { url: abs(a.URI, base), range: hlsRange(a.BYTERANGE) };
        continue;
      }
      if (line.startsWith('#EXT-X-KEY:')) {
        const a = hlsAttrs(line.slice(11));
        if (a.METHOD === 'NONE') key = null;
        else if (a.METHOD === 'AES-128' && (!a.KEYFORMAT || a.KEYFORMAT === 'identity')) key = { method: a.METHOD, url: abs(a.URI, base), iv: a.IV || null };
        else key = { method: a.METHOD || 'unknown', unsupported: true };
        continue;
      }
      if (line.startsWith('#EXT-X-BYTERANGE:')) { range = hlsRange(line.slice(17)); continue; }
      if (line.startsWith('#EXTINF:')) { dur = parseFloat(line.slice(8)) || 0; expect = true; continue; }
      if (line === '#EXT-X-DISCONTINUITY') { disc = true; continue; }
      if (line.startsWith('#')) continue;
      if (!expect) continue;
      const url = abs(line, base);
      const off = range ? (range.offset == null ? (lastUrl === url ? lastEnd : 0) : range.offset) : null;
      const seg = { url, start, duration: dur, seq: seq + segments.length, key };
      if (disc) seg.discontinuity = true;
      if (range) seg.range = { offset: off, length: range.length };
      segments.push(seg);
      if (range) { lastEnd = off + range.length; lastUrl = url; } else { lastEnd = 0; lastUrl = null; }
      start += dur;
      dur = 0;
      range = null;
      expect = false;
      disc = false;
    }
    return { segments, init, duration: start };
  }

  function pickHlsVariant(variants) {
    const area = (v) => {
      const m = /^(\d+)x(\d+)$/.exec(v.resolution || '');
      return m ? +m[1] * +m[2] : 0;
    };
    return [...variants].sort((a, b) => area(b) - area(a) || b.bandwidth - a.bandwidth)[0] || null;
  }

  function pickHlsRendition(renditions, group) {
    const matches = renditions.filter((r) => r['GROUP-ID'] === group);
    return matches.find((r) => /^yes$/i.test(r.DEFAULT || '')) || matches.sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
  }

  function hexBytes(s) {
    const h = String(s || '').replace(/^0x/i, '');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

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
      <label><input type="checkbox" name="videos" checked> Recordings <span class="muted">(download when offered, otherwise save the stream)</span></label>
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

  if (host === 'eclass.yorku.ca') site_eclass();
  if (host === 'echo360.ca') site_echo360();
})();
