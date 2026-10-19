// Builds the distributable forms from src/:
//   src/core.js     shared helpers (naming, folder/ZIP writers, HTML template, panel CSS)
//   src/eclass.js   eClass exporter (runs on eclass.yorku.ca)
//   src/echo360.js  Echo360 exporter (runs on echo360.ca)
// Each bundle is one function scope: core first, then each site file as the body of
// its own function, called only on that site's pages.
//
// Outputs:
//   extension/                    unpacked Chrome/Edge extension (committed; load via chrome://extensions)
//   dist/firefox/                 Firefox extension (generated; zipped by the release workflow)
//   dist/eclass-exporter.user.js  Tampermonkey / Violentmonkey userscript for both sites
// Usage: node build.mjs
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const core = await read('src/core.js');
const sites = {
  eclass: { src: await read('src/eclass.js'), test: "host === 'eclass.yorku.ca'", matches: ['https://eclass.yorku.ca/*'] },
  echo360: { src: await read('src/echo360.js'), test: "host === 'echo360.ca'", matches: ['https://echo360.ca/*'] },
};
const version = /const VERSION = '([^']+)'/.exec(core)[1];
const repo = 'https://github.com/dattodigm/eclass-exporter';
const description = 'Back up YorkU eClass courses and Echo360 lectures (content, files, assignments, forums, transcripts, slides, Q&A, grades) for offline use.';

const bundle = (names) => `/* eClass Exporter ${version} — ${repo} — built from src/ by build.mjs; do not edit. */
(() => {
  'use strict';
  const host = location.hostname;

${core}
${names.map((n) => `  const site_${n} = () => {\n${sites[n].src}\n  };\n`).join('\n')}
${names.map((n) => `  if (${sites[n].test}) site_${n}();`).join('\n')}
})();
`;

const header = `// ==UserScript==
// @name         eClass & Echo360 Exporter (YorkU)
// @namespace    https://eclass.yorku.ca/
// @version      ${version}
// @description  ${description}
// @homepageURL  ${repo}
// @supportURL   ${repo}/issues
// @downloadURL  ${repo}/releases/latest/download/eclass-exporter.user.js
// @updateURL    ${repo}/releases/latest/download/eclass-exporter.user.js
${Object.values(sites).flatMap((s) => s.matches).map((m) => `// @match        ${m}`).join('\n')}
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

`;

const contentScripts = Object.entries(sites).map(([n, s]) => ({ matches: s.matches, js: [`${n}.js`], run_at: 'document_idle', all_frames: false }));
const chrome = {
  manifest_version: 3,
  name: 'eClass & Echo360 Exporter (YorkU)',
  version,
  description,
  homepage_url: repo,
  content_scripts: contentScripts,
};
const firefox = {
  ...chrome,
  // eClass files redirect to a CloudFront CDN and Echo360 files live on *.echo360.ca;
  // Firefox content scripts need host access for those origins.
  host_permissions: ['https://eclass.yorku.ca/*', 'https://*.cloudfront.net/*', 'https://echo360.ca/*', 'https://*.echo360.ca/*'],
  browser_specific_settings: {
    gecko: {
      id: 'eclass-exporter@dattodigm',
      strict_min_version: '115.0',
      data_collection_permissions: { required: ['none'] },
    },
  },
};

const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
const write = async (dir, files) => {
  await rm(new URL(dir, root), { recursive: true, force: true });
  await mkdir(new URL(dir, root), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(new URL(`${dir}${name}`, root), text);
};
const extensionFiles = (manifest) => ({
  'manifest.json': json(manifest),
  ...Object.fromEntries(Object.keys(sites).map((n) => [`${n}.js`, bundle([n])])),
});

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/eclass-exporter.user.js', root), header + bundle(Object.keys(sites)));
await write('extension/', extensionFiles(chrome));
await write('dist/firefox/', extensionFiles(firefox));

console.log(`Built eClass Exporter ${version}: extension/, dist/firefox/, dist/eclass-exporter.user.js`);
