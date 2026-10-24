# Changelog

## 1.0.0 (unreleased)

The first public release. Earlier versions were private and ran under the name taskman; their saved data is carried over automatically.

### Security
- Pictures are stored and shown only in bitmap formats. SVG files, which can contain script, are redrawn as PNG; other non-bitmap content (including XML and HTML sent as an "image") is refused. This covers pasting, dropping and picking files, Google Keep and email imports, and pictures inside imported backups. SVGs stored by earlier versions are shown as a PNG made in memory, and the stored originals are left as they were.
- A web address inside a `[[note link]]` could break the link's markup into a link that replaced the Tack tab when clicked, and a note link inside an external link opened both. Note links are now kept out of every other formatting step.
- The picture-text reader is pinned to exact versions, including its language data, which previously followed the newest package. Its first file is checked against a Subresource Integrity hash.
- Served from a website, the picture-text reader loads from `vendor/` on the same site, so that use contacts no other server. Opened as a file, it uses the same pinned versions from cdn.jsdelivr.net.

### Reliability
- Saved data that can't be read is no longer replaced by the welcome notes. Tack keeps it as found, writes nothing over it, and offers to download it, restore a snapshot, import a backup or start fresh. Pictures and history it refers to are kept too.
- When storage is full or blocked, a warning and a red `!` on the save dot stay up until saving works again, with Export backup and Retry. Messages no longer say "saved" when nothing was.
- An import that merges notes with the same id as existing ones takes a safety snapshot first. Safety and manual snapshots now wait for a backup already running instead of being skipped. If a safety snapshot can't be saved, Tack asks before going ahead.
- Picture-text search has time limits (90 seconds to start, 60 per picture). A missing, blocked, changed or stuck reader ends in a warning that says why, with Retry, instead of "Reading pictures…" forever.

### Changed
- New neutral starter templates (Daily plan, Packing list) and examples. Saved templates and notes are untouched.
- Help and labels now describe network use accurately.
- Em dashes are gone from the interface.
- The browser database moves to version 4, which adds a store for unreadable saved data. Reload any open tab of an older version after updating.

- Saves and backups record version `1.0.0` (this is only a note in the file; nothing reads it back, so older and newer backups import the same way).

### Added
- Licensed under the GNU General Public License, version 3 or later.
- A browser test suite (`node tests/run.mjs`) and a Firefox smoke test (`node tests/firefox-smoke.mjs`), with no dependencies.
- `tools/package.mjs`, which builds the website package (`dist/`: the app, the reader's files and their licenses) after checking every vendored file's hash; `vercel.json` serves only that package, with strict security headers.
- README, security and privacy notes, third-party notices with the full license texts of the code bundled in the reader, testing and deployment documentation, and screenshots.
