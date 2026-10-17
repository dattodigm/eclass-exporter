// Builds the two distributable forms of src/exporter.js:
//   extension/            unpacked Chrome/Edge extension (load via chrome://extensions)
//   dist/*.user.js        Tampermonkey / Violentmonkey userscript (also pasteable into DevTools)
// Usage: node build.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const src = await readFile(new URL('src/exporter.js', root), 'utf8');
const version = /const VERSION = '([^']+)'/.exec(src)[1];

const header = `// ==UserScript==
// @name         eClass Exporter (YorkU)
// @namespace    https://eclass.yorku.ca/
// @version      ${version}
// @description  Back up eClass courses (content, files, assignments, forums, wikis, quizzes, grades) for offline use.
// @match        https://eclass.yorku.ca/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

`;

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/eclass-exporter.user.js', root), header + src);

const manifest = {
  manifest_version: 3,
  name: 'eClass Exporter (YorkU)',
  version,
  description: 'Back up eClass courses (content, files, assignments, forums, wikis, quizzes, grades) for offline use.',
  content_scripts: [{ matches: ['https://eclass.yorku.ca/*'], js: ['exporter.js'], run_at: 'document_idle', all_frames: false }],
};
await mkdir(new URL('extension/', root), { recursive: true });
await writeFile(new URL('extension/exporter.js', root), src);
await writeFile(new URL('extension/manifest.json', root), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built eClass Exporter ${version}: extension/ and dist/eclass-exporter.user.js`);
