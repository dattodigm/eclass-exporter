// ==UserScript==
// @name         eClass Exporter (YorkU)
// @namespace    https://eclass.yorku.ca/
// @version      1.0.0
// @description  Back up eClass courses (content, files, assignments, forums, wikis, quizzes, grades) for offline use.
// @homepageURL  https://github.com/dattodigm/eclass-exporter
// @supportURL   https://github.com/dattodigm/eclass-exporter/issues
// @downloadURL  https://github.com/dattodigm/eclass-exporter/releases/latest/download/eclass-exporter.user.js
// @updateURL    https://github.com/dattodigm/eclass-exporter/releases/latest/download/eclass-exporter.user.js
// @match        https://eclass.yorku.ca/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * eClass Exporter — back up YorkU eClass (Moodle 5.x) courses for offline use.
 *
 * Runs in the logged-in browser tab, so it sees exactly what you see on eClass:
 *   - as a Chrome/Edge extension content script (extension/),
 *   - as a Tampermonkey/Violentmonkey userscript (dist/eclass-exporter.user.js),
 *   - or pasted into the DevTools console on any eclass.yorku.ca page.
 *
 * Read-only by design: it only issues GET requests plus three read-only AJAX
 * calls (course state, course list, forum posts). It never submits forms,
 * starts quiz attempts or changes preferences. Opening activity pages is
 * logged by eClass as a "view", the same as clicking through them yourself.
 */
(() => {
  'use strict';

  const NS = '__eclassExporter';
  if (window[NS]) return;

  const VERSION = '1.0.0';
  const ORIGIN = location.origin;
  // Path segment limits keep full paths under Windows' 260-char MAX_PATH.
  const LIMITS = { course: 64, section: 36, item: 40, file: 60, child: 48, folderSeg: 36 };
  const ZIP_PART_LIMIT = 3.5 * 1024 ** 3; // split ZIPs before the 4 GB ZIP32 limit
  const MIN_INTERVAL_MS = 350; // ≈3 eClass requests per second
  const MAX_INTERVAL_MS = 3000;
  const MAX_PAUSES = 6; // 1+2+4+8+10+10 minutes of waiting before giving up

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

  function pageHtml({ title, body, crumbs = [], pagePath, source, heading = true }) {
    const nav = crumbs
      .map((c) => (c.path ? `<a href="${esc(relHref(pagePath, c.path, c.hash))}">${esc(c.title)}</a>` : `<span>${esc(c.title)}</span>`))
      .join(' › ');
    const src = source ? `<a href="${esc(source)}" target="_blank" rel="noopener">Open on eClass ↗</a> · ` : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="eClass Exporter ${VERSION}"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head>
<body><header class="xp-top"><nav>${nav}</nav><div class="xp-src">${src}Saved ${esc(new Date().toLocaleString())}</div></header>
<main class="xp-main">${heading ? `<h1 class="xp-title">${esc(title)}</h1>` : ''}
${body}
</main></body></html>`;
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
      const body = `<p class="xp-note">${courses.filter((c) => c.status === 'ok').length} of ${courses.length} courses saved from <a href="${ORIGIN}">${ORIGIN}</a>.</p>
<table class="xp-courses"><thead><tr><th>Course</th><th>Term</th><th>Dates</th><th>Contents</th><th>Saved</th></tr></thead><tbody>${rows}</tbody></table>`;
      if (this.sink.kind === 'zip') await this.sink.open('eClass-index');
      await this.sink.write('index.html', pageHtml({ title: 'eClass backup', body, pagePath: 'index.html' }));
      await this.sink.write('courses.json', JSON.stringify({ exporter: `eClass Exporter ${VERSION}`, updatedAt: new Date().toISOString(), courses }, null, 2));
      if (this.sink.kind === 'zip') await this.sink.close();
    }
  }

  // --------------------------------------------------------------------- UI

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
})();
