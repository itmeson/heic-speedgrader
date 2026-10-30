# HEIC Viewer for Canvas SpeedGrader

A personal Chrome extension (Manifest V3) that displays HEIC/HEIF iPhone photos
inside Canvas SpeedGrader, the same place Canvas shows JPG/PNG submissions.

## Why an extension (and not something else)

| Option | Verdict |
|---|---|
| Ask Instructure / admin to add HEIC preview | Out of an individual teacher's control; long-standing open request. |
| Canvas API script or LTI tool | Needs an API token or admin-installed LTI, and usually a server that would handle student files. |
| Bookmarklet | Must be clicked on every student; Canvas's page security policy can block loading a WebAssembly decoder. |
| Userscript (Tampermonkey) | Works, but needs a second extension, and cross-origin file downloads are awkward. |
| **Chrome extension (this)** | Installs once, runs automatically, uses your existing Canvas login, decodes locally. No token, no server. |

## Privacy model

- **No API token.** The viewer downloads the file with the same logged-in
  Canvas session you already have — exactly what clicking "Download" does.
- **Nothing leaves the browser.** Decoding uses libheif compiled to
  WebAssembly (`libheif-js`), bundled inside the extension. No remote code, no
  analytics, no network calls except to Canvas's own file URLs.
- **Nothing is stored.** No `storage` permission; the decoded image exists only
  as an in-memory blob URL inside the viewer frame.
- The content script only reads file names of links (`*.heic`, `*.heif`); it
  doesn't read grades, names, or comments.

## How it works

```
SpeedGrader page (canvas)
┌───────────────────────────────────────────┐
│ content.js  finds HEIC files (file list,   │
│             or Canvas API for the current  │
│             student, using your session)   │
│   ├─ viewer.html  (iframe, one per file)   │◄─ downloads the file, parses it,
│   │      ▲ MessagePort                     │   paints preview + tiles
│   └─ decoder-host.html (hidden, stays     │
│          loaded all session)              │
│          └─ 2–6 decoder-worker.js          │◄─ libheif.wasm, compiled once
└───────────────────────────────────────────┘
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

## Troubleshooting

Open DevTools (F12) → Console on the SpeedGrader page and filter for
`HEIC Viewer`. You should see `active on SpeedGrader` and, per student,
`submission has N attachment(s), M HEIC`. No lines at all means the content
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
| `docs/` | GitHub Pages site: `privacy.md` is the privacy policy URL for the store |
| `store/` | Store screenshots (1280×800) and promo tile (440×280) |

## License

MIT for this project's code (see `LICENSE`). The bundled decoder (libheif /
libde265 via libheif-js) is LGPL-3.0; its notice ships in
`dist/THIRD_PARTY_NOTICES.txt`.

