# Tack 1.0.0

Tack is a notes, checklists and tasks app in a single HTML file. Your notes stay in your browser: no account, nothing uploaded. It's free software under the GNU GPL, version 3 or later.

## Getting it

Use it online at **https://tack.radmagelabs.com/**, or download `tack.html` and open it in your browser. Chrome and Edge are fully tested and Firefox has passed a smoke test; Safari should work but hasn't been tested. To get picture-text search without contacting a CDN, serve the folder from a web server instead, so `vendor/` sits beside the page.

## Highlights

- Notes and checklists with Markdown, labels, colors, pins, reminders and due dates
- A Tasks view that gathers every open item, with natural due dates ("water plants fri")
- `[[Note links]]` with backlinks, per-note history, and templates
- Pictures with markup tools, and optional search for the text inside them
- Password-locked notes
- Imports from Google Keep, email and Tack backups; JSON and Markdown exports
- Automatic snapshots, plus an autosaved file and backup folder in Chrome and Edge
- Light, dark and Vegas themes

## Before you start

Your notes live only in the browser you use, under the address you open Tack from. Use **Data > Export backup** now and then. If you used Tack before from a different file or address, export there and import here.

## In this release

See [CHANGELOG.md](../CHANGELOG.md) for everything. In short:
- Pictures can no longer carry script, and malformed note links can no longer open pages.
- Unreadable saved data is never overwritten, and storage problems stay visible until they're fixed.
- Merge imports take a snapshot first.
- Picture-text search loads from the same site, pinned and integrity-checked, and always ends in either text or a clear warning.

## Known limitations

Reminders fire only while Tack is open. Touch drag and drop on phones isn't verified. Locked notes don't encrypt titles, labels or pictures. Safari isn't tested yet. More in the README.
