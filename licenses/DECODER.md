# Bundled HEIC decoder: components, source, and replacement

The extension decodes images with **libheif** and **libde265**, compiled to
WebAssembly and packaged by **libheif-js**. These are open-source libraries
licensed under the **GNU Lesser General Public License v3.0** (LGPL-3.0); their
license text follows in `THIRD_PARTY_NOTICES.txt`. The rest of the extension is
MIT-licensed (see `LICENSE.txt` in the extension, `LICENSE` in the source).

## Component inventory

| Component | Version | Source | License |
| --- | --- | --- | --- |
| libheif-js (npm package, JavaScript wrapper + build) | 1.23.5 | https://github.com/catdad-experiments/libheif-js/tree/1.23.5 | LGPL-3.0 |
| libheif-emscripten (build of libheif for the web) | v1.23.5 | https://github.com/catdad-experiments/libheif-emscripten/tree/v1.23.5 | LGPL-3.0 |
| libheif | 1.23.5, commit 413e2a87e6a70b3eccc3a3adc5801179dd2d9e00 | https://github.com/strukturag/libheif/tree/413e2a87e6a70b3eccc3a3adc5801179dd2d9e00 | LGPL-3.0 |
| libde265 (HEVC decoder used by libheif) | 1.0.15 | https://github.com/strukturag/libde265/releases/tag/v1.0.15 | LGPL-3.0 |
| Emscripten (compiler used for the build) | 3.1.61 | https://github.com/emscripten-core/emscripten | MIT / UIUC |

Build: libheif's `build-emscripten.sh` (from the commit above, default
`LIBDE265_VERSION=1.0.15`) run by the libheif-emscripten workflow with
Emscripten 3.1.61; libheif-js 1.23.5 repackages that output unmodified. This
extension uses the files unmodified:

| File in the extension | Comes from | SHA-256 |
| --- | --- | --- |
| `libheif.wasm` | `libheif-js@1.23.5/libheif-wasm/libheif.wasm` | 184d3d20f8323877f13e9f5254f9c6a0ce272c9a3a2f823b0b2bcd2ee9f73f80 |
| `decoder-worker.js` | `libheif-js@1.23.5/libheif-wasm/libheif.js` (bundled with this project's worker code by esbuild) | changes per release |

## Getting the source

Exact copies of the source archives for the versions above are attached to
each release of this project on GitHub:
https://github.com/itmeson/heic-speedgrader/releases

(The upstream links in the table point to the same versions.)

## Using a modified or updated decoder

The decoder is kept in separate files so it can be replaced:

1. Get this project's source (link above) and run `npm install`.
2. Replace `node_modules/libheif-js` with your modified or updated build
   (same file layout: `libheif-wasm/libheif.js` and `libheif-wasm/libheif.wasm`),
   or change the `libheif-js` version in `package.json`.
3. Run `npm run build`, then load the `dist` folder in Chrome
   (`chrome://extensions` → Developer mode → Load unpacked).

## Known decoder security advisories

The bundled versions predate fixes published in libheif 1.23.7
(https://github.com/strukturag/libheif/releases/tag/v1.23.7) and libde265 1.1.x
(https://github.com/strukturag/libde265/security/advisories). In this extension
the decoder runs as WebAssembly inside a dedicated worker with no access to the
page, other tabs, or Chrome extension features; each decode is stopped after
20 seconds; and file size, image size, and tile count are limited. The project
will move to fixed versions when libheif-js publishes them. See `SECURITY.md`.
