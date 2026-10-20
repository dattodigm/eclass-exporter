**English** | [简体中文](README.zh-CN.md)

# eClass Exporter (YorkU)

Back up your courses from [eclass.yorku.ca](https://eclass.yorku.ca) to your own computer and browse them offline:
course info, section content and labels, files, assignments (including your own submissions and annotated
feedback), forums, wikis, quiz reviews, lessons, books, glossaries, databases, H5P, links, and your grades.

It also backs up your [Echo360](https://echo360.ca) lecture recordings' material: transcripts, slide decks,
Q&A discussions and your notes, plus the recordings themselves(see [Echo360](#echo360)).

- **Back up every course:** on any eClass page click **⬇ Export eClass** (bottom right) → *Choose courses…* → *Export selected*
- **Back up one course:** open the course (or any activity in it) → **⬇ Export eClass** → *Export this course*
- **Echo360:** open Echo360 (usually from the Echo360 link in an eClass course) and use the **⬇ Export Echo360** button the same way

It runs inside the browser tab where you are already signed in, so it saves exactly what you can see on eClass.
No password or token is needed, and nothing is sent anywhere except to eClass itself.

## Install

Download from the [latest release](https://github.com/dattodigm/eclass-exporter/releases/latest).

### Chrome / Edge (recommended)

1. Download `eclass-exporter-chrome-<version>.zip` and unzip it.
2. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.
4. Reload any eClass page; a red **⬇ Export eClass** button appears in the bottom-right corner.

### Firefox

- **Userscript (recommended on Firefox):** install [Tampermonkey](https://www.tampermonkey.net/) or
  [Violentmonkey](https://violentmonkey.github.io/), then open
  [`eclass-exporter.user.js`](https://github.com/dattodigm/eclass-exporter/releases/latest/download/eclass-exporter.user.js)
  and confirm the install. It updates itself from new releases.
- **Extension (experimental):** download `eclass-exporter-firefox-<version>.zip`, open `about:debugging#/runtime/this-firefox`,
  click **Load Temporary Add-on…** and pick the zip. Temporary add-ons are removed when Firefox restarts,
  because the extension is not signed by Mozilla.

Firefox cannot write into a folder directly, so it always uses **ZIP** mode.

### Any browser, one-off

Press `F12` on an eClass page, open **Console**, paste the whole content of `eclass-exporter.user.js` and press Enter.
The button appears until you reload the page.

## Use

| Option | What it does |
| --- | --- |
| Save to a folder | **Recommended** (Chrome/Edge). Pick an empty folder such as `Documents\eClass-Backup`; files are written straight into it. Exporting into the same folder again resumes and skips files that are already there. Browsers refuse system folders like *Documents* or *Desktop* themselves; create a subfolder and pick that. |
| Download a ZIP per course | One ZIP per course plus `eClass-index.zip` for the overview page. Unzip them all into one folder and the links work across courses. Courses over 3.5 GB are split into parts. |
| Download files and attachments | Turn off to save pages only; file links then point to eClass. |
| Forums and discussions | Include forums. |
| My grades | Save your grade report. |
| Skip files larger than N MB | Skip big files such as lecture recordings. Skipped files are outlined in yellow on the saved page and link back to eClass. |

You can switch to other tabs while it runs, but **do not close or reload the eClass tab**.
If your eClass session expires (after 8 hours), the export stops with a message; sign in again and export into the same folder to continue.

**Speed and rate limits.** eClass sits behind a load balancer that blocks clients sending requests too quickly:
at roughly 9 requests per second for a few minutes, every eClass page returned `403 Forbidden` for about 2 minutes.
The exporter therefore keeps eClass requests to about 3 per second. File downloads come from a CDN and are not limited.
If eClass still pushes back, the exporter pauses (1, 2, 4… minutes), slows down and carries on.
For reference: a typical course takes 1–3 minutes, a large one (200 activities, 1000+ files) about 10 minutes,
and all courses together roughly 30–60 minutes.

**Resuming and updating.** Exporting into the same folder again re-saves the pages but does not re-download files that already exist.
If an instructor replaced a file and you want the new version, untick *Skip files already in the folder* and export again.

## What you get

```
eClass-Backup/
├─ index.html                     ← overview of all courses, newest term first
├─ courses.json
└─ AP-CMDS 4275 M - Power, Resistance and New Me (Winter 2025-2026)/
   ├─ index.html                  ← course home: info, instructors, sections, labels, links to every activity
   ├─ course-info.html            ← course information (instructors)
   ├─ grades.html                 ← your grade report
   ├─ course.json                 ← full structure, including eClass's raw course state
   ├─ _files/                     ← images and attachments used in summaries and labels
   ├─ 00 - General/
   │  ├─ 01 - Announcements/      ← forum: index.html + discussions/*.html + files/
   │  ├─ 02 - Social Justice Tech Audit/   ← assignment: instructions, due dates, your submission, grade, annotated PDF
   │  ├─ 06 - Syllabus.pdf        ← files are saved as-is
   │  └─ 07 - News Finder Sign Ups (link).html
   ├─ 01 - Week 1- Introduction- Why Resist/
   │  └─ ...
   └─ _Unlisted activities/       ← activities you can open that no visible section lists
```

Open `index.html` in a browser to browse offline. Every page has breadcrumbs and an "Open on eClass ↗" link to the original.

## Echo360

The same extension/userscript adds an **⬇ Export Echo360** button on [echo360.ca](https://echo360.ca).
*Choose courses…* lists your Echo360 courses (the ones with recordings are pre-selected); on a course page,
*Export this course* saves just that one. Pick the same folder as your eClass backup if you like: Echo360 goes into an
`Echo360/` subfolder, and the two overview pages link to each other.

For every lesson it saves:

| | |
| --- | --- |
| Transcript | `transcript.vtt` (timed captions, plays alongside a video) and `transcript.txt`; the text is also shown on the lesson page so it can be searched |
| Slides | the instructor's original file (usually a PDF) and `slides.html` with the text of every slide |
| Q&A | `discussions.html`: questions with their position in the recording, and all replies |
| Details | date, length, group/week, poster image, `lesson.json` |
| Recording | `recording.mp4`: Echo360's own download when the instructor allows it; otherwise the same HLS stream the player uses, with its separate video and audio renditions joined into one MP4 (no re-encoding). DRM-protected streams are skipped. |

Plus `my-notes.txt` (your Echo360 notes, when you have any) and an `index.html` per course listing every lesson.

```
eClass-Backup/
└─ Echo360/
   ├─ index.html
   └─ LE-EECS 2101 A - Fundamentals of Data Structure (Fall 2023-2024)/
      ├─ index.html
      └─ 02 - LIVE LECTURE SESSION RECORDINGS/
         └─ 22 - Week 1 - Session 1/
            ├─ index.html
            ├─ recording.mp4
            ├─ transcript.vtt
            ├─ transcript.txt
            ├─ Week 1.pdf
            └─ slides.html
```

**About recordings.** When the instructor has turned downloads off, the exporter saves the recording straight from
the same HLS playlist the Echo360 player plays. Echo360 usually stores video and audio as two separate streams, so
the exporter downloads both and muxes their fragments into a single `recording.mp4` without re-encoding; the result
keeps the original resolution and audio. A two-hour lecture is roughly 250–500 MB, so use *Save to a folder* for
full courses. Streams protected by DRM are detected and skipped (the lesson then links to Echo360).

## What is and isn't saved

**Saved:** every activity you can open. Restricted or hidden activities are listed on the course page as *restricted*,
together with the restriction. Courses that are closed to students (often lab or tutorial sections) are listed in the overview with the reason.

**Not saved, or only partly:**

- LTI tools, Turnitin and embedded YuJa/YouTube videos: the page and the link are saved, not the content on the external platform.
- Lessons: pages are followed through the lesson's own menu; the exporter never answers questions for you, so pages the menu doesn't list are missing.
- Quizzes: only finished attempts whose review is allowed; it never starts a new attempt.
- Group wikis: your own group's version.
- Other students' details: only what appears in forum posts you can read.

**Read-only.** The exporter only sends GET requests plus three read-only AJAX calls. It never submits assignments, answers questions or changes settings.
Opening an activity is recorded as a view, the same as clicking on it yourself.

## Development

```
src/core.js                shared helpers: file naming, folder/ZIP writers, HTML template, panel CSS
src/eclass.js              eClass exporter (runs on eclass.yorku.ca)
src/echo360.js             Echo360 exporter (runs on echo360.ca)
build.mjs                  bundles core + site into extension/ (Chrome), dist/firefox/ and dist/eclass-exporter.user.js
docs/eclass-structure.md   notes on how eClass is built (APIs, selectors, rate limits, how each activity is saved) — in Chinese
docs/echo360-structure.md  the same for Echo360 — in Chinese
.github/workflows/         CI build check and automatic releases
```

The files in `src/` are not standalone scripts: `build.mjs` puts `core.js` and each site file into one function scope.
After editing anything in `src/`:

```bash
node build.mjs
```

Scripted use from the console:

```js
// Export specific course ids as ZIP files
await eclassExporter.run([138507], { mode: 'zip', maxMB: 200 });
// On echo360.ca: export Echo360 sections by id
await echo360Exporter.run(['<sectionId>'], { mode: 'zip' });
// Progress / cancel the running export
eclassExporter.current?.stats;
eclassExporter.current?.cancel();
```

Firefox's linter (`web-ext lint`) reports warnings about `innerHTML`. Those writes only go into documents created with
`DOMParser`, which never run scripts or load resources, before being saved to disk.

### Releasing

Bump `VERSION` in `src/core.js`, run `node build.mjs`, commit, then tag and push:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

The *Release* workflow checks that the tag matches `VERSION`, builds the Chrome and Firefox zips and the userscript,
and publishes them as a GitHub release.

## License

[MIT](LICENSE)
