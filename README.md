# HEIC Viewer for Canvas SpeedGrader

A Chrome extension (Manifest V3) that displays HEIC/HEIF iPhone photos
inside Canvas SpeedGrader, the same place Canvas shows JPG/PNG submissions.

[Privacy policy](https://itmeson.github.io/heic-speedgrader/privacy) ·
[Security policy](SECURITY.md) ·
[Decoder licenses and source](licenses/DECODER.md)

Not affiliated with or endorsed by Instructure. Canvas is a trademark of
Instructure, Inc.

## Why an extension (and not something else)

| Option | Verdict |
|---|---|
| Ask Instructure / admin to add HEIC preview | Out of an individual teacher's control; long-standing open request. |
| Canvas API script or LTI tool | Needs an API token or admin-installed LTI, and usually a server that would handle student files. |
| Bookmarklet | Must be clicked on every student; Canvas's page security policy can block loading a WebAssembly decoder. |
| Userscript (Tampermonkey) | Works, but needs a second extension, and cross-origin file downloads are awkward. |
| **Chrome extension (this)** | Installs once, runs automatically, uses your existing Canvas login, decodes locally. No token, no server. |

## Privacy model

- **No server, no API token.** Requests go only to your Canvas site and
  Canvas's file storage, using the login you already have, and nothing is
  sent to the developer or any other service.
- **What it reads:** page addresses and file-link names on Canvas course
  pages; in SpeedGrader, the current student's submission record from the
  Canvas API (of which only attachment names, types, and download addresses
  are used); and the HEIC files themselves.
- **Decoded locally.** libheif compiled to WebAssembly, bundled in the
  extension. No remote code, no analytics.
- **Nothing kept.** No `storage` permission; downloads use `cache: 'no-store'`;
  images live in memory while the viewer is open; decoder workers release
  each file's data after decoding and shut down after 10 idle minutes. Chrome
  remembers custom Canvas addresses you grant. Save JPG writes a file only
  when you click it.
- Full details: [privacy policy](docs/privacy.md).

## How it works

```
Canvas page (top frame)
  content.js ── finds HEIC files; asks the Canvas API (your session) for each
       │        file's download address (with Canvas's per-file access token)
       │ register-file ──► background.js: checks the sender is our content
       │                   script on a Canvas page, and the address is a Canvas
       │ ◄── one-time ticket            file download on that same site
       ├─ viewer.html#t=<ticket>  (iframe)  redeems ticket (same tab, once),
       │      downloads (≤ 64 MB, final host checked), parses, paints
       │      ▲ MessagePort (only between extension-origin frames)
       └─ decoder-host.html (hidden, stays loaded)
              └─ 2–6 decoder-worker.js — libheif.wasm, compiled once
```

1. **Preview first.** `src/heif.js` reads the HEIC container and pulls out the
   small embedded thumbnail (iPhones include one), rebuilt as a tiny
   standalone HEIC; it decodes in a few milliseconds.
2. **Full image in parallel.** Phone photos are stored as a grid of
   independent 512×512 tiles. Each tile is wrapped as its own mini-HEIC and
   sent to the worker pool; tiles are painted as they finish (with the
   photo's rotation / crop / mirror applied as a canvas transform), sharpening
   the preview. Anything unusual falls back to decoding the file in one piece.
3. **Warm decoder.** The workers live in a hidden extension frame that stays
   loaded for the whole SpeedGrader session (created the first time a HEIC
   file is seen), so switching students doesn't restart them. Workers are
   released after 10 idle minutes.

Where it appears:

- **Classic SpeedGrader**: in the normal preview area, automatically when
  Canvas shows nothing, or when you click a HEIC file name (green "HEIC" badge).
- **Any SpeedGrader layout (incl. the new one)**: a floating "HEIC image" panel
  at the bottom-left lists the current student's HEIC files; click to open.
- **Other Canvas course pages**: a "View HEIC" button next to HEIC links.

Viewer: Fit / zoom (buttons, +/−, Ctrl+scroll) / rotate (R) / Save JPG.

## Build & install (developer mode)

```bash
npm install
npm run build        # produces dist/
npm run package      # build + heic-speedgrader-<version>.zip for the Chrome Web Store
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose the `dist` folder.
3. Open SpeedGrader on an assignment with a HEIC submission.

After code changes: `npm run build`, then click the reload icon on the
extension card. To test the decoder alone, open the Options page and use
"Test the decoder".

## Support and security

- Problems or ideas: [GitHub issues](https://github.com/itmeson/heic-speedgrader/issues).
  Please don't post student work, names, screenshots of real courses, or
  Canvas file links (they contain access tokens).
- Security reports: privately, as described in [SECURITY.md](SECURITY.md).

## Troubleshooting

Open DevTools (F12) → Console on the SpeedGrader page and filter for
`HEIC Viewer`. You should see `active on SpeedGrader` and, per student,
`current attempt has N attachment(s), M HEIC` (new SpeedGrader). No lines at all means the content
script isn't running on that URL (check the Canvas domain below).

## Canvas domain

Works automatically on `https://*.instructure.com`. Schools with their own
Canvas address add it on the **Options** page (click the toolbar icon, or
right-click it → Options). That requests an optional host permission for just
that site, and `background.js` registers the content script there. File
downloads redirect to Instructure's file hosts (`*.canvas-user-content.com`,
`*.inscloudgate.net`, `instructure-uploads.s3.amazonaws.com`), which are
listed in the manifest.

## Project layout

| Path | What |
| --- | --- |
| `src/` | Extension source (manifest, content script, viewer, decoder, options, icons) |
| `scripts/` | `build.mjs` (esbuild → `dist/`), `package.mjs` (zip for the store) |
| `docs/` | GitHub Pages site: privacy policy, home page, synthetic sample HEIC for testing |
| `licenses/` | Bundled decoder inventory, source and replacement notes |
| `store/` | Store screenshots (1280×800) and promo tile (440×280) |

## License

MIT for this project's code (see `LICENSE`). The bundled decoder (libheif /
libde265 via libheif-js) is LGPL-3.0; [licenses/DECODER.md](licenses/DECODER.md)
lists exact versions, source archives (attached to each GitHub release), and
how to rebuild the extension with a replacement decoder. Its notice and license
text ship in the extension as `THIRD_PARTY_NOTICES.txt`.

