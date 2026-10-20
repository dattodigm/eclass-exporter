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
