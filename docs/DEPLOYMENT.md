# Deploying Tack

Tack is static files. The production site is **https://tack.radmagelabs.com/**, a separate Vercel project with its own origin. Three files in this folder define the deployment, and they are the only place it is defined:

| File | Role |
|---|---|
| `vercel.json` | Runs the package build, serves only `dist/`, rewrites `/` to `tack.html`, and sets the security headers on every response |
| `.vercelignore` | An upload allowlist: a deployment uploads only `tack.html`, `LICENSE`, `vendor/`, `tools/` and `vercel.json` |
| `tools/package.mjs` | Builds `dist/` from a fixed list of 13 files, after checking every vendored file against its recorded SHA-256 and the page's SRI hash against the vendored script |

## 1. What the site serves

`node tools/package.mjs` produces:

```
dist/tack.html                                         the app (a byte copy of tack.html)
dist/LICENSE.txt                                       the GPL text
dist/vendor/tesseract.js@5.1.1/...                     the reader's loader and worker, with their license files
dist/vendor/tesseract.js-core@5.1.1/...                the engine (with and without SIMD) and its license
dist/vendor/tesseract.js-data-eng@1.0.0/...            the English data and its license
```

Two layers keep everything else off the site. Documentation, tests, screenshots, development notes, and anything added to the folder later are never uploaded (`.vercelignore` starts with `/*` and allows only five names). Even an uploaded file isn't served unless the package build copies it into `dist/`, the output directory. `node tests/run.mjs --package` builds the package, serves only `dist/` as the host would, and checks that every public file answers with the production headers and that private paths (development notes, tests, docs, the README, `vercel.json`, the build script) return 404.

There is exactly one app source, `tack.html`. The site root is a rewrite to it, not a copy, so `/` and `/tack.html` are the same page on the same origin, with the same stored notes.

## 2. Why a separate origin

Browsers keep localStorage and IndexedDB per **origin** (scheme, host and port). Every page on an origin can read everything stored there, and they all share one storage quota (about 5 MB of localStorage, and Tack keeps all its note text in one key). So Tack gets its own subdomain instead of a path on a site with other apps. Another site that lists Tack should **redirect** to it, never proxy it.

A subdomain still shares two things with its parent domain:
- **Chrome's per-site data deletion** (Settings > Privacy > Site data) groups subdomains with the parent, so deleting the parent's data there also deletes Tack's notes. Clearing data while on Tack's own address affects only Tack.
- **Cookies** set for the parent domain reach the subdomain. Tack uses no cookies.

## 3. Response headers

Defined once, in `vercel.json`, for every path:

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' data: blob:; img-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

The tests read the policy from `vercel.json` and check that the copy above is identical. `node tests/run.mjs --package`, `node tests/run.mjs --csp` and `node tests/firefox-smoke.mjs --package` all run under these headers. Covered that way: every feature in the suite, including picture-text search, printing a note with a picture, and the pop-out window. Why each part is needed:

- `script-src 'self'` loads the reader from `vendor/`; `'unsafe-inline'` runs Tack's two inline scripts; `'wasm-unsafe-eval'` lets the reader's WebAssembly run (verified: picture-text search fails without it).
- `worker-src 'self'` starts the reader's worker from `vendor/`.
- `connect-src 'self' data: blob:` lets the worker fetch its language data and its embedded WebAssembly (a `data:` URL), and lets the page read its own picture URLs.
- `img-src blob: data:` covers pictures, which are stored as blobs, plus the favicon and printing, which use `data:`.
- `style-src 'unsafe-inline'` covers the inline stylesheet and style attributes (verified: the suite fails on style violations without it).
- Everything else is off: no other servers, frames, plugins, form posts or base-URL changes, and the page can't be embedded elsewhere.

## 4. Deploying (when approved)

1. `node tests/run.mjs --package`, then `node tests/run.mjs` and `node tests/firefox-smoke.mjs --package`: all green.
2. Deploy this folder to the Vercel project. `.vercelignore` limits the upload, and Vercel runs `node tools/package.mjs` (it needs Node 22 or newer, which the project uses) and serves `dist/`. A build that finds a changed vendored file fails, and nothing is deployed.
3. DNS: one `CNAME tack cname.vercel-dns.com` record. Keep the record and the project alive together; a `CNAME` left pointing at a deleted project can be claimed by someone else.

## 5. Moving existing notes

Notes don't follow the app to a new address. Anyone who used Tack from a file or another address should use **Data > Export backup** there, then **Data > Import backup - replace** at the new address. The first visit shows only the welcome notes.

## 6. After deploying

1. `curl -sI https://tack.radmagelabs.com/` shows the section 3 headers, and so does a file under `/vendor/`.
2. `curl -s -o /dev/null -w '%{http_code}' https://tack.radmagelabs.com/README.md` (and the same for `/tests/run.mjs` and `/vercel.json`) returns 404.
3. Add a note there. In a tab on the parent site, `localStorage.getItem('tack_state')` in the console must return `null`.
4. Turn on picture-text search with one screenshot. Its text should be found, and DevTools' Network panel (with workers included) should show only requests to Tack's own address.
