// Browser tests for tack. Run with `node tests/run.mjs` (Node 22.2+, no dependencies).
//
// Drives a throwaway headless Chrome (or Edge) over the DevTools protocol. Every test gets its own browser context,
// so localStorage and IndexedDB start empty and nothing touches a real profile. The page is served from a local http
// server on a random port; fixtures are generated into a temp folder that is deleted afterward.
//
//   node tests/run.mjs                 all offline tests
//   node tests/run.mjs --only=svg      tests whose name contains "svg"
//   node tests/run.mjs --browser=edge  use Microsoft Edge (CHROME_PATH=... picks any Chromium build)
//   node tests/run.mjs --ocr           also run the picture-text test, which downloads tesseract.js from jsDelivr
//   node tests/run.mjs --app=old.html  test another copy of the page (used to show each regression test fails on the old code)
//   node tests/run.mjs --csp           serve the page with the Content-Security-Policy proposed in docs/DEPLOYMENT.md
//   node tests/run.mjs --file          open tack.html as a file (file://) instead of over http, like a downloaded copy
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const APP = 'tack.html';
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
// --package builds dist/ with tools/package.mjs and serves only that folder, with the production headers and the /
// rewrite from vercel.json: the site exactly as it would be deployed.
const PACKAGE = !!args.package, pkg = await import(pathToFileURL(join(ROOT, 'tools/package.mjs')).href);
if (PACKAGE) pkg.build();
const SERVE_ROOT = PACKAGE ? pkg.OUT : ROOT;
// --app=<file> serves another copy of the page under the same URL, e.g. an older version to prove a test catches its bug.
const APP_FILE = args.app ? resolve(args.app) : join(SERVE_ROOT, APP);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures
const TMP = mkdtempSync(join(tmpdir(), 'tack-tests-'));
const FIX = join(TMP, 'fixtures'); mkdirSync(FIX);
function png(w, h, pixel = (x, y) => [40, 160, 90, 255]) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (1 + w * 4) + 1 + x * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// High bits only: the low byte of this generator repeats every 256 values, which compresses to almost nothing.
let seed = 7; const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 16) & 255; };
// Script that, if it ever runs as a page of tack's origin, leaves a mark the tests look for.
// Two marks: one in the page's storage (seen over http), one on the document itself (seen even where a file:// page's
// blobs get an opaque origin with no storage of their own).
const MARK = tag => `try { localStorage.setItem('svg_ran', '${tag}') } catch (e) {} document.documentElement.setAttribute('data-ran', '${tag}')`;
const evilSvg = (tag, pad = 0) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/><script>${MARK(tag)}</script><!--${'x'.repeat(pad)}--></svg>`;
const F = {};
const fixture = (name, data) => { const p = join(FIX, name); writeFileSync(p, data); F[name] = p; return p; };
fixture('small.png', png(64, 48));
fixture('big.png', png(3000, 2000, () => [noise(), noise(), noise(), 255])); // photo-like noise: over 3 MB, so it must be scaled
fixture('evil.svg', evilSvg('picker'));
fixture('nosize.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="blue"/><script>${MARK('nosize')}</script></svg>`);
const NOISY = png(40, 40, () => [noise(), noise(), noise(), 255]); // > 2 KB, so email import doesn't skip it as a logo
const POLYGLOT = Buffer.concat([NOISY, Buffer.from(`<html><body><script>${MARK('polyglot')}</script></body></html>`)]);
const b64lines = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
fixture('attachments.eml', [
  'From: Tester <a@example.com>', 'To: b@example.com', 'Subject: Attachment safety', 'Date: Fri, 23 Oct 2026 10:00:00 -0500',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="BOUNDARY"', '',
  '--BOUNDARY', 'Content-Type: text/plain; charset=utf-8', '', 'Two attachments.',
  '--BOUNDARY', 'Content-Type: text/html; name="poly.png"', 'Content-Disposition: attachment; filename="poly.png"', 'Content-Transfer-Encoding: base64', '', b64lines(POLYGLOT),
  '--BOUNDARY', 'Content-Type: image/svg+xml; name="mail.svg"', 'Content-Disposition: attachment; filename="mail.svg"', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(evilSvg('email', 3000))),
  '--BOUNDARY--', ''
].join('\r\n'));
fixture('keep-note.json', JSON.stringify({ title: 'From Keep', textContent: 'hello', createdTimestampUsec: 1700000000000000, userEditedTimestampUsec: 1700000000000000, attachments: [{ filePath: 'keep-evil.svg', mimetype: 'image/svg+xml' }] }));
fixture('keep-evil.svg', evilSvg('keep'));
const dataUrl = (type, buf) => `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
const XHTML_XML = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><script>${MARK('xml')}</script></body></html>`;
const bundleNote = (id, title, images) => ({ id, type: 'note', title, body: 'from a backup', images, created: 1, updated: 1, order: 0 });
const imgMeta = (id, name, type) => ({ id, name, type, w: 40, h: 30, size: 100 });
fixture('evil-bundle.json', JSON.stringify({
  format: 'tack.bundle.v1', version: '1.0', labels: [],
  notes: [bundleNote('n-evil', 'Backup with pictures', [imgMeta('img-svg-1', 'logo.svg', 'image/svg+xml'), imgMeta('img-xml-1', 'odd.xml', 'image/foo+xml'), imgMeta('img-png-1', 'ok.png', 'image/png')])],
  images: { 'img-svg-1': dataUrl('image/svg+xml', evilSvg('bundle')), 'img-xml-1': dataUrl('image/foo+xml', XHTML_XML), 'img-png-1': dataUrl('image/png', png(10, 10)) }
}));
fixture('new-notes-bundle.json', JSON.stringify({ format: 'tack.bundle.v1', version: '1.0', labels: [], notes: [bundleNote('n-fresh-1', 'Brand new one', [])], images: {} }));
fixture('ocr.png', Buffer.alloc(0)); // drawn by the browser in the OCR test (only used with --ocr)

// ---------------------------------------------------------------- local server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
// --csp serves every response with the production headers, read from vercel.json (the one place they are defined),
// and any policy violation the page reports fails the test it happened in. TACK_CSP=<policy> swaps in another policy.
const PROD_HEADERS = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).headers.find(h => h.source === '/(.*)').headers.map(h => [h.key.toLowerCase(), h.value]));
const CSP = process.env.TACK_CSP || PROD_HEADERS['content-security-policy'];
// Tests can make the server misbehave: per vendor file 404 | 'tamper' (one byte changed) | 'stub' (a worker that never
// answers), and rewrite the page as served (to shorten timeouts). The runner resets both after every test.
const serverState = { faults: {}, transform: null, hits: [] };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/\\/g, '/').replace(/^\/+/, '');
  serverState.hits.push(path);
  const headers = type => ({ 'content-type': type, 'cache-control': 'no-store', ...(args.csp || PACKAGE ? { ...PROD_HEADERS, 'content-security-policy': CSP } : {}) });
  if (path === 'blank.html') { res.writeHead(200, { 'content-type': TYPES['.html'] }); return res.end('<!doctype html><title>blank</title>'); } // test helper, not part of tack
  // '' is the site root, served the way a host that rewrites / to tack.html would serve it.
  if (path === APP || path === '') { const html = readFileSync(APP_FILE, 'utf8'); res.writeHead(200, headers(TYPES['.html'])); return res.end(serverState.transform ? serverState.transform(html) : html); }
  // From the package, any file in dist/ is served (as a host serving the output folder would); otherwise only vendor/.
  const file = join(SERVE_ROOT, path);
  if ((!PACKAGE && !path.startsWith('vendor/')) || path.includes('..') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  const fault = serverState.faults[path];
  if (fault === 404) { res.writeHead(404); return res.end(); }
  let body = readFileSync(file);
  if (fault === 'tamper') body = Buffer.concat([body, Buffer.from('\n')]);
  if (fault === 'stub') body = Buffer.from('self.onmessage = () => {};');
  res.writeHead(200, headers(path.endsWith('.gz') ? 'application/gzip' : TYPES[extname(path)] || 'application/octet-stream')); res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`, FILE_MODE = !!args.file;
const BLANK_FILE = join(TMP, 'blank.html'); writeFileSync(BLANK_FILE, '<!doctype html><title>blank</title>');
const URL_APP = FILE_MODE ? pathToFileURL(APP_FILE).href : `${ORIGIN}/${APP}`, URL_BLANK = FILE_MODE ? pathToFileURL(BLANK_FILE).href : `${ORIGIN}/blank.html`;
const shortTimeouts = html => html.replace('OCR_START_MS = 90000, OCR_PICTURE_MS = 60000', 'OCR_START_MS = 4000, OCR_PICTURE_MS = 4000');

// ---------------------------------------------------------------- browser
function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pf = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = args.browser === 'edge'
    ? [...pf.map(p => join(p, 'Microsoft/Edge/Application/msedge.exe')), '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/microsoft-edge']
    : [...pf.map(p => join(p, 'Google/Chrome/Application/chrome.exe')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find(existsSync); if (!found) throw new Error('No Chrome/Edge found; set CHROME_PATH');
  return found;
}
const PROFILE = mkdtempSync(join(TMP, 'profile-'));
const browserProc = spawn(findBrowser(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
const portFile = join(PROFILE, 'DevToolsActivePort');
for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
const debugPort = readFileSync(portFile, 'utf8').split('\n')[0].trim();
const { webSocketDebuggerUrl, Browser: BROWSER_VERSION } = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = new Set();
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result); } return; }
      for (const l of [...this.listeners]) l(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  wait(pred, timeout = 10000, what = 'event') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${what}`)); }, timeout);
      const off = this.on(m => { if (pred(m)) { clearTimeout(timer); off(); resolve(m); } });
    });
  }
}
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
const cdp = new CDP(ws);
// Every request any page or worker makes, so "no third-party requests" covers the picture-text worker too. Workers are
// attached paused, their network is switched on, then they are let go, so not even their first request is missed.
const allRequests = [], requestUrls = new Map(), blockedByTests = new Set(); // URLs a test blocked on purpose never left the browser
cdp.on(m => {
  if (m.method === 'Network.requestWillBeSent') { allRequests.push(m.params.request.url); requestUrls.set(m.params.requestId, m.params.request.url); }
  if (m.method === 'Network.loadingFailed' && m.params.blockedReason === 'inspector') blockedByTests.add(requestUrls.get(m.params.requestId));
  if (m.method === 'Target.attachedToTarget' && m.params.waitingForDebugger) { // workers (and any frame) start paused
    const sid = m.params.sessionId;
    cdp.send('Network.enable', {}, sid).catch(() => {}).then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sid)).catch(() => {});
  }
});

class Page {
  constructor(sessionId, targetId) {
    this.sessionId = sessionId; this.targetId = targetId; this.errors = []; this.console = [];
    this.off = cdp.on(m => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(m.params.type)) this.console.push(m.params.args.map(a => a.value ?? a.description).join(' '));
      // The test's own probes (iframes on blob URLs) are expected to be refused under the policy; anything else is the app.
      if (args.csp && m.method === 'Log.entryAdded' && /Content Security Policy/.test(m.params.entry.text) && !/frame-src|child-src/.test(m.params.entry.text)) this.errors.push(`CSP: ${m.params.entry.text}`);
    });
  }
  send(method, params) { return cdp.send(method, params, this.sessionId); }
  async goto(url) {
    const loaded = cdp.wait(m => m.sessionId === this.sessionId && m.method === 'Page.loadEventFired', 15000, `load of ${url}`);
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) { loaded.catch(() => {}); return r.errorText; }
    await loaded; await sleep(200); return null;
  }
  async reload() { const loaded = cdp.wait(m => m.sessionId === this.sessionId && m.method === 'Page.loadEventFired', 15000, 'reload'); await this.send('Page.reload', {}); await loaded; await sleep(250); }
  async eval(expression, gesture = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  click(selector) { return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no element ${selector.replace(/'/g, '')}'); el.click(); return true; })()`, true); }
  clickMenu(text) { return this.eval(`(() => { const b = [...document.querySelectorAll('#menu .menu-item')].find(x => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) throw new Error('no menu item ${text.replace(/'/g, '')}'); b.click(); return true; })()`, true); }
  async focus(selector) { await this.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`); }
  // Typed text goes to the tab in front, so bring this one forward first (matters when a test has two tabs).
  async type(selector, text) { await this.send('Page.bringToFront', {}); await this.focus(selector); await this.send('Input.insertText', { text }); }
  async key(key, mods = {}) {
    const codes = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 }, vk = codes[key] || key.toUpperCase().charCodeAt(0);
    const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: vk, modifiers: (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0) };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  async waitFor(expression, what = expression, timeout = 8000) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < timeout) { try { last = await this.eval(expression); if (last) return last; } catch (e) { last = e.message; } await sleep(60); }
    const toast = await this.eval(`document.getElementById('toast')?.textContent || ''`).catch(() => '');
    throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)}; toast: ${JSON.stringify(toast)})`);
  }
  async chooseFiles(trigger, files) {
    const opened = cdp.wait(m => m.sessionId === this.sessionId && m.method === 'Page.fileChooserOpened', 8000, 'file chooser');
    await trigger(); const ev = await opened;
    await this.send('DOM.setFileInputFiles', { files, backendNodeId: ev.params.backendNodeId });
  }
  async confirm(ok = true) { await this.waitFor(`document.getElementById('ask').open`, 'confirm dialog'); await this.click(ok ? '#ask-ok' : '#ask-cancel'); await sleep(100); }
  toast() { return this.eval(`document.getElementById('toast').textContent`); }
  close() { this.off(); return cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {}); }
}

async function newContext() {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const dl = mkdtempSync(join(TMP, 'downloads-'));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dl, browserContextId, eventsEnabled: true });
  const pages = [];
  return {
    id: browserContextId, pages,
    async open(url = URL_APP, { width = 1280, mobile = false } = {}) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const page = new Page(sessionId, targetId); pages.push(page);
      for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await page.send(m, {});
      await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
      await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });
      if (url !== 'about:blank') await page.goto(url);
      return page;
    },
    // Resolves to the text of the next file this context downloads.
    async download(trigger) {
      const begin = cdp.wait(m => m.method === 'Browser.downloadWillBegin', 10000, 'download start');
      await trigger(); const { params: { guid, suggestedFilename } } = await begin;
      await cdp.wait(m => m.method === 'Browser.downloadProgress' && m.params.guid === guid && m.params.state === 'completed', 15000, 'download end');
      return { name: suggestedFilename, path: join(dl, guid), text: readFileSync(join(dl, guid), 'utf8') };
    },
    async close() { for (const p of pages) p.off(); await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {}); }
  };
}

// ---------------------------------------------------------------- page-side helpers
// Read a whole IndexedDB store of tack's database (opening it without a version never upgrades it).
const idbAll = (store, withKeys = false) => `new Promise((res, rej) => { const r = indexedDB.open('tack'); r.onerror = () => rej(r.error); r.onsuccess = () => {
  const db = r.result; if (!db.objectStoreNames.contains('${store}')) { db.close(); return res([]); }
  const tx = db.transaction('${store}'), st = tx.objectStore('${store}'), keys = st.getAllKeys(), vals = st.getAll();
  tx.oncomplete = async () => { const out = []; for (let i = 0; i < keys.result.length; i++) { const v = vals.result[i]; out.push(v instanceof Blob ? { key: keys.result[i], type: v.type, size: v.size, head: (await v.slice(0, 64).text()) } : ${withKeys ? '{ key: keys.result[i], value: v }' : 'v'}); } db.close(); res(out); }; } })`;
const storedState = `JSON.parse(localStorage.getItem('tack_state'))`;
const noteTitles = `[...document.querySelectorAll('article.note .note-title')].map(e => e.textContent)`;
const cardIdByTitle = t => `[...document.querySelectorAll('article.note')].find(a => a.querySelector('.note-title')?.textContent === ${JSON.stringify(t)})?.dataset.id`;
async function openData(page, item) { await page.click('#data-button'); await page.clickMenu(item); }
// Seed storage before tack ever loads, from a blank page on the same origin.
async function seedThenOpen(ctx, script, opts) {
  const page = await ctx.open(URL_BLANK, opts); await page.eval(`(async () => { ${script} })()`);
  await page.goto(URL_APP); return page;
}
const seedIdbV3 = puts => `await new Promise((res, rej) => { const r = indexedDB.open('tack', 3);
  r.onupgradeneeded = () => ['handles', 'images', 'backups', 'history'].forEach(s => r.result.createObjectStore(s));
  r.onerror = () => rej(r.error); r.onsuccess = () => { const db = r.result, tx = db.transaction('images', 'readwrite');
  ${puts}; tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); }; });`;

// Every way a stored picture can be reached directly: a new tab on its blob URL (like "Open image in new tab") and an
// iframe inside tack (a page-initiated load). Returns what each one turned out to be, and whether any script ran.
async function probeImageUrls(ctx, page, srcs) {
  const seen = []; let mark = null;
  for (const src of srcs) {
    const tab = await ctx.open('about:blank'); const err = await tab.goto(src);
    seen.push({ src, how: 'tab', result: err ? `refused: ${err}` : await tab.eval('document.contentType') });
    if (!err) mark ||= await tab.eval(`document.documentElement && document.documentElement.getAttribute('data-ran')`);
    await tab.close();
    const framed = await page.eval(`new Promise(res => { const f = document.createElement('iframe'); f.style.display = 'none'; f.onload = () => { let t = 'opaque', m = null; try { t = f.contentDocument.contentType; m = f.contentDocument.documentElement.getAttribute('data-ran'); } catch {} f.remove(); res({ t, m }); }; f.src = ${JSON.stringify(src)}; document.body.append(f); setTimeout(() => res({ t: 'no load', m: null }), 4000); })`);
    seen.push({ src, how: 'iframe', result: framed.t }); mark ||= framed.m;
  }
  await sleep(300);
  return { seen, ran: await page.eval(`localStorage.getItem('svg_ran')`) || mark };
}
const shownImageSrcs = `[...document.querySelectorAll('img[data-img]')].map(i => i.src).filter(Boolean)`;
const allImagesRendered = `(() => { const imgs = [...document.querySelectorAll('img[data-img]')]; return imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0); })()`;
async function assertImagesSafe(ctx, page, minimum) {
  await page.waitFor(allImagesRendered, 'every picture to render');
  const srcs = await page.eval(shownImageSrcs);
  assert.ok(srcs.length >= minimum, `expected at least ${minimum} pictures, saw ${srcs.length}`);
  const types = await page.eval(`Promise.all(${shownImageSrcs}.map(s => fetch(s).then(r => r.blob()).then(b => b.type)))`);
  types.forEach(t => assert.match(t, /^image\/(png|jpeg|gif|webp|bmp|avif)$/, `a shown picture has type ${t}`));
  const probe = await probeImageUrls(ctx, page, srcs);
  assert.equal(probe.ran, null, `script ran from a picture: ${probe.ran}`);
  probe.seen.forEach(s => assert.doesNotMatch(s.result, /svg|xml|html/, `${s.how} load of a picture became ${s.result}`));
}

// ---------------------------------------------------------------- runner
const tests = [];
const test = (name, fn, opt = {}) => tests.push({ name, fn, opt });

// ================================================================ security regressions
test('security: the probe detects script in a raw SVG blob (positive control)', async ctx => {
  const page = await ctx.open();
  const src = await page.eval(`URL.createObjectURL(new Blob([${JSON.stringify(evilSvg('control'))}], { type: 'image/svg+xml' }))`);
  const probe = await probeImageUrls(ctx, page, [src]);
  assert.equal(probe.ran, 'control', 'the probe must see script run, or a pass elsewhere means nothing');
});

test('security: an SVG picked from disk is stored and shown as PNG, never as SVG', async ctx => {
  const page = await ctx.open();
  await page.chooseFiles(() => page.click('#quick-image'), [F['evil.svg'], F['nosize.svg']]);
  await page.waitFor(`document.querySelectorAll('#composer-images img').length === 2`, 'two thumbnails');
  await page.click('#composer-close');
  await page.waitFor(`document.querySelectorAll('article.note img[data-img]').length >= 1`);
  const blobs = await page.eval(idbAll('images'));
  assert.equal(blobs.length, 2); blobs.forEach(b => assert.equal(b.type, 'image/png'));
  const meta = (await page.eval(storedState)).notes.flatMap(n => n.images);
  assert.deepEqual(meta.map(m => m.name).sort(), ['evil.png', 'nosize.png']);
  await page.click('article.note [data-act="image"]'); await page.waitFor(`document.getElementById('lightbox').open && document.getElementById('lb-img').naturalWidth > 0`, 'lightbox picture');
  await page.click('#lb-close');
  await assertImagesSafe(ctx, page, 1);
});

test('security: SVG and other XML pictures inside an imported backup are converted or refused', async ctx => {
  const page = await ctx.open();
  await page.chooseFiles(async () => { await openData(page, 'Import backup - merge'); }, [F['evil-bundle.json']]);
  await page.waitFor(`${noteTitles}.includes('Backup with pictures')`);
  assert.match(await page.toast(), /1 picture converted to PNG · 1 unreadable picture skipped/);
  const blobs = await page.eval(idbAll('images'));
  assert.deepEqual(blobs.map(b => `${b.key}:${b.type}`).sort(), ['img-png-1:image/png', 'img-svg-1:image/png']);
  const meta = (await page.eval(storedState)).notes.find(n => n.id === 'n-evil').images;
  assert.deepEqual(meta.find(m => m.id === 'img-svg-1').name, 'logo.png');
  await page.waitFor(`document.querySelectorAll('img[data-img].missing').length === 1`, 'the refused picture to show as missing');
  const srcs = await page.eval(shownImageSrcs);
  const probe = await probeImageUrls(ctx, page, srcs);
  assert.equal(probe.ran, null); probe.seen.forEach(s => assert.doesNotMatch(s.result, /svg|xml|html/));
});

test('security: email attachments (an SVG, and a PNG/HTML polyglot labelled text/html) end up as safe bitmaps', async ctx => {
  const page = await ctx.open();
  await page.chooseFiles(async () => { await openData(page, 'Import email'); }, [F['attachments.eml']]);
  await page.waitFor(`document.getElementById('editor').open`, 'email note');
  await page.click('#editor-close');
  const meta = (await page.eval(storedState)).notes.find(n => n.title === 'Attachment safety');
  const blobs = await page.eval(idbAll('images'));
  assert.deepEqual(blobs.map(b => b.type).sort(), ['image/png', 'image/png'], `stored: ${JSON.stringify(blobs.map(b => [b.type, b.size]))}; note: ${JSON.stringify(meta.images)}; console: ${JSON.stringify(page.console)}`);
  const poly = meta.images.find(m => m.name === 'poly.png');
  assert.equal(poly?.size, POLYGLOT.length, 'the polyglot keeps its bytes, but only under an image type');
  assert.ok(meta.images.some(m => m.name === 'mail.png'), 'the SVG attachment became a PNG');
  await assertImagesSafe(ctx, page, 2);
});

test('security: Google Keep import converts an SVG attachment', async ctx => {
  const page = await ctx.open();
  await page.chooseFiles(async () => { await openData(page, 'Import Google Keep'); }, [F['keep-note.json'], F['keep-evil.svg']]);
  await page.waitFor(`${noteTitles}.includes('From Keep')`);
  const blobs = await page.eval(idbAll('images'));
  assert.equal(blobs.length, 1); assert.equal(blobs[0].type, 'image/png');
  await assertImagesSafe(ctx, page, 1);
});

test('security: an SVG stored by an earlier version is shown as PNG and the stored original is left alone', async ctx => {
  const id = `img-${(Date.now() - 7200000).toString(36)}-legacy`;
  const note = { id: 'n-legacy', type: 'note', title: 'Old picture', body: '', images: [{ id, name: 'old.svg', type: 'image/svg+xml', w: 40, h: 30, size: 200 }], created: 1, updated: 1, order: 0 };
  const page = await seedThenOpen(ctx, `
    localStorage.setItem('tack_state', ${JSON.stringify(JSON.stringify({ format: 'tack.state.v1', version: '1.0', notes: [note], labels: [], templates: [] }))});
    ${seedIdbV3(`tx.objectStore('images').put(new Blob([${JSON.stringify(evilSvg('legacy'))}], { type: 'image/svg+xml' }), ${JSON.stringify(id)})`)}`);
  await page.waitFor(`${noteTitles}.includes('Old picture')`);
  await assertImagesSafe(ctx, page, 1);
  const blobs = await page.eval(idbAll('images'));
  assert.equal(blobs[0].type, 'image/svg+xml', 'stored data is not rewritten');
  const stores = await page.eval(`new Promise(r => { const q = indexedDB.open('tack'); q.onsuccess = () => { const v = { version: q.result.version, stores: [...q.result.objectStoreNames] }; q.result.close(); r(v); }; })`);
  assert.deepEqual(stores, { version: 4, stores: ['backups', 'handles', 'history', 'images', 'recovery'] }, 'v3 database upgraded in place');
});

test('security: Markdown renderer, 40,000 fuzzed inputs, no handlers/unexpected tags/unsafe links (detector validated first)', async ctx => {
  const src = readFileSync(APP_FILE, 'utf8').split('\n');
  const line = start => { const l = src.find(x => x.startsWith(start)); assert.ok(l, `marker missing: ${start}`); return l; };
  const from = src.findIndex(x => x.startsWith('      let titleIndex = null;')), to = src.findIndex(x => x.startsWith('      function lineToItem('));
  assert.ok(from > 0 && to > from, 'renderer markers missing');
  const code = [line('      const esc = s =>'), ...src.slice(from, to), line('      const normTitle = ')].join('\n');
  const page = await ctx.open(URL_BLANK);
  const result = await page.eval(`(() => {
    const state = { notes: [{ title: 'Existing', trashed: 0 }] };
    ${code}
    const TAGS = new Set(['P','BR','UL','OL','LI','H4','BLOCKQUOTE','HR','PRE','CODE','SPAN','A','STRONG','EM','DEL','BUTTON']);
    const host = document.createElement('div'); document.body.append(host);
    const ATTRS = new Set(['class','role','tabindex','data-note-link','title','href','target','rel','type','data-md-line','aria-label']);
    // bad = security invariants; odd = malformed markup or navigation surprises (a same-tab link, a note link inside an
    // external link, a note link whose target differs from its text). Both must be empty.
    const scan = html => { host.innerHTML = html; const bad = [], odd = [];
      for (const el of host.querySelectorAll('*')) {
        if (!TAGS.has(el.tagName)) bad.push('tag ' + el.tagName);
        for (const a of el.attributes) { const n = a.name.toLowerCase();
          if (n.startsWith('on') || ['style','src','srcdoc','formaction','action','xlink:href'].includes(n)) bad.push('attr ' + n);
          else if (!ATTRS.has(n)) odd.push('stray attribute ' + n);
          if (n === 'href' && !/^(https?:\\/\\/|mailto:)/i.test(a.value)) bad.push('href ' + a.value); }
        if (el.tagName === 'A' && (el.target !== '_blank' || el.rel !== 'noopener noreferrer')) odd.push('link opens in the same tab');
        if (el.matches('[data-note-link]') && el.closest('a')) odd.push('note link inside an external link');
        if (el.matches('[data-note-link]') && (el.dataset.noteLink !== el.textContent || el.children.length)) odd.push('note link target differs from its text');
      } return { bad, odd }; };
    const control = ['<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<span onmouseover=alert(1)>x</span>', '<iframe srcdoc=x></iframe>'].map(h => scan(h).bad.length);
    const oddControl = ['<a href="https://x.invalid">x</a>', '<a class="ext" href="https://x.invalid" target="_blank" rel="noopener noreferrer"><span data-note-link="a">a</span></a>', '<span ext"="">x</span>'].map(h => scan(h).odd.length);
    let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const atoms = ['[[', ']]', '[', ']', '(', ')', '*', '**', '\`', '~~', '"', "'", '<', '>', '&', ' ', ' ', 'https://', 'http://', 'www.', 'mailto:', 'e.co', '/', ',', '=', '\\u201c', '\\u201d', 'on', 'x', 'onmouseover=alert(1)', 'javascript:', '#', '- [ ] ', '\\n', '\`\`\`', '.', ';', ':', '!', '?', '\\t', '\\u0000', '\\u0001', '0', '1'];
    // The inputs that broke before: a URL inside a [[link]] (Phase A and B findings) and a [[link]] wrapped in an external link.
    const directed = ['[[https://e.co/x onfocus=alert(1) autofocus]]', '[[x,www.e.co onmouseover=alert(1) x]]', '[[https://a.co https://b.co onmouseover=alert(1)]]', '[[\\u201chttp://?http://>]]on',
      '[[[inner]]](https://e.invalid/outer)', '[x](https://a.invalid/[[b]])', '*[[https://e.co/x*y]]*', '\`[[https://e.co]]\`', '[[a [[b]] c]]', '[[\\u00000\\u0001]]', '[x](javascript:alert(1))', '<img src=x onerror=alert(1)>', 'www.e.co"onclick=alert(1)', '[a https://b.co](https://c.co)'];
    let cases = 0, failures = [], oddCases = [];
    const run = s => { cases++; const r = scan(renderMarkdown(s));
      if (r.bad.length && failures.length < 5) failures.push({ s, bad: r.bad });
      if (r.odd.length && oddCases.length < 5) oddCases.push({ s, odd: r.odd }); };
    directed.forEach(run); for (let i = 0; i < 40000; i++) { let s = ''; const n = 2 + rnd(14); for (let k = 0; k < n; k++) s += atoms[rnd(atoms.length)]; run(s); }
    return { control, oddControl, cases, failures, oddCases, directed: directed.length };
  })()`);
  result.control.forEach((n, i) => assert.ok(n > 0, `detector missed known-bad sample ${i}`));
  result.oddControl.forEach((n, i) => assert.ok(n > 0, `detector missed known-malformed sample ${i}`));
  assert.equal(result.cases, 40000 + result.directed);
  assert.deepEqual(result.failures, [], 'security invariant broken');
  assert.deepEqual(result.oddCases, [], 'malformed markup or a navigation surprise');
});

test('navigation: clicking [[links]] in the inputs that used to break opens the note, never a page', async ctx => {
  const page = await ctx.open();
  const body = ['see [[https://e.invalid/x onfocus=alert(1) autofocus]]', '[[“http://?http://>]]on', '[[[inner]]](https://e.invalid/outer)', '[x](https://a.invalid/[[b]])'].join('\n');
  await page.focus('#composer-body'); await page.type('#composer-title', 'Links'); await page.type('#composer-body', body); await page.click('#composer-close');
  const id = await page.waitFor(cardIdByTitle('Links'));
  const card = `article.note[data-id="${id}"]`;
  const shape = await page.eval(`(() => { const c = document.querySelector('${card}');
    return { sameTab: [...c.querySelectorAll('a')].filter(a => a.target !== '_blank' || a.rel !== 'noopener noreferrer').length,
      wrapped: [...c.querySelectorAll('[data-note-link]')].filter(s => s.closest('a')).length,
      links: [...c.querySelectorAll('[data-note-link]')].map(s => s.dataset.noteLink) }; })()`);
  assert.equal(shape.sameTab, 0, 'no link may open in the tack tab'); assert.equal(shape.wrapped, 0, 'no note link inside an external link');
  assert.deepEqual(shape.links, ['https://e.invalid/x onfocus=alert(1) autofocus', '“http://?http://>', 'inner', 'b']);
  const pagesNow = async () => (await cdp.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.browserContextId === ctx.id).length;
  const before = await pagesNow(), url = await page.eval('location.href');
  for (const title of shape.links) {
    await page.eval(`[...document.querySelectorAll('${card} [data-note-link]')].find(s => s.dataset.noteLink === ${JSON.stringify(title)}).click()`, true);
    await page.waitFor(`document.getElementById('editor').open && document.getElementById('editor-title').value === ${JSON.stringify(title)}`, `note "${title}" to open`);
    await page.click('#editor-close');
  }
  await sleep(500);
  assert.equal(await pagesNow(), before, 'a click opened another tab'); assert.equal(await page.eval('location.href'), url, 'the tack tab navigated away');
});

test('privacy: offline by default, the shipped text makes no "no network" or "zero dependencies" claims, OCR pinned', async () => {
  const html = readFileSync(APP_FILE, 'utf8');
  for (const claim of ['zero dependencies', 'zero-dependency', 'no accounts or dependencies', 'no account, server or network', '15 MB', 'downloads it once']) assert.ok(!html.includes(claim), `still claims "${claim}"`);
  assert.ok(!html.includes(String.fromCharCode(0x2014)), 'house style: no em dashes anywhere in the app');
  for (const example of ['renew cert', 'call vendor', 'audit due', 'Get-Service', 'ps1', 'IPs or names', 'Change / maintenance', 'Ticket']) assert.ok(!html.includes(example), `old example still present: "${example}"`);
  assert.match(html, /OCR_SRI = 'sha384-[A-Za-z0-9+/=]{64}'/);
  assert.match(html, /@tesseract\.js-data\/eng@1\.0\.0\//, 'language data pinned to an exact version');
  const urls = [...html.matchAll(/https?:\/\/[^\s"'`)<>]+/g)].map(m => m[0]).filter(u => !u.startsWith('http://www.w3.org/'));
  urls.forEach(u => assert.ok(u.startsWith('https://cdn.jsdelivr.net/npm/') || ['https://example.com', 'https://…', 'https://www.gnu.org/licenses/'].includes(u), `unexpected URL in source: ${u}`)); // the last is the license notice, never fetched
  // Every same-site reader path the page names exists, and the files are the ones vendor/README.md vouches for.
  const paths = [...html.matchAll(/\$\{OCR_VENDOR\}([^`]+)`/g)].map(m => m[1]);
  assert.equal(paths.length, 4, 'script, worker, core folder and language folder');
  for (const p of paths) assert.ok(existsSync(join(ROOT, 'vendor', p)), `vendor/${p} missing`);
  for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) assert.ok(existsSync(join(ROOT, 'vendor/tesseract.js-core@5.1.1', f)));
  const listed = [...readFileSync(join(ROOT, 'vendor/README.md'), 'utf8').matchAll(/\| `([^`]+)` \|[^|]+\| [\d,]+ \| `([0-9a-f]{64})` \|/g)];
  assert.equal(listed.length, 5, 'five vendored files listed');
  for (const [, file, sha] of listed) assert.equal(createHash('sha256').update(readFileSync(join(ROOT, 'vendor', file))).digest('hex'), sha, `vendor/${file} differs from vendor/README.md`);
  const sri = 'sha384-' + createHash('sha384').update(readFileSync(join(ROOT, 'vendor/tesseract.js@5.1.1/tesseract.min.js'))).digest('base64');
  assert.ok(html.includes(`OCR_SRI = '${sri}'`), 'the SRI hash in the page matches the vendored script');
});

// ================================================================ reliability regressions
const BROKEN = '{"format":"tack.state.v1","version":"1.0","notes":[{"id":"n-precious","title":"precious","images":[{"id":"img-OLDKEEP"'; // cut off mid-write
test('reliability: an unreadable save is kept byte-for-byte, never replaced, and can be downloaded', async ctx => {
  const keepId = `img-${(Date.now() - 7200000).toString(36)}-kept`, dropId = `img-${(Date.now() - 7200000).toString(36)}-orphan`;
  const raw = BROKEN.replace('img-OLDKEEP', keepId);
  const page = await seedThenOpen(ctx, `localStorage.setItem('tack_state', ${JSON.stringify(raw)});
    ${seedIdbV3(`tx.objectStore('images').put(new Blob(['a'], { type: 'image/png' }), ${JSON.stringify(keepId)}); tx.objectStore('images').put(new Blob(['b'], { type: 'image/png' }), ${JSON.stringify(dropId)})`)}`);
  await sleep(500); // past boot, when the old code wrote its welcome notes over the original
  assert.equal(await page.eval(`localStorage.getItem('tack_state')`), raw, 'original untouched at boot');
  await page.waitFor(`!document.getElementById('storage-alert').hidden`, 'recovery banner');
  assert.match(await page.eval(`document.getElementById('storage-alert').textContent`), /couldn't be read.*Nothing has been overwritten/s);
  assert.equal(await page.eval(`document.getElementById('save-indicator').getAttribute('aria-label')`), 'Not saving: your saved notes could not be read');
  assert.deepEqual(await page.eval(noteTitles), [], 'no welcome notes shown in place of real ones');
  await page.waitFor(`${idbAll('recovery')}.then(r => r.length === 1)`, 'kept copy in IndexedDB');
  assert.equal((await page.eval(idbAll('recovery')))[0].raw, raw);
  // Working in recovery doesn't write over the original, and says so.
  await page.focus('#composer-body'); await page.type('#composer-title', 'typed in recovery'); await page.click('#composer-close');
  assert.equal(await page.eval(`localStorage.getItem('tack_state')`), raw);
  await page.click('#data-button'); await page.clickMenu('Backups'); await page.click('#backup-now');
  assert.equal((await page.eval(idbAll('backups'))).length, 0, 'no snapshot of the empty recovery state');
  await page.click('#backup-close');
  // Reloading finds the same data: still one kept copy, and neither picture swept while it's unresolved.
  await page.reload(); await page.waitFor(`!document.getElementById('storage-alert').hidden`);
  assert.equal((await page.eval(idbAll('recovery'))).length, 1);
  assert.equal((await page.eval(idbAll('images'))).length, 2);
  const file = await ctx.download(() => page.click('[data-recover="download"]'));
  assert.match(file.name, /^tack-unreadable-.*\.txt$/); assert.equal(file.text, raw);
  // Starting fresh writes a readable save; the kept copy stays (and keeps its picture alive), orphans are swept.
  await page.click('[data-recover="fresh"]'); await page.confirm(true);
  await page.waitFor(`document.getElementById('storage-alert').hidden`, 'banner gone');
  assert.equal((await page.eval(storedState)).notes.length, 3);
  await page.reload();
  await page.waitFor(`${idbAll('images')}.then(b => b.length === 1)`, 'boot cleanup to sweep the orphan');
  assert.deepEqual((await page.eval(idbAll('images'))).map(b => b.key), [keepId], 'picture named in the kept copy survives; the orphan is swept');
  await page.click('#data-button'); await page.clickMenu('Backups');
  await page.waitFor(`document.querySelectorAll('[data-recovery]').length === 1`, 'kept copy listed in Backups');
});

test('reliability: a readable save written by another tab ends recovery in this one', async ctx => {
  const page = await seedThenOpen(ctx, `localStorage.setItem('tack_state', ${JSON.stringify(BROKEN)});`);
  await page.waitFor(`!document.getElementById('storage-alert').hidden`);
  const other = await ctx.open(URL_BLANK);
  await other.eval(`localStorage.setItem('tack_state', JSON.stringify({ format: 'tack.state.v1', notes: [{ id: 'n-other', title: 'from the other tab' }], labels: [], templates: [] }))`);
  await page.waitFor(`${noteTitles}.includes('from the other tab') && document.getElementById('storage-alert').hidden`, 'recovery to end');
});

test('reliability: when storage is full the warning stays up until a write succeeds, and nothing claims to be saved', async ctx => {
  // Fill this origin's localStorage completely before tack loads.
  const page = await seedThenOpen(ctx, `const big = 'x'.repeat(1 << 20); let i = 0;
    for (const size of [1 << 20, 1 << 16, 1 << 12, 1 << 8, 16]) { const chunk = big.slice(0, size); try { for (;;) localStorage.setItem('fill-' + i++, chunk); } catch {} }`);
  await page.waitFor(`!document.getElementById('storage-alert').hidden`, 'storage warning at boot');
  assert.match(await page.eval(`document.getElementById('storage-alert').textContent`), /Changes are not being saved/);
  assert.equal(await page.eval(`document.getElementById('save-indicator').getAttribute('aria-label')`), 'NOT saved: browser storage is full or blocked');
  await page.click('#fab'); await page.type('#qc-body', 'written while full'); await page.click('#qc-save');
  await page.waitFor(`document.getElementById('toast').textContent.includes('NOT saved')`, 'toast admitting it was not saved');
  await sleep(3200); // longer than any toast: the banner must still be there
  assert.equal(await page.eval(`document.getElementById('storage-alert').hidden`), false);
  assert.equal(await page.eval(`localStorage.getItem('tack_state')`), null);
  await page.eval(`Object.keys(localStorage).filter(k => k.startsWith('fill-')).forEach(k => localStorage.removeItem(k))`);
  await page.click('[data-recover="retry"]');
  await page.waitFor(`document.getElementById('storage-alert').hidden`, 'warning cleared after a successful write');
  assert.equal(await page.eval(`document.getElementById('save-indicator').getAttribute('aria-label')`), 'Saved locally');
  await page.reload();
  assert.ok((await page.eval(storedState)).notes.some(n => n.body === 'written while full'));
});

test('reliability: a merge that overwrites notes takes a snapshot first, and restoring it brings the edit back', async ctx => {
  const page = await ctx.open();
  const exported = await ctx.download(() => openData(page, 'Export backup'));
  const backup = JSON.parse(exported.text); assert.equal(backup.format, 'tack.bundle.v1');
  const id = await page.eval(cardIdByTitle('welcome to tack'));
  await page.click(`article.note[data-id="${id}"] .note-title`); await page.waitFor(`document.getElementById('editor').open`);
  await page.eval(`(() => { const t = document.getElementById('editor-title'); t.focus(); t.select(); })()`); await page.send('Input.insertText', { text: 'welcome EDITED' });
  await page.click('#editor-close'); await page.waitFor(`${noteTitles}.includes('welcome EDITED')`);
  await page.chooseFiles(() => openData(page, 'Import backup - merge'), [exported.path]);
  await page.waitFor(`${noteTitles}.includes('welcome to tack')`, 'merge to restore the older title');
  const toast = await page.toast();
  const snaps = await page.eval(idbAll('backups'));
  const safety = snaps.filter(b => b.reason === 'safety'); assert.equal(safety.length, 1, 'one safety snapshot before the merge');
  assert.match(toast, /3 replaced existing notes \(snapshot taken first\)/); // the export holds all three welcome notes
  assert.ok(safety[0].data.includes('welcome EDITED'), 'snapshot holds the version the merge replaced');
  await openData(page, 'Backups');
  await page.waitFor(`document.querySelector('[data-backup] .why.safety')`);
  await page.eval(`document.querySelector('[data-backup] .why.safety').closest('[data-backup]').querySelector('[data-restore]').click()`, true);
  await page.confirm(true);
  await page.waitFor(`${noteTitles}.includes('welcome EDITED')`, 'restore to bring the edit back');
  // A merge that only adds new notes overwrites nothing, so it needs no snapshot.
  const before = (await page.eval(idbAll('backups'))).filter(b => b.reason === 'safety').length;
  await page.chooseFiles(() => openData(page, 'Import backup - merge'), [F['new-notes-bundle.json']]);
  await page.waitFor(`${noteTitles}.includes('Brand new one')`);
  assert.equal((await page.eval(idbAll('backups'))).filter(b => b.reason === 'safety').length, before);
});

// ================================================================ functional
test('notes: create, edit, trash, restore and delete forever, surviving reloads', async ctx => {
  const page = await ctx.open();
  await page.focus('#composer-body'); await page.type('#composer-title', 'Groceries'); await page.type('#composer-body', 'eggs and **milk**');
  await page.click('#composer-close');
  await page.waitFor(`${noteTitles}.includes('Groceries')`);
  await page.reload(); await page.waitFor(`${noteTitles}.includes('Groceries')`);
  const id = await page.eval(cardIdByTitle('Groceries'));
  assert.equal(await page.eval(`document.querySelector('article.note[data-id="${id}"] .note-body strong').textContent`), 'milk');
  await page.click(`article.note[data-id="${id}"] .note-title`); await page.waitFor(`document.getElementById('editor').open`);
  await page.eval(`(() => { const t = document.getElementById('editor-title'); t.focus(); t.select(); })()`); await page.send('Input.insertText', { text: 'Groceries list' });
  await page.click('#editor-close'); await page.reload(); await page.waitFor(`${noteTitles}.includes('Groceries list')`);
  await page.click(`article.note[data-id="${id}"] [data-act="trash"]`); await page.waitFor(`!${noteTitles}.includes('Groceries list')`);
  await page.click('[data-view="trash"]'); await page.waitFor(`${noteTitles}.includes('Groceries list')`);
  await page.click(`article.note[data-id="${id}"] [data-act="restore"]`); await page.click('[data-view="notes"]');
  await page.waitFor(`${noteTitles}.includes('Groceries list')`);
  await page.click(`article.note[data-id="${id}"] [data-act="trash"]`); await page.click('[data-view="trash"]');
  await page.click(`article.note[data-id="${id}"] [data-act="purge"]`); await page.confirm(true);
  await page.reload(); assert.ok(!(await page.eval(storedState)).notes.some(n => n.id === id));
});

test('checklists and tasks: items, check-off, natural due dates', async ctx => {
  const page = await ctx.open();
  await page.focus('#composer-body'); await page.click('#composer-list'); await page.type('#composer-title', 'Chores'); await page.type('#composer-body', 'dishes\nlaundry');
  await page.click('#composer-close');
  const id = await page.waitFor(cardIdByTitle('Chores'));
  assert.equal(await page.eval(`document.querySelectorAll('article.note[data-id="${id}"] .li').length`), 2);
  await page.click(`article.note[data-id="${id}"] [data-act="check"]`);
  await page.waitFor(`document.querySelector('article.note[data-id="${id}"]').textContent.includes('1/2 done')`);
  await page.click('[data-view="tasks"]');
  await page.type('[data-task-add] input', 'water plants tomorrow'); await page.eval(`document.querySelector('[data-task-add]').requestSubmit()`);
  await page.waitFor(`[...document.querySelectorAll('.task-row')].some(r => r.textContent.includes('water plants') && r.querySelector('.due-chip')?.textContent === 'tomorrow')`, 'task due tomorrow');
  const inbox = (await page.eval(storedState)).notes.find(n => n.title === 'Inbox'); assert.ok(inbox, 'Inbox checklist made');
  await page.eval(`[...document.querySelectorAll('.task-row')].find(r => r.textContent.includes('water plants')).querySelector('[data-task-check]').click()`, true);
  await page.waitFor(`${storedState}.notes.find(n => n.title === 'Inbox').items[0].done === true`);
});

test('search and labels', async ctx => {
  const page = await ctx.open();
  const id = await page.eval(cardIdByTitle('example checklist'));
  await page.click(`article.note[data-id="${id}"] .note-title`); await page.waitFor(`document.getElementById('editor').open`);
  await page.type('#label-input', 'errands'); await page.key('Enter'); await page.click('#editor-close');
  await page.waitFor(`document.querySelector('[data-view="label:errands"]')`);
  for (const [q, want] of [['#errands', ['example checklist']], ['is:list', ['example checklist']], ['markdown -checkbox', []], ['markdown', ['markdown on cards']]]) {
    await page.eval(`(() => { const s = document.getElementById('search-input'); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event('input')); })()`);
    await sleep(300); assert.deepEqual(await page.eval(noteTitles), want, `search ${q}`);
  }
});

test('images: small screenshots stay byte-for-byte, big photos are scaled, pictures survive reload', async ctx => {
  const page = await ctx.open();
  await page.chooseFiles(() => page.click('#quick-image'), [F['small.png'], F['big.png']]);
  await page.waitFor(`document.querySelectorAll('#composer-images img').length === 2`);
  await page.click('#composer-close'); await page.waitFor(allImagesRendered);
  const meta = (await page.eval(storedState)).notes.flatMap(n => n.images);
  const small = meta.find(m => m.name === 'small.png'), big = meta.find(m => m.name === 'big.webp');
  assert.equal(small.size, readFileSync(F['small.png']).length); assert.equal(small.type, 'image/png');
  assert.ok(big && Math.max(big.w, big.h) === 2400 && big.type === 'image/webp', `big photo: ${JSON.stringify(big)}`);
  await page.reload(); await page.waitFor(allImagesRendered, 'pictures after reload');
});

test('export and import: a backup restores notes, labels and pictures into an empty browser', async ctx => {
  const page = await ctx.open();
  await page.chooseFiles(() => page.click('#quick-image'), [F['small.png']]);
  await page.waitFor(`document.querySelectorAll('#composer-images img').length === 1`);
  await page.type('#composer-title', 'With picture'); await page.click('#composer-close');
  await page.waitFor(`${noteTitles}.includes('With picture')`);
  const exported = await ctx.download(() => openData(page, 'Export backup'));
  const before = await page.eval(storedState);
  const other = await newContext();
  try {
    const fresh = await other.open();
    await fresh.chooseFiles(() => openData(fresh, 'Import backup - replace'), [exported.path]);
    await fresh.confirm(true);
    await fresh.waitFor(`${noteTitles}.includes('With picture')`);
    const after = await fresh.eval(storedState);
    const pick = s => s.notes.map(n => [n.id, n.title, n.body, n.labels.join(','), n.images.map(i => i.id).join(',')]).sort();
    assert.deepEqual(pick(after), pick(before)); assert.deepEqual(after.labels, before.labels);
    await fresh.waitFor(allImagesRendered, 'imported picture renders');
  } finally { await other.close(); }
});

test('themes: light, dark, vegas and system cycle and persist across reloads', async ctx => {
  const page = await ctx.open();
  const theme = `document.documentElement.dataset.theme || 'system'`;
  assert.equal(await page.eval(theme), 'system');
  for (const want of ['light', 'dark', 'vegas']) { await page.click('#theme-button'); assert.equal(await page.eval(theme), want); }
  await page.reload(); assert.equal(await page.eval(theme), 'vegas');
  await page.click('#theme-button'); assert.equal(await page.eval(theme), 'system');
  await page.reload(); assert.equal(await page.eval(theme), 'system');
});

test('markdown and note links: checkboxes toggle, [[links]] create the target and show backlinks', async ctx => {
  const page = await ctx.open();
  await page.focus('#composer-body'); await page.type('#composer-title', 'Hub'); await page.type('#composer-body', 'see [[Linked Note]]\n- [ ] tick me');
  await page.click('#composer-close');
  const id = await page.waitFor(cardIdByTitle('Hub'));
  await page.click(`article.note[data-id="${id}"] [data-md-line]`);
  await page.waitFor(`${storedState}.notes.find(n => n.id === '${id}').body.includes('- [x] tick me')`);
  assert.ok(await page.eval(`!!document.querySelector('article.note[data-id="${id}"] .note-link.missing')`));
  await page.click(`article.note[data-id="${id}"] .note-link`);
  await page.waitFor(`document.getElementById('editor').open && document.getElementById('editor-title').value === 'Linked Note'`);
  await page.waitFor(`!document.getElementById('backlinks-row').hidden && document.getElementById('backlinks').textContent.includes('Hub')`, 'backlink to Hub');
  await page.click('#editor-close');
  await page.waitFor(`!document.querySelector('article.note[data-id="${id}"] .note-link.missing')`);
});

test('templates: new installs get the neutral starters; saved templates are untouched', async ctx => {
  const page = await ctx.open();
  assert.deepEqual((await page.eval(storedState)).templates.map(t => t.name), ['Daily plan', 'Packing list']);
  await page.click('#composer-template'); await page.clickMenu('▤ Daily plan');
  assert.match(await page.eval(`document.getElementById('composer-title').value`), /^\w+day \d{4}-\d{2}-\d{2}$/);
  const mine = [{ id: 'tpl-meeting', name: 'Meeting notes', type: 'note', title: 'Meeting', body: 'mine', items: [], color: '', labels: [] }, { id: 'tpl-x', name: 'My own', type: 'list', title: '', body: '', items: [{ text: 'a', indent: 0 }], color: '', labels: [] }];
  const other = await newContext();
  try {
    const p2 = await seedThenOpen(other, `localStorage.setItem('tack_state', ${JSON.stringify(JSON.stringify({ format: 'tack.state.v1', notes: [], labels: [], templates: mine }))});`);
    assert.deepEqual((await p2.eval(storedState)).templates, mine);
  } finally { await other.close(); }
});

test('migration: taskman_* data is copied to tack_* once and the old keys are left in place', async ctx => {
  const old = JSON.stringify({ format: 'taskman.state.v1', notes: [{ id: 'n-old', title: 'from taskman' }], labels: [] });
  const page = await seedThenOpen(ctx, `localStorage.setItem('taskman_state', ${JSON.stringify(old)}); localStorage.setItem('taskman_theme', 'dark'); localStorage.setItem('taskman_prefs', '{"layout":"list"}');`);
  await page.waitFor(`${noteTitles}.includes('from taskman')`);
  assert.equal(await page.eval(`localStorage.getItem('taskman_state')`), old);
  assert.equal(await page.eval(`document.documentElement.dataset.theme`), 'dark');
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem('tack_prefs')).layout`), 'list');
  assert.match(await page.toast(), /came over from taskman/);
});

const openCard = async (page, title) => { const id = await page.waitFor(cardIdByTitle(title)); await page.click(`article.note[data-id="${id}"] .note-title`); return id; };
test('locked notes: only ciphertext is stored, and the right password opens it after a reload', async ctx => {
  const page = await ctx.open();
  const id = await openCard(page, 'markdown on cards'); await page.waitFor(`document.getElementById('editor').open`);
  const body = await page.eval(`document.getElementById('editor-body').value`);
  await page.click('#editor-more'); await page.clickMenu('🔒 Lock');
  await page.waitFor(`document.getElementById('ask').open && document.querySelectorAll('#ask-fields input').length === 2`);
  await page.eval(`document.querySelectorAll('#ask-fields input').forEach(i => { i.value = 'correct horse'; })`); await page.click('#ask-ok');
  await page.waitFor(`!document.getElementById('lock-banner').hidden`, 'lock applied');
  await page.click('#editor-close');
  await page.waitFor(`(() => { const n = ${storedState}.notes.find(n => n.id === '${id}'); return n.lock && n.lock.ct && n.body === ''; })()`, 'ciphertext only');
  assert.ok(!(await page.eval(`localStorage.getItem('tack_state')`)).includes('checkbox lines are clickable'), 'plaintext body not stored');
  await page.reload(); await openCard(page, 'markdown on cards');
  await page.waitFor(`document.getElementById('ask').open`);
  await page.eval(`document.querySelector('#ask-fields input').value = 'wrong'`); await page.click('#ask-ok');
  await page.waitFor(`document.getElementById('ask-detail').textContent.includes('Wrong password')`);
  await page.eval(`document.querySelector('#ask-fields input').value = 'correct horse'`); await page.click('#ask-ok');
  await page.waitFor(`document.getElementById('editor').open && document.getElementById('editor-body').value === ${JSON.stringify(body)}`, 'unlocked body');
  await page.click('#editor-close');
});

test('history: an edit leaves the earlier version, which can be restored', async ctx => {
  const page = await ctx.open();
  await openCard(page, 'welcome to tack'); await page.waitFor(`document.getElementById('editor').open`);
  const original = await page.eval(`document.getElementById('editor-body').value`);
  await page.eval(`(() => { const b = document.getElementById('editor-body'); b.focus(); b.select(); })()`); await page.send('Input.insertText', { text: 'replaced text' });
  await page.click('#editor-close');
  await openCard(page, 'welcome to tack'); await page.waitFor(`document.getElementById('editor-body').value === 'replaced text'`);
  await page.click('#editor-history'); await page.waitFor(`document.querySelectorAll('#history-list [data-version]').length === 1`, 'one earlier version');
  await page.click('#history-restore');
  await page.waitFor(`document.getElementById('editor-body').value === ${JSON.stringify(original)}`, 'restored text');
  await page.click('#editor-close'); await page.reload();
  assert.equal((await page.eval(storedState)).notes.find(n => n.title === 'welcome to tack').body, original);
});

test('reminders: a past reminder shows as due, and fires when tack next starts', async ctx => {
  const page = await ctx.open();
  await openCard(page, 'example checklist'); await page.waitFor(`document.getElementById('editor').open`);
  await page.eval(`(() => { const d = new Date(Date.now() - 3600000), p = x => String(x).padStart(2, '0'); const r = document.getElementById('editor-reminder');
    r.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); r.dispatchEvent(new Event('change')); })()`);
  await page.click('#editor-close');
  await page.waitFor(`document.querySelector('[data-view="reminders"] .n').textContent === '1 due'`, 'sidebar shows it due');
  await page.reload();
  await page.waitFor(`document.getElementById('toast').textContent.includes('example checklist')`, 'reminder toast at start');
  await page.waitFor(`${storedState}.notes.find(n => n.title === 'example checklist').fired === true`);
});

test('two tabs: a note added in one shows up in the other', async ctx => {
  const a = await ctx.open(), b = await ctx.open();
  await a.focus('#composer-body'); await a.type('#composer-title', 'cross-tab'); await a.click('#composer-close');
  await a.waitFor(`${noteTitles}.includes('cross-tab')`, 'the note in the tab it was typed in');
  await b.waitFor(`${noteTitles}.includes('cross-tab')`, 'the other tab to pick it up');
});

test('mobile: 390px wide has no sideways scrolling', async ctx => {
  const page = await ctx.open(URL_APP, { width: 390, mobile: true });
  assert.equal(await page.eval('innerWidth'), 390);
  assert.ok(await page.eval('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow');
});

// ================================================================ picture text (OCR)
const VENDOR = { script: 'vendor/tesseract.js@5.1.1/tesseract.min.js', worker: 'vendor/tesseract.js@5.1.1/worker.min.js',
  core: ['vendor/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js'],
  lang: 'vendor/tesseract.js-data-eng@1.0.0/4.0.0_best_int/eng.traineddata.gz' };
async function ocrShot(page) { // a screenshot with known text, drawn once by the browser
  if (readFileSync(F['ocr.png']).length) return;
  const shot = await page.eval(`(async () => { const c = document.createElement('canvas'); c.width = 900; c.height = 160; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 160); g.fillStyle = '#000'; g.font = 'bold 64px Arial, sans-serif'; g.fillText('HELLO TACK 2026', 30, 105);
    const b = await new Promise(r => c.toBlob(r, 'image/png')); return [...new Uint8Array(await b.arrayBuffer())]; })()`);
  writeFileSync(F['ocr.png'], Buffer.from(shot));
}
async function ocrOnWithPicture(page) {
  await ocrShot(page);
  await page.click('#data-button'); await page.clickMenu('Search text in pictures'); await page.confirm(true);
  await page.chooseFiles(() => page.click('#quick-image'), [F['ocr.png']]);
  await page.waitFor(`document.querySelectorAll('#composer-images img').length === 1`); await page.click('#composer-close');
}
const ocrDone = `(${storedState}).notes.some(n => n.images.some(i => /HELLO TACK 2026/.test(i.text || '')))`;
const ocrWarning = `(() => { const a = document.getElementById('ocr-alert'); return !a.hidden && a.querySelector('[data-ocr="retry"]') && a.textContent; })()`;
const ocrBannerGone = `document.getElementById('ocr-alert').hidden`;

test('picture text (website): served at /, read from vendor/ on the same site, with no request to any other server', async ctx => {
  const page = await ctx.open(`${ORIGIN}/`); serverState.hits = []; const from = allRequests.length; // at the site root, so vendor/ resolves from /
  await ocrOnWithPicture(page);
  await page.waitFor(ocrDone, 'the picture text', 60000);
  assert.ok(await page.eval(ocrBannerGone));
  for (const p of [VENDOR.script, VENDOR.worker, VENDOR.lang]) assert.ok(serverState.hits.includes(p), `${p} was not loaded from this site`);
  assert.ok(VENDOR.core.some(p => serverState.hits.includes(p)), 'engine not loaded from this site');
  const elsewhere = allRequests.slice(from).filter(u => !u.startsWith(ORIGIN) && !/^(data|blob):/.test(u));
  assert.deepEqual(elsewhere, [], 'requests outside this site');
}, { http: true });

test('picture text (website): a missing reader file shows a warning with Retry; Retry works once the file is back', async ctx => {
  serverState.faults[VENDOR.script] = 404;
  const page = await ctx.open();
  await ocrOnWithPicture(page);
  assert.match(await page.waitFor(ocrWarning, 'warning'), /couldn't be loaded from this website/);
  await page.click('#data-button'); await page.waitFor(`[...document.querySelectorAll('#menu .menu-item')].some(b => b.textContent === 'Retry picture-text search')`, 'Retry in the Data menu');
  await page.key('Escape');
  delete serverState.faults[VENDOR.script];
  await page.click('[data-ocr="retry"]');
  await page.waitFor(ocrDone, 'the picture text after Retry', 60000);
  await page.waitFor(ocrBannerGone, 'warning to clear');
}, { http: true });

test('picture text (website): a reader file that fails its integrity check is refused with a warning', async ctx => {
  serverState.faults[VENDOR.script] = 'tamper';
  const page = await ctx.open();
  await ocrOnWithPicture(page);
  assert.match(await page.waitFor(ocrWarning, 'warning'), /no longer matches its fixed fingerprint/);
  assert.equal(await page.eval(`typeof window.Tesseract`), 'undefined', 'the tampered script must not have run');
}, { http: true });

test('picture text (website): missing worker, engine or language files, and a worker that never answers, all end in a warning in bounded time', async ctx => {
  serverState.transform = shortTimeouts; // 4-second limits instead of 90 and 60
  serverState.faults[VENDOR.worker] = 404;
  const page = await ctx.open();
  let t0 = Date.now(); await ocrOnWithPicture(page);
  const steps = [['worker missing', () => { serverState.faults = { [VENDOR.worker]: 404 }; }], ['engine missing', () => { serverState.faults = Object.fromEntries(VENDOR.core.map(p => [p, 404])); }],
    ['language data missing', () => { serverState.faults = { [VENDOR.lang]: 404 }; }], ['worker never answers', () => { serverState.faults = { [VENDOR.worker]: 'stub' }; }]];
  for (const [i, [what, fault]] of steps.entries()) {
    // A failure can come back within milliseconds, so look for a fresh warning (new Retry button) rather than a gap.
    if (i) { fault(); t0 = Date.now(); await page.eval(`window.__oldRetry = document.querySelector('[data-ocr="retry"]')`); await page.click('[data-ocr="retry"]'); }
    const text = await page.waitFor(`document.querySelector('[data-ocr="retry"]') !== window.__oldRetry && (${ocrWarning})`, `warning (${what})`, 15000);
    assert.ok(Date.now() - t0 < 4000 + 6000, `${what}: took ${Date.now() - t0} ms`);
    assert.match(text, /Picture-text search stopped/, what);
    assert.ok(!(await page.eval(ocrDone)), `${what}: text must not appear`);
  }
  serverState.faults = {}; await page.click('[data-ocr="retry"]');
  await page.waitFor(ocrDone, 'the picture text once every file is back', 60000);
}, { http: true });

test('picture text (as a file): with cdn.jsdelivr.net blocked, the warning explains why instead of loading forever', async ctx => {
  const page = await ctx.open(pathToFileURL(APP_FILE).href);
  await page.send('Network.setBlockedURLs', { urls: ['*cdn.jsdelivr.net*'] });
  await ocrOnWithPicture(page);
  assert.match(await page.waitFor(ocrWarning, 'warning', 15000), /couldn't be downloaded from cdn\.jsdelivr\.net/);
});

test('picture text (as a file): reads a screenshot with the pinned CDN files, integrity-checked', async ctx => {
  const page = await ctx.open(pathToFileURL(APP_FILE).href);
  await ocrOnWithPicture(page);
  await page.waitFor(ocrDone, 'the picture text', 120000);
}, { network: true });

// ================================================================ release consistency (static)
test('release: one app source, version 1.0.0 everywhere, production headers defined once, internal/ never referenced', async () => {
  const html = readFileSync(APP_FILE, 'utf8'), version = (html.match(/const VERSION = '([^']+)'/) || [])[1];
  assert.equal(version, '1.0.0');
  assert.equal((readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').match(/^## (\S+)/m) || [])[1], version, 'CHANGELOG top entry');
  assert.match(readFileSync(join(ROOT, `docs/RELEASE-NOTES-v${version}.md`), 'utf8'), new RegExp(`^# Tack ${version.replace(/\./g, '\\.')}\\n`));
  const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  assert.deepEqual(vercel.rewrites, [{ source: '/', destination: '/tack.html' }], 'the site root serves tack.html itself, no copy');
  assert.equal(vercel.buildCommand, 'node tools/package.mjs'); assert.equal(vercel.outputDirectory, 'dist', 'the site serves only the built package');
  const htmlFiles = readdirSync(ROOT, { recursive: true }).map(f => String(f).replace(/\\/g, '/')).filter(f => /\.html?$/i.test(f) && !/^(internal|dist|\.git|node_modules)\//.test(f));
  assert.deepEqual(htmlFiles, ['tack.html'], 'exactly one HTML source file: the app (dist/ holds a build copy)');
  const docCsp = [...readFileSync(join(ROOT, 'docs/DEPLOYMENT.md'), 'utf8').matchAll(/default-src 'none';[^"\n`]+/g)].map(m => m[0].trim());
  assert.ok(docCsp.length >= 1); docCsp.forEach(c => assert.equal(c, PROD_HEADERS['content-security-policy'], 'docs/DEPLOYMENT.md quotes a different policy than vercel.json'));
  for (const f of ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'docs/TESTING.md', 'docs/DEPLOYMENT.md', `docs/RELEASE-NOTES-v${version}.md`, 'vendor/README.md', '.gitignore', '.vercelignore', 'tack.html', 'tools/package.mjs'])
    assert.ok(!/internal\//.test(readFileSync(join(ROOT, f), 'utf8')), `${f} mentions internal/`);
});

test('license: GPL-3.0-or-later, the official text, named in the app and the README', async () => {
  assert.equal(createHash('sha256').update(readFileSync(join(ROOT, 'LICENSE'))).digest('hex'), '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986', 'LICENSE is not the gnu.org gpl-3.0.txt');
  assert.match(readFileSync(APP_FILE, 'utf8'), /SPDX-License-Identifier: GPL-3\.0-or-later/);
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /GPL-3\.0-or-later/);
});

test('package: dist/ holds exactly the app and its reader, uploads are an allowlist, and nothing private is served', async () => {
  const files = PACKAGE ? pkg.listOut() : pkg.build();
  assert.deepEqual(files, pkg.PUBLIC_FILES.map(([, dest]) => dest).sort(), 'dist/ contents');
  assert.equal(files.length, 13);
  assert.ok(readFileSync(join(pkg.OUT, 'tack.html')).equals(readFileSync(join(ROOT, 'tack.html'))), 'dist/tack.html differs from tack.html');
  // What a deployment would upload: .vercelignore ignores everything at the top level except the names it allows.
  const rules = readFileSync(join(ROOT, '.vercelignore'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  assert.equal(rules[0], '/*', 'the upload list must start by ignoring everything');
  const allowed = new Set(rules.slice(1).map(r => { assert.match(r, /^![^/*]+$/, `unexpected rule ${r}`); return r.slice(1); }));
  const uploaded = readdirSync(ROOT).filter(n => allowed.has(n)).sort();
  assert.deepEqual(uploaded, ['LICENSE', 'tack.html', 'tools', 'vendor', 'vercel.json'], 'everything else in this folder stays out of an upload');
  if (!PACKAGE) return;
  // Served from the package: every public path answers with the production headers, and every other file in this
  // folder, whatever it is, is a 404 (found by listing the folder, so nothing private needs naming here).
  const get = p => fetch(`${ORIGIN}/${p.split('/').map(encodeURIComponent).join('/')}`).then(async r => ({ status: r.status, csp: r.headers.get('content-security-policy'), nosniff: r.headers.get('x-content-type-options') }));
  for (const p of ['', ...files]) { const r = await get(p); assert.equal(r.status, 200, `/${p}`); assert.equal(r.csp, PROD_HEADERS['content-security-policy'], `/${p} without the policy`); assert.equal(r.nosniff, 'nosniff'); }
  const everything = readdirSync(ROOT, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => join(e.parentPath ?? e.path, e.name).slice(ROOT.length + 1).replace(/\\/g, '/')).filter(p => !/^(dist|\.git|node_modules)\//.test(p));
  const unpublished = everything.filter(p => !files.includes(p));
  assert.ok(unpublished.length > 20, `only ${unpublished.length} unpublished files found`);
  for (const p of [...unpublished, 'dist/tack.html']) assert.equal((await get(p)).status, 404, `/${p} is served`);
}, { http: true });

// ================================================================ files on disk (autosave file, Open file, backup folder)
// The browser's pickers can't be driven headless, so they are swapped for ones that hand back handles from the page's
// private origin storage (OPFS). Everything after the picker is tack's own code: writing, permissions, saving the handle,
// restoring it after a reload, pruning old backups.
const FAKE_PICKERS = `(() => {
  const root = () => navigator.storage.getDirectory();
  window.showSaveFilePicker = async (o = {}) => (await root()).getFileHandle(o.suggestedName || 'tack.json', { create: true });
  window.showOpenFilePicker = async () => [await (await root()).getFileHandle(localStorage.getItem('__openName') || 'tack.json')];
  window.showDirectoryPicker = async () => (await root()).getDirectoryHandle('backups', { create: true });
})()`;
const opfsRead = name => `navigator.storage.getDirectory().then(r => r.getFileHandle(${JSON.stringify(name)})).then(h => h.getFile()).then(f => f.text()).catch(() => null)`;
const opfsWrite = (name, text, dir) => `(async () => { let d = await navigator.storage.getDirectory(); ${dir ? `d = await d.getDirectoryHandle(${JSON.stringify(dir)}, { create: true });` : ''} const w = await (await d.getFileHandle(${JSON.stringify(name)}, { create: true })).createWritable(); await w.write(${JSON.stringify(text)}); await w.close(); })()`;
const opfsList = dir => `(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(dir)}, { create: true }); const out = []; for await (const [n] of d.entries()) out.push(n); return out.sort(); })()`;
async function openWithPickers(ctx) { const page = await ctx.open('about:blank'); await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_PICKERS }); await page.goto(URL_APP); return page; }

test('files: the autosave file is written, follows edits, is reconnected after a reload, and is never overwritten from recovery', async ctx => {
  const page = await openWithPickers(ctx);
  await openData(page, 'Save to file');
  await page.waitFor(`${opfsRead('tack.json')}.then(t => t && JSON.parse(t).format === 'tack.bundle.v1' && t.includes('welcome to tack'))`, 'the autosave file');
  await page.focus('#composer-body'); await page.type('#composer-title', 'autosaved note'); await page.click('#composer-close');
  await page.waitFor(`${opfsRead('tack.json')}.then(t => t && t.includes('autosaved note'))`, 'the edit in the file', 6000);
  await page.reload();
  await page.waitFor(`document.getElementById('save-indicator').title === 'Saved locally · autosaving to tack.json'`, 'the file reconnected after a reload');
  // Make the browser's copy unreadable, then work in recovery: the file must keep its last good contents.
  const good = await page.eval(opfsRead('tack.json'));
  await page.eval(`localStorage.setItem('tack_state', ${JSON.stringify(BROKEN)})`); await page.reload();
  await sleep(1000);
  // The first change after start-up is where an older version wrote its welcome notes over the file.
  await page.focus('#composer-body'); await page.type('#composer-title', 'typed in recovery'); await page.click('#composer-close');
  await sleep(2500); // longer than the 1.5 s autosave delay
  assert.equal(await page.eval(opfsRead('tack.json')), good, 'the autosave file was overwritten from an unreadable start');
  await page.waitFor(`!document.getElementById('storage-alert').hidden`, 'recovery');
  await page.click('#data-button'); await page.clickMenu('Autosaving to tack.json');
  await page.waitFor(`document.getElementById('toast').textContent.startsWith('Not writing tack.json')`, 'refusal to write');
  await sleep(2500);
  assert.equal(await page.eval(opfsRead('tack.json')), good, 'the autosave file was overwritten from recovery');
}, { http: true });

test('files: Open file loads a backup and keeps it in sync; the backup folder gets full copies and prunes only its own old ones', async ctx => {
  const page = await openWithPickers(ctx);
  await page.eval(opfsWrite('other.json', readFileSync(F['new-notes-bundle.json'], 'utf8'))); await page.eval(`localStorage.setItem('__openName', 'other.json')`);
  await openData(page, 'Open file'); await page.confirm(true);
  await page.waitFor(`JSON.stringify(${noteTitles}) === '["Brand new one"]'`, 'the opened file to replace the notes');
  await page.focus('#composer-body'); await page.type('#composer-title', 'kept in sync'); await page.click('#composer-close');
  await page.waitFor(`${opfsRead('other.json')}.then(t => t && t.includes('kept in sync'))`, 'the opened file to follow edits', 6000);
  // Folder: a file of the person's own must survive pruning, whatever its name looks like.
  await page.eval(opfsWrite('my-notes.txt', 'mine', 'backups')); await page.eval(opfsWrite('tack-backup-mine.txt', 'mine too', 'backups'));
  await openData(page, 'Backups');
  await page.eval(`(() => { const k = document.getElementById('backup-keep'); k.value = '5'; k.dispatchEvent(new Event('change')); })()`);
  await page.click('#backup-folder-button');
  await page.waitFor(`${opfsList('backups')}.then(l => l.filter(n => /^tack-backup-.+\\.json$/.test(n)).length === 1)`, 'the first folder backup');
  for (let i = 0; i < 6; i++) { await sleep(1100); await page.click('#backup-now'); } // file names have one-second resolution
  await page.waitFor(`${opfsList('backups')}.then(l => l.filter(n => /^tack-backup-.+\\.json$/.test(n)).length === 5)`, 'pruning to the 5 kept', 8000);
  const names = await page.eval(opfsList('backups'));
  assert.ok(names.includes('my-notes.txt') && names.includes('tack-backup-mine.txt'), `own files deleted: ${names}`);
  const newest = names.filter(n => n.endsWith('.json')).pop();
  const copy = JSON.parse(await page.eval(`navigator.storage.getDirectory().then(r => r.getDirectoryHandle('backups')).then(d => d.getFileHandle(${JSON.stringify(newest)})).then(h => h.getFile()).then(f => f.text())`));
  assert.equal(copy.format, 'tack.bundle.v1'); assert.ok(copy.notes.some(n => n.title === 'kept in sync'), 'the folder copy holds the current notes');
}, { http: true });

test('print: printing a note with a picture builds the page under the production policy', async ctx => {
  const page = await ctx.open('about:blank');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.print = () => { window.__printed = [...document.querySelectorAll('#print-area img')].map(i => i.complete && i.naturalWidth); };` });
  await page.goto(URL_APP);
  await page.chooseFiles(() => page.click('#quick-image'), [F['small.png']]);
  await page.waitFor(`document.querySelectorAll('#composer-images img').length === 1`); await page.type('#composer-title', 'print me'); await page.click('#composer-close');
  const id = await page.waitFor(cardIdByTitle('print me'));
  await page.click(`article.note[data-id="${id}"] [data-act="more"]`); await page.clickMenu('Print');
  const printed = await page.waitFor(`window.__printed`, 'print to be called');
  assert.deepEqual(printed, [64], 'the picture in the print page decoded at full width');
  assert.match(await page.eval(`document.getElementById('print-area').textContent`), /print me/);
});

class Skip extends Error {}
test('pop-out: a checklist opens in the always-on-top window, and ticking an item there updates the note', async ctx => {
  const page = await ctx.open();
  const id = await page.waitFor(cardIdByTitle('example checklist'));
  await page.click(`article.note[data-id="${id}"] [data-act="more"]`); await page.clickMenu('Pop out');
  const opened = await page.waitFor(`(window.documentPictureInPicture?.window && 'open') || (document.getElementById('toast').textContent.includes('would not open') && 'refused')`, 'the pop-out window or a refusal');
  if (opened === 'refused') throw new Skip('this browser build refused to open a Document Picture-in-Picture window');
  await page.waitFor(`documentPictureInPicture.window.document.body.textContent.includes('example checklist')`, 'the note in the pop-out');
  await page.eval(`documentPictureInPicture.window.document.querySelector('[data-pip-check]').click()`, true);
  await page.waitFor(`${storedState}.notes.find(n => n.id === '${id}').items.filter(i => i.done).length === 2`, 'the ticked item saved');
  await page.eval(`documentPictureInPicture.window.close()`);
});

// ================================================================ README screenshots (only with --screenshots)
// Real captures of the app, with neutral demo notes imported through Data > Import backup, written to screenshots/.
const dayOffset = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function demoBundle() {
  const sunset = png(480, 300, (x, y) => y < 190 ? [250 - y * 0.4, 140 + y * 0.3, 90 + y * 0.5, 255] : [40 + (x % 60 < 30 ? 10 : 0), 70, 110 - (y - 190) * 0.3, 255]);
  const item = (text, extra = {}) => ({ text, ...extra });
  const n = (id, order, extra) => ({ id, order, created: Date.now() - (10 - order) * 3600000, updated: Date.now() - order * 600000, ...extra });
  return {
    format: 'tack.bundle.v1', version: '1.0', labels: ['home', 'ideas', 'travel'], templates: [],
    notes: [
      n('n-demo-1', 0, { type: 'list', title: 'Weekend', pinned: true, color: 'green', labels: ['home'], items: [item('Farmers market', { due: dayOffset(1) }), item('Return library books', { due: dayOffset(0) }), item('Fix the bike light'), item('Call grandma', { done: true })] }),
      n('n-demo-2', 1, { title: 'Trip to the coast', pinned: true, color: 'blue', labels: ['travel'], reminder: `${dayOffset(1)}T09:00`, body: 'Leaving **Friday morning**, back Sunday.\n\n- [ ] Book the cabin\n- [x] Ask Sam to water the plants\n- [ ] Check the tide times\n\nPacking: [[Packing list]]' }),
      n('n-demo-3', 2, { type: 'list', title: 'Packing list', labels: ['travel'], items: [item('Rain jacket'), item('Sunscreen', { done: true }), item('Phone charger'), item('Snacks for the drive', { due: dayOffset(2) }), item('Camera', { done: true })] }),
      n('n-demo-4', 3, { title: 'Sunset at the pier', labels: ['travel'], body: 'Worth the walk at 7:40.', images: [{ id: 'img-demo-sunset', name: 'sunset.png', type: 'image/png', w: 480, h: 300, size: sunset.length }] }),
      n('n-demo-5', 4, { title: 'Book ideas', color: 'yellow', labels: ['ideas'], body: '- A mystery set in a lighthouse\n- Two neighbors, one shared garden\n- *Maybe:* letters found in a library book' }),
      n('n-demo-6', 5, { title: 'Banana bread', color: 'orange', labels: ['home'], body: '**3 ripe bananas**, 1/3 cup butter, 3/4 cup sugar, 1 egg, 1 tsp baking soda, 1 1/2 cups flour\n\n```text\n350°F / 175°C for about 60 minutes\n```' }),
      n('n-demo-7', 6, { type: 'list', title: 'Garden', color: 'teal', labels: ['home'], items: [item('Plant tomatoes', { due: dayOffset(3) }), item('Order mulch'), item('Fix the gate latch', { indent: 1 })] })
    ],
    images: { 'img-demo-sunset': dataUrl('image/png', sunset) }
  };
}
test('screenshots: capture the README images from the real app', async ctx => {
  const bundle = fixture('demo-bundle.json', JSON.stringify(demoBundle()));
  const page = await seedThenOpen(ctx, `localStorage.setItem('tack_prefs', JSON.stringify({ lastOffsiteAt: Date.now(), nudgedAt: Date.now(), lastBackupCheck: Date.now() }));`);
  await page.chooseFiles(() => openData(page, 'Import backup - replace'), [bundle]); await page.confirm(true);
  await page.waitFor(`${noteTitles}.includes('Garden')`);
  const out = join(ROOT, 'screenshots'); mkdirSync(out, { recursive: true });
  const settle = async () => {
    await page.waitFor(`!document.getElementById('toast').classList.contains('visible')`, 'toast to fade', 12000);
    await page.waitFor(`[...document.querySelectorAll('img[data-img]')].every(i => i.complete && i.naturalWidth > 0)`, 'pictures'); await sleep(400);
  };
  const shoot = async (name, width, height, mobile = false) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile }); await sleep(300); await settle();
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name), Buffer.from(data, 'base64'));
    console.log(`      wrote screenshots/${name} (${width}x${height} at 2x)`);
  };
  const theme = async t => { while ((await page.eval(`document.documentElement.dataset.theme || 'system'`)) !== t) await page.click('#theme-button'); };
  await theme('light'); await shoot('tack-notes-light.png', 1280, 860);
  await theme('dark'); await page.click(`article.note[data-id="n-demo-2"] .note-title`); await page.waitFor(`document.getElementById('editor').open`);
  await shoot('tack-editor-dark.png', 1280, 860); await page.click('#editor-close');
  await page.click('[data-view="tasks"]'); await page.click('[data-tasks-mode="date"]'); await shoot('tack-tasks-dark.png', 1280, 860);
  await page.click('[data-view="notes"]'); await theme('vegas'); await shoot('tack-notes-vegas.png', 1280, 860);
  await theme('light'); await shoot('tack-mobile-light.png', 390, 844, true);
}, { screenshots: true, http: true });

// ---------------------------------------------------------------- run
let passed = 0, failed = 0, skipped = 0;
const selected = tests.filter(t => !args.only || t.name.includes(args.only));
console.log(`tack tests · ${BROWSER_VERSION} · ${URL_APP}`);
for (const t of selected) {
  if (t.opt.network && !args.ocr) { skipped++; console.log(`skip  ${t.name} (needs --ocr)`); continue; }
  if (t.opt.screenshots && !args.screenshots) { skipped++; console.log(`skip  ${t.name} (needs --screenshots)`); continue; }
  if (t.opt.http && FILE_MODE) { skipped++; console.log(`skip  ${t.name} (needs tack served over http)`); continue; }
  const ctx = await newContext(), t0 = Date.now();
  try {
    await t.fn(ctx);
    const errors = ctx.pages.flatMap(p => p.errors);
    assert.deepEqual(errors, [], 'uncaught page errors');
    passed++; console.log(`ok    ${t.name} (${Date.now() - t0} ms)`);
  } catch (e) {
    if (e instanceof Skip) { skipped++; console.log(`skip  ${t.name} (${e.message})`); continue; }
    failed++; console.log(`FAIL  ${t.name}\n      ${String(e.stack || e).split('\n').filter(l => !/^\s+at /.test(l)).slice(0, 30).join('\n      ')}`);
  }
  finally { serverState.faults = {}; serverState.transform = null; await ctx.close(); }
}
// Pages and workers alike. Only the opt-in --ocr test may reach the pinned CDN files; requests a test blocked on purpose never left.
const external = [...new Set(allRequests.filter(u => !u.startsWith(ORIGIN) && !/^(data|blob|about|file):/.test(u) && !blockedByTests.has(u)))];
const allowed = args.ocr ? external.filter(u => !u.startsWith('https://cdn.jsdelivr.net/npm/tesseract.js') && !u.startsWith('https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/')) : external;
if (allowed.length) { failed++; console.log(`FAIL  network: pages contacted ${allowed.join(', ')}`); }
else { passed++; console.log(`ok    network: ${allRequests.length} requests, none outside ${FILE_MODE ? 'local files' : ORIGIN}${args.ocr ? ' except the pinned OCR files' : ''}${blockedByTests.size ? ` (${blockedByTests.size} blocked on purpose by a test)` : ''}`); }
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);

// ---------------------------------------------------------------- cleanup
await cdp.send('Browser.close').catch(() => {});
await new Promise(r => { if (browserProc.exitCode !== null) return r(); browserProc.once('exit', r); setTimeout(r, 5000); });
if (process.platform === 'win32') { // Chrome's helpers can outlive the main process; stop only ours (matched by our temp profile)
  try { execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${PROFILE.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' }); } catch { /* best effort */ }
}
server.close();
for (let i = 0; i < 10; i++) { try { rmSync(TMP, { recursive: true, force: true }); break; } catch { await sleep(300); } }
process.exit(failed ? 1 : 0);
