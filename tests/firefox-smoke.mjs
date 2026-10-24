// Firefox smoke test for tack. Run with `node tests/firefox-smoke.mjs` (Node 22+, no dependencies).
//
// Drives a headless Firefox with a throwaway profile over WebDriver BiDi, Firefox's built-in automation protocol
// (tests/run.mjs speaks Chrome's protocol, which Firefox no longer has). It covers the essentials in a second engine,
// not everything run.mjs does. Each check that needs clean storage runs in its own user context (a separate
// cookie and storage jar).
//
//   node tests/firefox-smoke.mjs           tack served over http, picture-text search from vendor/
//   node tests/firefox-smoke.mjs --file    tack.html opened as a file (picture-text search not run: it would use the CDN)
//   FIREFOX_PATH=<exe>                     pick another Firefox build
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FILE_MODE = process.argv.includes('--file');
// --package builds dist/ and serves only it, with the production headers from vercel.json (as tests/run.mjs --package).
const PACKAGE = process.argv.includes('--package');
const pkg = await import(pathToFileURL(join(ROOT, 'tools/package.mjs')).href); if (PACKAGE) pkg.build();
const SERVE_ROOT = PACKAGE ? pkg.OUT : ROOT;
const PROD_HEADERS = PACKAGE ? Object.fromEntries(JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).headers.find(h => h.source === '/(.*)').headers.map(h => [h.key, h.value])) : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- server (tack.html and vendor/ only, or the package)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.gz': 'application/gzip', '.txt': 'text/plain; charset=utf-8' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/\\/g, '/').replace(/^\/+/, '') || 'tack.html';
  const file = join(SERVE_ROOT, path);
  if (!(PACKAGE || path === 'tack.html' || path.startsWith('vendor/')) || path.includes('..') || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store', ...PROD_HEADERS }); res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const URL_APP = FILE_MODE ? pathToFileURL(join(ROOT, 'tack.html')).href : `${ORIGIN}/tack.html`;

// ---------------------------------------------------------------- Firefox
const firefox = process.env.FIREFOX_PATH || [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean).map(p => join(p, 'Mozilla Firefox/firefox.exe')).concat(['/Applications/Firefox.app/Contents/MacOS/firefox', '/usr/bin/firefox']).find(existsSync);
if (!firefox) { console.log('skip  Firefox not found (set FIREFOX_PATH)'); process.exit(0); }
const TMP = mkdtempSync(join(tmpdir(), 'tack-firefox-')), PROFILE = join(TMP, 'profile');
// A fresh profile: no first-run pages, no telemetry or update traffic from the browser itself.
mkdirSync(PROFILE);
writeFileSync(join(PROFILE, 'user.js'), ['browser.shell.checkDefaultBrowser', 'datareporting.policy.dataSubmissionEnabled', 'toolkit.telemetry.enabled', 'app.update.enabled', 'browser.startup.page']
  .map(k => `user_pref("${k}", ${k === 'browser.startup.page' ? 0 : 'false'});`).join('\n'));
const port = await new Promise(r => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const proc = spawn(firefox, ['-headless', '-no-remote', '-profile', PROFILE, `--remote-debugging-port=${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((res, rej) => { let buf = ''; const t = setTimeout(() => rej(new Error('Firefox did not start BiDi')), 30000); proc.stderr.on('data', d => { buf += d; if (/WebDriver BiDi listening/.test(buf)) { clearTimeout(t); res(); } }); });

const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let seq = 0; const pending = new Map(), errors = [], requests = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.type === 'error' ? p.reject(new Error(`${p.method}: ${m.error} ${m.message}`)) : p.resolve(m.result); return; }
  if (m.method === 'log.entryAdded' && (m.params.type === 'javascript' || m.params.level === 'error')) errors.push(m.params.text);
  if (m.method === 'network.beforeRequestSent') requests.push(m.params.request.url);
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, method }); ws.send(JSON.stringify({ id, method, params })); });
const { capabilities } = await send('session.new', { capabilities: {} });
await send('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent'] });

async function newTab() { // its own user context: storage starts empty
  const { userContext } = await send('browser.createUserContext', {});
  const { context } = await send('browsingContext.create', { type: 'tab', userContext });
  const tab = {
    context,
    goto: url => send('browsingContext.navigate', { context, url, wait: 'complete' }).then(() => sleep(300)),
    reload: () => send('browsingContext.reload', { context, wait: 'complete' }).then(() => sleep(300)),
    // The expression's value comes back through JSON, so anything serializable works.
    async eval(expression) {
      const r = await send('script.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, target: { context }, awaitPromise: true, userActivation: true });
      if (r.type === 'exception') throw new Error(`page threw: ${r.exceptionDetails.text}`);
      return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
    },
    async waitFor(expression, what = expression, timeout = 10000) {
      const t0 = Date.now(); let last;
      while (Date.now() - t0 < timeout) { try { last = await tab.eval(expression); if (last) return last; } catch (e) { last = e.message; } await sleep(80); }
      throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    },
    close: () => send('browsingContext.close', { context }).then(() => send('browser.removeUserContext', { userContext })).catch(() => {})
  };
  await tab.goto(URL_APP);
  return tab;
}

// ---------------------------------------------------------------- page-side helpers
const titles = `[...document.querySelectorAll('article.note .note-title')].map(e => e.textContent)`;
const stored = `JSON.parse(localStorage.getItem('tack_state'))`;
const type = (sel, text) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const click = sel => `(() => { document.querySelector(${JSON.stringify(sel)}).click(); return true; })()`;
const menu = text => `(() => { const b = [...document.querySelectorAll('#menu .menu-item')].find(x => x.textContent.trim().startsWith(${JSON.stringify(text)})); b.click(); return true; })()`;
const confirmOk = `(async () => { for (let i = 0; i < 50 && !document.getElementById('ask').open; i++) await new Promise(r => setTimeout(r, 50)); document.getElementById('ask-ok').click(); return true; })()`;
// Files are handed to tack's own inputs and drop handler with a DataTransfer, as a real pick or drop would.
const giveFiles = (sel, files) => `(() => { const dt = new DataTransfer(); ${files} .forEach(f => dt.items.add(f)); const i = document.querySelector(${JSON.stringify(sel)}); i.files = dt.files; i.dispatchEvent(new Event('change')); return true; })()`;
const addNote = async (tab, title, body = '') => {
  await tab.eval(`(() => { document.getElementById('composer-body').focus(); return true; })()`);
  await tab.eval(type('#composer-title', title)); await tab.eval(type('#composer-body', body)); await tab.eval(click('#composer-close'));
  await tab.waitFor(`${titles}.includes(${JSON.stringify(title)})`, `note "${title}"`);
};

// ---------------------------------------------------------------- checks
const checks = [];
const check = (name, fn, opt = {}) => checks.push({ name, fn, opt });

check('loads with the welcome notes and no errors', async tab => {
  assert.deepEqual(await tab.waitFor(titles), ['welcome to tack', 'example checklist', 'markdown on cards']);
  assert.equal(await tab.eval('document.title'), 'tack - local notes');
  assert.ok(await tab.eval('document.documentElement.scrollWidth <= innerWidth'));
});

check('a new note survives a reload', async tab => {
  await addNote(tab, 'from firefox', 'hello **there**');
  await tab.reload(); await tab.waitFor(`${titles}.includes('from firefox')`, 'the note after reload');
  assert.equal(await tab.eval(`[...document.querySelectorAll('article.note')].find(a => a.textContent.includes('from firefox')).querySelector('strong').textContent`), 'there');
});

check('Markdown: the inputs that used to break render safely, and note links open notes', async tab => {
  await addNote(tab, 'links', ['see [[https://e.invalid/x onfocus=alert(1) autofocus]]', '[[“http://?http://>]]on', '[[[inner]]](https://e.invalid/outer)', '<img src=x onerror=alert(1)>'].join('\n'));
  const shape = await tab.eval(`(() => { const c = [...document.querySelectorAll('article.note')].find(a => a.querySelector('.note-title')?.textContent === 'links');
    return { img: c.querySelectorAll('img').length, handlers: [...c.querySelectorAll('*')].flatMap(e => [...e.attributes].map(a => a.name)).filter(n => n.startsWith('on')).length,
      sameTab: [...c.querySelectorAll('a')].filter(a => a.target !== '_blank' || a.rel !== 'noopener noreferrer').length, wrapped: [...c.querySelectorAll('[data-note-link]')].filter(s => s.closest('a')).length,
      links: [...c.querySelectorAll('[data-note-link]')].map(s => s.dataset.noteLink) }; })()`);
  assert.deepEqual(shape, { img: 0, handlers: 0, sameTab: 0, wrapped: 0, links: ['https://e.invalid/x onfocus=alert(1) autofocus', '“http://?http://>', 'inner'] });
  await tab.eval(`(() => { [...document.querySelectorAll('[data-note-link]')].find(s => s.dataset.noteLink === 'inner').click(); return true; })()`);
  await tab.waitFor(`document.getElementById('editor').open && document.getElementById('editor-title').value === 'inner'`, 'the linked note');
  await tab.eval(click('#editor-close'));
});

check('an SVG inside an imported backup is stored and shown as a PNG', async tab => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/><script>localStorage.setItem('svg_ran', '1')</script></svg>`;
  const bundle = { format: 'tack.bundle.v1', notes: [{ id: 'n-ff', title: 'svg backup', body: '', images: [{ id: 'img-ff-1', name: 'logo.svg', type: 'image/svg+xml', w: 40, h: 30, size: 1 }] }], labels: [], images: { 'img-ff-1': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` } };
  await tab.eval(click('#data-button')); await tab.eval(menu('Import backup - merge'));
  await tab.eval(giveFiles('#import-file', `[new File([${JSON.stringify(JSON.stringify(bundle))}], 'b.json', { type: 'application/json' })]`));
  await tab.waitFor(`${titles}.includes('svg backup')`);
  await tab.waitFor(`(() => { const i = document.querySelector('img[data-img]'); return i && i.complete && i.naturalWidth > 0; })()`, 'the picture to render');
  assert.equal(await tab.eval(`fetch(document.querySelector('img[data-img]').src).then(r => r.blob()).then(b => b.type)`), 'image/png');
  assert.equal(await tab.eval(`localStorage.getItem('svg_ran')`), null);
});

check('a locked note stores only ciphertext and opens with its password after a reload', async tab => {
  await addNote(tab, 'secret', 'the plain text');
  await tab.eval(`(() => { [...document.querySelectorAll('article.note .note-title')].find(e => e.textContent === 'secret').click(); return true; })()`);
  await tab.waitFor(`document.getElementById('editor').open`); await tab.eval(click('#editor-more')); await tab.eval(menu('\u{1F512} Lock'));
  await tab.waitFor(`document.getElementById('ask').open && document.querySelectorAll('#ask-fields input').length === 2`);
  await tab.eval(`(() => { document.querySelectorAll('#ask-fields input').forEach(i => { i.value = 'correct horse'; }); document.getElementById('ask-ok').click(); return true; })()`);
  await tab.waitFor(`!document.getElementById('lock-banner').hidden`); await tab.eval(click('#editor-close'));
  await tab.waitFor(`(() => { const n = ${stored}.notes.find(n => n.title === 'secret'); return n.lock && n.body === ''; })()`, 'ciphertext only');
  assert.ok(!(await tab.eval(`localStorage.getItem('tack_state')`)).includes('the plain text'));
  await tab.reload();
  await tab.eval(`(() => { [...document.querySelectorAll('article.note .note-title')].find(e => e.textContent === 'secret').click(); return true; })()`);
  await tab.waitFor(`document.getElementById('ask').open`);
  await tab.eval(`(() => { document.querySelector('#ask-fields input').value = 'correct horse'; document.getElementById('ask-ok').click(); return true; })()`);
  await tab.waitFor(`document.getElementById('editor').open && document.getElementById('editor-body').value === 'the plain text'`, 'the unlocked text');
  await tab.eval(click('#editor-close'));
});

check('Export backup, then Import backup - replace in an empty browser, restores the notes', async tab => {
  await addNote(tab, 'round trip', 'keep me');
  // Catch the download link instead of saving a file, and read what it points at.
  await tab.eval(`(() => { HTMLAnchorElement.prototype.click = function () { window.__download = { name: this.download, href: this.href }; }; return true; })()`);
  await tab.eval(click('#data-button')); await tab.eval(menu('Export backup'));
  const dl = await tab.waitFor(`window.__download`, 'the export');
  const json = await tab.eval(`fetch(${JSON.stringify(dl.href)}).then(r => r.text())`);
  const backup = JSON.parse(json); assert.equal(backup.format, 'tack.bundle.v1'); assert.equal(backup.version, '1.0.0');
  const other = await newTab();
  try {
    await other.eval(click('#data-button')); await other.eval(menu('Import backup - replace'));
    await other.eval(giveFiles('#import-file', `[new File([${JSON.stringify(json)}], ${JSON.stringify(dl.name)}, { type: 'application/json' })]`));
    await other.eval(confirmOk);
    await other.waitFor(`${titles}.includes('round trip')`, 'the imported notes');
    assert.deepEqual((await other.eval(stored)).notes.map(n => n.title).sort(), backup.notes.map(n => n.title).sort());
  } finally { await other.close(); }
});

check('themes cycle and the choice survives a reload', async tab => {
  const theme = `document.documentElement.dataset.theme || 'system'`;
  for (const want of ['light', 'dark', 'vegas']) { await tab.eval(click('#theme-button')); assert.equal(await tab.eval(theme), want); }
  await tab.reload(); assert.equal(await tab.eval(theme), 'vegas');
});

check('picture-text search reads a screenshot from vendor/ on the same site', async tab => {
  await tab.eval(click('#data-button')); await tab.eval(menu('Search text in pictures')); await tab.eval(confirmOk);
  await tab.eval(`(async () => { const c = document.createElement('canvas'); c.width = 900; c.height = 160; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 160); g.fillStyle = '#000'; g.font = 'bold 64px Arial, sans-serif'; g.fillText('HELLO TACK 2026', 30, 105);
    const blob = await new Promise(r => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
  await tab.waitFor(`document.querySelectorAll('#composer-images img').length === 1`, 'the dropped picture'); await tab.eval(click('#composer-close'));
  await tab.waitFor(`${stored}.notes.some(n => n.images.some(i => /HELLO TACK 2026/.test(i.text || '')))`, 'the picture text', 90000);
}, { http: true });

// ---------------------------------------------------------------- run
let passed = 0, failed = 0, skipped = 0;
console.log(`tack Firefox smoke · Firefox ${capabilities.browserVersion} · ${URL_APP}`);
for (const c of checks) {
  if (c.opt.http && FILE_MODE) { skipped++; console.log(`skip  ${c.name} (needs tack served over http)`); continue; }
  const tab = await newTab(), before = errors.length, t0 = Date.now();
  try {
    await c.fn(tab);
    assert.deepEqual(errors.slice(before), [], 'page errors');
    passed++; console.log(`ok    ${c.name} (${Date.now() - t0} ms)`);
  } catch (e) { failed++; console.log(`FAIL  ${c.name}\n      ${String(e.message || e).split('\n').slice(0, 12).join('\n      ')}`); }
  finally { await tab.close(); }
}
const outside = [...new Set(requests.filter(u => !(FILE_MODE ? /^(file|data|blob|about|moz-extension|resource|chrome):/ : new RegExp(`^(${ORIGIN.replace(/[.:/]/g, '\\$&')}|data:|blob:|about:)`)).test(u)))];
if (outside.length) { failed++; console.log(`FAIL  network: pages contacted ${outside.join(', ')}`); }
else { passed++; console.log(`ok    network: ${requests.length} page requests, none outside ${FILE_MODE ? 'local files' : ORIGIN}`); }
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);

await send('browser.close').catch(() => {});
await new Promise(r => { if (proc.exitCode !== null) return r(); proc.once('exit', r); setTimeout(r, 8000); });
server.close();
for (let i = 0; i < 10; i++) { try { rmSync(TMP, { recursive: true, force: true }); break; } catch { await sleep(400); } }
process.exit(failed ? 1 : 0);
