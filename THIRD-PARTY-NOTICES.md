# Third-party notices

Tack's own code is in `tack.html`, under the GNU General Public License, version 3 or later (see [LICENSE](LICENSE)). The only third-party code is the optional picture-text reader. It ships unmodified in `vendor/` and, when `tack.html` is opened as a file, loads at the same pinned versions from cdn.jsdelivr.net. It is separate software that keeps its own licenses. All of them (Apache 2.0, MIT and BSD-3-Clause) permit redistribution next to GPL software, and Apache 2.0 is compatible with GPL version 3. Exact files, sizes and SHA-256 hashes are in [vendor/README.md](vendor/README.md).

| Component | Version | Used for | License | License text |
|---|---|---|---|---|
| tesseract.js (https://github.com/naptha/tesseract.js) | 5.1.1 | Picture-text search: the loader and its worker | Apache License 2.0 | `vendor/tesseract.js@5.1.1/LICENSE.md` |
| tesseract.js-core (https://github.com/naptha/tesseract.js-core) | 5.1.1 | The Tesseract OCR engine compiled to WebAssembly | Apache License 2.0 | `vendor/tesseract.js-core@5.1.1/LICENSE` |
| English recognition data, @tesseract.js-data/eng (https://github.com/naptha/tessdata), from Tesseract's tessdata_best models (https://github.com/tesseract-ocr/tessdata_best) | 1.0.0 (`4.0.0_best_int`) | The English model the reader uses | Apache License 2.0 (the npm package metadata says MIT; its source repository and the upstream models are Apache 2.0) | `vendor/tesseract.js-data-eng@1.0.0/LICENSE` |

The two tesseract.js bundles also contain the code of these packages. Their full license texts are in `vendor/tesseract.js@5.1.1/BUNDLED-LICENSES.txt`, and the short notices the build kept are in the `*.LICENSE.txt` files beside the bundles:

| Package | License | Copyright | In |
|---|---|---|---|
| regenerator-runtime | MIT | 2014-present, Facebook, Inc. | both bundles |
| is-electron | MIT | 2016-2018 Cheton Wu | both bundles |
| is-url | MIT | (the license names no holder) | worker |
| idb-keyval | Apache-2.0 | 2016, Jake Archibald | worker |
| wasm-feature-detect | Apache-2.0 | 2017 Google Inc. | worker |
| bmp-js | MIT | 2014 @丝刀口 | worker |
| zlib.js (zlibjs) | MIT | 2012 imaya | worker |
| buffer | MIT | Feross Aboukhadijeh, and other contributors | worker |
| base64-js | MIT | 2014 Jameson Little | worker (through buffer) |
| ieee754 | BSD-3-Clause | 2008 Fair Oaks Labs, Inc. | worker (through buffer) |

The bundles don't record which release of each package they contain. These texts come from the newest release within the range tesseract.js 5.1.1 declares, and the license type is the same across those ranges. None of the Apache 2.0 packages above ships a NOTICE file. Nothing in `vendor/` has been modified.

Google Keep and Outlook are trademarks of their owners. They are named only to describe the files Tack can import.
