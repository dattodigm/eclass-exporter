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
