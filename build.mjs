// Builds the distributable forms of src/exporter.js:
//   extension/                    unpacked Chrome/Edge extension (committed; load via chrome://extensions)
//   dist/firefox/                 Firefox extension (generated; zipped by the release workflow)
//   dist/eclass-exporter.user.js  Tampermonkey / Violentmonkey userscript (also pasteable into DevTools)
// Usage: node build.mjs
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const src = await readFile(new URL('src/exporter.js', root), 'utf8');
const version = /const VERSION = '([^']+)'/.exec(src)[1];
const repo = 'https://github.com/dattodigm/eclass-exporter';
const description = 'Back up eClass courses (content, files, assignments, forums, wikis, quizzes, grades) for offline use.';

const header = `// ==UserScript==
// @name         eClass Exporter (YorkU)
// @namespace    https://eclass.yorku.ca/
// @version      ${version}
// @description  ${description}
// @homepageURL  ${repo}
// @supportURL   ${repo}/issues
// @downloadURL  ${repo}/releases/latest/download/eclass-exporter.user.js
// @updateURL    ${repo}/releases/latest/download/eclass-exporter.user.js
// @match        https://eclass.yorku.ca/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

`;

const contentScripts = [{ matches: ['https://eclass.yorku.ca/*'], js: ['exporter.js'], run_at: 'document_idle', all_frames: false }];
const chrome = {
  manifest_version: 3,
  name: 'eClass Exporter (YorkU)',
  version,
  description,
  homepage_url: repo,
  content_scripts: contentScripts,
};
const firefox = {
  ...chrome,
  // Files redirect from eClass to a CloudFront CDN; Firefox content scripts need host access for both.
  host_permissions: ['https://eclass.yorku.ca/*', 'https://*.cloudfront.net/*'],
  browser_specific_settings: {
    gecko: {
      id: 'eclass-exporter@dattodigm',
      strict_min_version: '115.0',
      data_collection_permissions: { required: ['none'] },
    },
  },
};

const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/eclass-exporter.user.js', root), header + src);

await mkdir(new URL('extension/', root), { recursive: true });
await writeFile(new URL('extension/exporter.js', root), src);
await writeFile(new URL('extension/manifest.json', root), json(chrome));

await rm(new URL('dist/firefox/', root), { recursive: true, force: true });
await mkdir(new URL('dist/firefox/', root), { recursive: true });
await writeFile(new URL('dist/firefox/exporter.js', root), src);
await writeFile(new URL('dist/firefox/manifest.json', root), json(firefox));

console.log(`Built eClass Exporter ${version}: extension/, dist/firefox/, dist/eclass-exporter.user.js`);
