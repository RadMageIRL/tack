# Testing Tack

```
node tests/run.mjs              # the full suite in Chrome (or Edge)
node tests/firefox-smoke.mjs    # the essentials in Firefox
```

Node 22.2 or newer and an installed Chrome or Edge (and Firefox for the smoke test). No npm packages, no build step.

`tests/run.mjs` starts a throwaway headless browser with its own temporary profile and serves `tack.html` and `vendor/` from a local server on a random port (`http://127.0.0.1:<port>`). **Every test gets a fresh browser context**, so localStorage and IndexedDB start empty and nothing touches a real browser profile or real notes. Test files (pictures, emails, backups) are generated into a temporary folder. When the run ends, the runner closes the browser, stops any leftover processes of its own and deletes that folder.

| Option | Effect |
|---|---|
| `--file` | Open `tack.html` as a file (`file://`), like a downloaded copy. Tests that need a server are skipped and reported. |
| `--package` | Build the website package (`tools/package.mjs`) and serve only `dist/`, with the production headers and `/` rewrite from `vercel.json`: the site as it would be deployed |
| `--csp` | Serve the source folder with the production headers from `vercel.json`. Any policy violation fails the test it happens in. `TACK_CSP=<policy>` tries another policy. |
| `--browser=edge` | Use Microsoft Edge. `CHROME_PATH=<exe>` picks any Chromium build. |
| `--only=<text>` | Run only tests whose name contains the text |
| `--ocr` | Also run picture-text search as a file against the real cdn.jsdelivr.net, the only test that uses the internet |
| `--app=<file>` | Test another copy of the page, for example an older version, to show a regression test fails on it |
| `--screenshots` | Recapture the README images into `screenshots/` from the real app with neutral demo notes |

Both scripts end with a network check over every request pages (and, in Chrome, workers) made: nothing may leave the local server or local files. Requests a test blocks on purpose are counted separately, and only `--ocr` may reach the pinned CDN files.

`tests/firefox-smoke.mjs` drives Firefox with a throwaway profile over WebDriver BiDi, Firefox's built-in automation protocol. It accepts `--file` and `--package` like the main runner (`FIREFOX_PATH=<exe>` picks a build). It checks:
- loading with no errors and persistence across a reload;
- the Markdown inputs that used to break, and that note links open notes;
- an SVG in an imported backup becoming a PNG;
- a locked note storing only ciphertext and opening after a reload;
- Export backup, then Import backup - replace, into an empty browser;
- themes;
- picture-text search from `vendor/`.

## What `tests/run.mjs` covers

**Security**
- A positive control proves the probe can see script run from a raw SVG blob, both over http and as a file.
- SVG pictures from the file picker, an imported backup (including a `+xml` type carrying XHTML script), an email (including a PNG with HTML appended, labeled `text/html`) and a Google Keep import are all stored and shown as bitmaps. Each shown picture is then opened directly, in its own tab and in an iframe, and no script may run.
- An SVG stored by an earlier version is shown as a PNG made in memory, and the stored original is not rewritten. The IndexedDB upgrade from version 3 to 4 keeps the data.
- The Markdown renderer gets 40,000 generated inputs plus the inputs that broke before. Every run checks for event handlers, unexpected elements, non-http(s)/mailto links, links that would open in Tack's own tab, note links inside external links, note links whose target differs from their text, and stray attributes. Both detectors are checked first against known-bad samples.
- Clicking the `[[note links]]` that used to break opens the right note, with no new tab and no navigation.
- The source makes no "zero dependencies" or "no network" claims, contains none of the old starter examples and no em dashes, and pins the reader. Every `vendor/` path the page names exists, every vendored file matches the hash in `vendor/README.md`, and the page's SRI hash matches the vendored script.

**Release and package**
- One app source (`tack.html`) and version 1.0.0 in the app, the CHANGELOG and the release notes.
- `vercel.json` builds the package, serves only `dist/` and rewrites `/` to `tack.html`, and the policy quoted in `docs/DEPLOYMENT.md` matches `vercel.json` exactly.
- `LICENSE` is the official GPL version 3 text, and the app and README name GPL-3.0-or-later.
- `dist/` holds exactly the 13 listed files, with byte-identical copies. The upload allowlist admits only `tack.html`, `LICENSE`, `vendor/`, `tools/` and `vercel.json`. With `--package`, every public path answers with the production headers, and development notes, tests, docs, the README and other project files return 404.

**Picture-text search**
- Served from the site root: the reader loads from `vendor/` on the same site, reads a screenshot, and no page or worker contacts another server.
- A missing reader script shows a warning with Retry, and Retry works once the file is back. The Data menu also offers Retry.
- A changed reader script fails its integrity check and never runs.
- A missing worker, a missing engine, missing language data and a worker that never answers each end in a warning within the time limit (shortened to 4 seconds for the test by rewriting the served page). Retry then succeeds once the files are back.
- Opened as a file with cdn.jsdelivr.net blocked, the warning explains the download problem.
- With `--ocr`, opened as a file, the pinned CDN files load, pass the integrity check and read the screenshot.

**Reliability**
- An unreadable save stays byte-for-byte. Nothing is written over it, it is kept once in IndexedDB (not once per reload), it downloads intact, and its pictures survive cleanup. Starting fresh then works and keeps the copy.
- A readable save written by another tab ends recovery.
- With localStorage full, the warning and the save dot stay up past any toast, nothing claims to be saved, and freeing space plus Retry clears them.
- A merge that overwrites notes takes a safety snapshot first, and restoring that snapshot brings the overwritten edit back. A merge that only adds notes takes none.

**Files on disk.** The browser's pickers can't be driven headless, so they are replaced by ones that hand back handles from the page's private origin storage. Everything after the picker is Tack's own code.
- Save to file writes a full backup, follows edits, and is reconnected after a reload. Starting from an unreadable save, it is never written over, not even by "write now".
- Open file loads a backup and keeps that file in sync.
- The backup folder gets full copies with each snapshot and keeps only the chosen number of its `tack-backup-*.json` files. It leaves every other file alone, including similarly named ones such as `tack-backup-mine.txt`.

**Functional**: notes (create, edit, trash, restore, delete forever, reload), checklists and the Tasks view (natural due dates, check-off), search operators and labels, images (small pictures kept byte-for-byte, large ones scaled, reload), export and import into an empty browser, themes (cycle and persistence), Markdown checkboxes and `[[note links]]` with backlinks, templates (new starters, saved ones untouched), `taskman_*` migration, locked notes (ciphertext only, wrong and right password after a reload), history (restore an earlier version), reminders (shown as due, firing at start), printing a note with its picture, the pop-out window (ticking an item there updates the note), two tabs syncing, and a 390 px phone viewport.

## Results (2026-10-24)

| Run | Result |
|---|---|
| `node tests/run.mjs` (Chrome 155) | 40 passed, 0 failed, 2 skipped (`--ocr`, `--screenshots`) |
| `--browser=edge` (Edge 155) | 40 passed, 0 failed, 2 skipped |
| `--csp` (Chrome 155) | 40 passed, 0 failed, 2 skipped |
| `--package` (Chrome 155) and `--package --browser=edge` | 40 passed, 0 failed, 2 skipped |
| `--file` (Chrome 155) and `--file --browser=edge` | 33 passed, 0 failed, 9 skipped (tests that need a server, plus `--ocr` and `--screenshots`) |
| `--ocr` (Chrome 155, real cdn.jsdelivr.net) | 41 passed, 0 failed, 1 skipped (`--screenshots`) |
| `node tests/firefox-smoke.mjs` (Firefox 148) and `--package` | 9 passed, 0 failed |
| `node tests/firefox-smoke.mjs --file` | 8 passed, 0 failed, 1 skipped (picture-text search needs a server) |

The counts include the closing network checks.

## How the tests were validated

- Run against earlier versions with `--app=`, every regression test **fails**:
  - **Phase A file:** the picture, unreadable-save, storage-full, merge-snapshot, template, claims and autosave-file tests fail, each at the harm itself ("original untouched at boot", "one safety snapshot before the merge", "the autosave file was overwritten from an unreadable start", a shown picture of type `image/svg+xml").
  - **Phase B file:** the Markdown, navigation, examples and every picture-text test fail, and so does the network check (that version contacted cdn.jsdelivr.net over http).
  - The functional tests pass on every version.
- A copy with one character of the SRI hash changed fails the `--ocr` test.
- `--csp` with `style-src` lacking `'unsafe-inline'` produces CSP failures. Without `'wasm-unsafe-eval'`, picture-text search doesn't work.

## Not covered (check these by hand before a release)

- **Safari/WebKit**: not available on the test machine.
- **Firefox beyond the smoke test**: the full suite runs in Chromium only.
- The browsers' own file and folder pickers and permission prompts (the code behind them is tested, as above), desktop notifications, and clipboard copy.
- Drag and drop (cards, tasks, checklist items), touch input, and keyboard shortcuts beyond Enter.
- Outlook `.msg` import (only `.eml` is tested), image markup, the command palette, bulk select and merge, and the trash emptying itself after 30 days.
- A picture that takes longer than the time limit to read (start-up stalls are covered; a stall in the middle of reading is not).
- The real Vercel build and hosting: the package and headers are tested locally as the host would serve them, not on Vercel.
