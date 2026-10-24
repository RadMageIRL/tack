# Vendored files: picture-text search

These files run **Data > Search text in pictures**, an optional feature that is off until you turn it on. tack uses them only when it is served over http or https (for example from tack.radmagelabs.com). It loads them from this folder on the same site, so that use never contacts another server. When tack.html is opened straight from disk (`file://`), browsers won't start a worker from this folder, so tack loads the same pinned versions from cdn.jsdelivr.net instead (see `../SECURITY.md`).

Nothing here was modified. Each file except `BUNDLED-LICENSES.txt` is byte-for-byte what the npm registry serves for the version shown, downloaded through cdn.jsdelivr.net on 2026-10-24 and checked again against the CDN that day. `BUNDLED-LICENSES.txt` collects, unedited, the license files of the packages compiled into the two bundles. `tools/package.mjs` refuses to build the website package if any file listed below no longer matches its hash.

| File | Package and version | Bytes | SHA-256 |
|---|---|---|---|
| `tesseract.js@5.1.1/tesseract.min.js` | tesseract.js 5.1.1, `dist/` | 66,695 | `a8e29918d098b2b06e1012bdaeffb4aec0445c5d5654709023e0bd1f442a80e8` |
| `tesseract.js@5.1.1/worker.min.js` | tesseract.js 5.1.1, `dist/` | 123,724 | `aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc` |
| `tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js` | tesseract.js-core 5.1.1 | 3,938,657 | `ce20eda9533cbed1e6c2b4276fbae1e0adc61b6754b5513084be601787b457cf` |
| `tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js` | tesseract.js-core 5.1.1 (for browsers without WebAssembly SIMD) | 3,938,277 | `8f04aa0cc81e7bde33f80e92fa01a7a665f0b4884d098acf5de9c7104a11dfaa` |
| `tesseract.js-data-eng@1.0.0/4.0.0_best_int/eng.traineddata.gz` | @tesseract.js-data/eng 1.0.0 | 2,952,873 | `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91` |

`tesseract.min.js` is also pinned in `tack.html` by a Subresource Integrity hash (`sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F`). The browser checks it on both paths, this folder and the CDN.

## Licenses

- **tesseract.js** (https://github.com/naptha/tesseract.js): Apache License 2.0, in `tesseract.js@5.1.1/LICENSE.md`. The two bundles also contain ten smaller packages. Their full license texts are in `tesseract.js@5.1.1/BUNDLED-LICENSES.txt`: regenerator-runtime, is-electron, is-url, bmp-js, zlib.js, buffer and base64-js (MIT), idb-keyval and wasm-feature-detect (Apache 2.0), and ieee754 (BSD-3-Clause). The short notices the build kept are in `*.LICENSE.txt` beside each bundle.
- **tesseract.js-core** (https://github.com/naptha/tesseract.js-core), a WebAssembly build of the Tesseract OCR engine: Apache License 2.0, in `tesseract.js-core@5.1.1/LICENSE`.
- **English recognition data**: the npm package @tesseract.js-data/eng declares MIT in its package.json, but its source repository, https://github.com/naptha/tessdata, is Apache License 2.0. The data comes from the Tesseract project's tessdata_best models (https://github.com/tesseract-ocr/tessdata_best, also Apache License 2.0). That license is in `tesseract.js-data-eng@1.0.0/LICENSE`.

## Updating

Change all of them together and keep each folder named after its package and exact version. Then update:
- the table above;
- `BUNDLED-LICENSES.txt`;
- the file list in `tools/package.mjs`;
- in `tack.html`, the `OCR_` constants, the SRI hash and the CDN URLs, which must name the same versions.

Then run `node tests/run.mjs`, `node tests/run.mjs --package` and `node tests/run.mjs --ocr`.
