# Security and privacy

## Reporting a problem

Please report security problems privately to **radmageirl@radmagelabs.com** rather than in a public issue. Include the browser and version, and the steps or file that show the problem.

## What Tack stores, and where

Everything is in the browser profile Tack is opened in, keyed to the page's address (its origin):

| Storage | Contents |
|---|---|
| localStorage `tack_state` | Notes, labels, templates. Locked notes appear only as ciphertext. |
| localStorage `tack_prefs`, `tack_theme` | Settings and theme |
| IndexedDB `tack` | Pictures, note history (the last 25 versions per note), automatic snapshots, saved file and folder handles (Chrome/Edge), and any unreadable saved data kept for recovery |
| IndexedDB `keyval-store` | The picture-text reader's English data, only once picture-text search has been used |

Nothing is sent to a server. Anyone who can use your browser profile, or any script running on the same origin, can read all of it. That is why the hosted copy is planned for its own subdomain rather than a path on a site shared with other apps (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

## Network behavior

Tack makes no network requests of its own except for **picture-text search**, which is off until you turn it on:

- **Opened from a website** (http or https): the reader loads from the `vendor/` folder on that same site. If those files are missing or broken, Tack shows a warning; it never falls back to another server.
- **Opened as a file** (`file://`): browsers won't start the reader's worker from a local folder, so it loads the same pinned versions from cdn.jsdelivr.net.

Every reader file is pinned to an exact version (listed in [vendor/README.md](vendor/README.md)). The first one is also checked against a Subresource Integrity hash, so a changed copy is refused on either path. Starting is limited to 90 seconds and each picture to 60; a failure, a block or a timeout ends in a visible warning with Retry. Pictures are read inside the browser and never uploaded.

Clicking a link in a note opens it in a new tab with `rel="noopener noreferrer"`. Links can only be `http`, `https` or `mailto`.

## How content is handled

- **Notes and Markdown:** all text is HTML-escaped before Markdown formatting is applied, and the formatter adds only a fixed set of elements. The test suite renders 40,000 generated inputs on every run and checks for event handlers, unexpected elements, unsafe links, same-tab links and broken markup.
- **Pictures:** only bitmap formats (PNG, JPEG, GIF, WebP, BMP, AVIF) are stored and shown as they are. SVG files, which can contain script, are redrawn as PNG; other non-bitmap content is refused. This applies to pasted, dropped and picked files, Google Keep and email imports, and pictures inside imported backups. SVGs stored by earlier versions are shown as a PNG made in memory.
- **Imports:** backups are checked for Tack's format, and every note and template is normalized: types checked, lengths capped, unknown fields dropped. Picture data is accepted only as an image `data:` URL with a valid id, and never replaces a picture already stored. Email HTML is parsed without running anything and turned into plain text.
- **Unreadable saved data** is never overwritten. It is kept as found and can be downloaded.

## Locked notes

A locked note's text and checklist are encrypted with AES-GCM (256-bit) using a key derived from your password with PBKDF2-SHA-256 (310,000 iterations, random salt). The password is never stored. The derived key stays in memory for 10 minutes after use, so reopening doesn't ask again.

What locking does **not** protect:

- the title, labels, color and pictures;
- snapshots, history and backups made before the note was locked (locking deletes that note's history, but not snapshots or files already exported);
- a short password: exported backups carry the ciphertext, so a weak password can be guessed offline. The minimum is 4 characters; use far more.

A forgotten password cannot be recovered.

## What the website serves

The hosted copy serves only a package built by `tools/package.mjs`: `tack.html`, the reader's files and the license texts. That's 13 files, copied from a fixed list after every vendored file has been checked against its recorded hash. Nothing else from the project (documentation, tests, development notes) is uploaded or served. Every response carries the Content-Security-Policy and other headers defined in `vercel.json` ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) explains each one), and the test suite and the Firefox smoke test both run in full against the package under those headers.

## Known gaps

- The pixelate tool changes the saved picture, but the original stays in snapshots, history and older backups.
- A malformed Outlook `.msg` file can make the tab use a lot of memory while it is read. Only files you choose are read.
- Safari has not been tested. Firefox 148 has passed a smoke test of the essentials, not the full suite.
