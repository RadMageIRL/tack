// Builds dist/, the only folder the website serves: tack.html, the picture-text reader's runtime files from vendor/,
// and the license texts that have to travel with them. Files are copied from the explicit list below, so nothing else
// (docs, tests, notes, anything dropped in the folder later) can end up on the site. Before copying, every vendored
// file is checked against the SHA-256 in vendor/README.md and the page's SRI hash against the vendored script; a
// mismatch stops the build, so a changed file is never deployed.
//
//   node tools/package.mjs     (Vercel runs this as the build command; see vercel.json)
//
// Node 22+, no dependencies.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const OUT = join(ROOT, 'dist');

// [source in this folder, published path on the site]
export const PUBLIC_FILES = [
  ['tack.html', 'tack.html'],
  ['LICENSE', 'LICENSE.txt'],
  ...[
    'tesseract.js@5.1.1/tesseract.min.js', 'tesseract.js@5.1.1/worker.min.js',
    'tesseract.js@5.1.1/LICENSE.md', 'tesseract.js@5.1.1/tesseract.min.js.LICENSE.txt', 'tesseract.js@5.1.1/worker.min.js.LICENSE.txt', 'tesseract.js@5.1.1/BUNDLED-LICENSES.txt',
    'tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js', 'tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js', 'tesseract.js-core@5.1.1/LICENSE',
    'tesseract.js-data-eng@1.0.0/4.0.0_best_int/eng.traineddata.gz', 'tesseract.js-data-eng@1.0.0/LICENSE'
  ].map(p => [`vendor/${p}`, `vendor/${p}`])
];

export function verify() {
  const problems = [];
  for (const [src] of PUBLIC_FILES) if (!existsSync(join(ROOT, src))) problems.push(`missing ${src}`);
  const listed = [...readFileSync(join(ROOT, 'vendor/README.md'), 'utf8').matchAll(/\| `([^`]+)` \|[^|]+\| [\d,]+ \| `([0-9a-f]{64})` \|/g)];
  if (listed.length !== 5) problems.push(`vendor/README.md lists ${listed.length} files, expected 5`);
  for (const [, file, sha] of listed) {
    const got = createHash('sha256').update(readFileSync(join(ROOT, 'vendor', file))).digest('hex');
    if (got !== sha) problems.push(`vendor/${file} does not match vendor/README.md (${got})`);
    if (!PUBLIC_FILES.some(([src]) => src === `vendor/${file}`)) problems.push(`vendor/${file} is not in the package list`);
  }
  const sri = 'sha384-' + createHash('sha384').update(readFileSync(join(ROOT, 'vendor/tesseract.js@5.1.1/tesseract.min.js'))).digest('base64');
  if (!readFileSync(join(ROOT, 'tack.html'), 'utf8').includes(`OCR_SRI = '${sri}'`)) problems.push('the SRI hash in tack.html does not match vendor/tesseract.js@5.1.1/tesseract.min.js');
  return problems;
}

export function build() {
  const problems = verify();
  if (problems.length) throw new Error(`package refused:\n  ${problems.join('\n  ')}`);
  rmSync(OUT, { recursive: true, force: true });
  for (const [src, dest] of PUBLIC_FILES) { mkdirSync(dirname(join(OUT, dest)), { recursive: true }); copyFileSync(join(ROOT, src), join(OUT, dest)); }
  return listOut();
}

// Every file in dist/, as site paths.
export function listOut(dir = OUT, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? listOut(join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]).sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const files = build();
    console.log(`dist/: ${files.length} files`); files.forEach(f => console.log(`  ${f}`));
  } catch (error) { console.error(error.message); process.exit(1); }
}
