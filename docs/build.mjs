import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Builds the technical documentation.
 *
 *   docs/src/*.html  ->  docs/technical-documentation.html  ->  docs/*.pdf
 *
 * The HTML is assembled from numbered fragments so no single file has to be
 * edited as one 3,000-line block, then rendered to PDF by headless Chromium —
 * which is the only renderer that agrees with what the browser shows.
 *
 * Playwright is not a project dependency, because the app does not need it and
 * this runs perhaps twice a year. Install it when you want to regenerate:
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node docs/build.mjs
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = process.argv[2] ? path.resolve(process.argv[2]) : here;

const ORDER = [
  '_head.html',
  '01-front.html',
  '02-files.html',
  '03-concepts.html',
  '04-ship.html',
  '05-learn.html',
  '_tail.html',
];

/* --- assemble ------------------------------------------------------------- */

const html = ORDER.map((name) => {
  const file = path.join(docs, 'src', name);
  if (!fs.existsSync(file)) throw new Error(`Missing fragment: ${file}`);
  return fs.readFileSync(file, 'utf8');
}).join('\n');

const htmlPath = path.join(docs, 'technical-documentation.html');
fs.writeFileSync(htmlPath, html, 'utf8');
console.log(`html  ${(html.length / 1024).toFixed(0)} kB  ->  ${htmlPath}`);

/* --- render --------------------------------------------------------------- */

const chrome = (text) =>
  `<div style="font-family:'Segoe UI',system-ui,sans-serif;font-size:7.5pt;color:#8a9099;
     width:100%;padding:0 16mm;display:flex;justify-content:space-between;">${text}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage();

// waitUntil 'load' rather than 'networkidle': the document deliberately uses no
// remote fonts or images, so there is no network to wait for.
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
await page.emulateMedia({ media: 'print' });

const pdfPath = path.join(docs, 'Caliper-Technical-Documentation.pdf');
await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: chrome('<span></span>'),
  footerTemplate: chrome(
    '<span>Caliper — Technical Documentation</span>' +
      '<span class="pageNumber"></span> / <span class="totalPages"></span>',
  ),
  margin: { top: '14mm', bottom: '16mm', left: '16mm', right: '16mm' },
});

await browser.close();

const kb = fs.statSync(pdfPath).size / 1024;
console.log(`pdf   ${kb.toFixed(0)} kB  ->  ${pdfPath}`);
