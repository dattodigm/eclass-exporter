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
