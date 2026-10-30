---
title: Privacy policy – HEIC Viewer for Canvas SpeedGrader
---

# Privacy policy

**HEIC Viewer for Canvas SpeedGrader** (the "extension")

Last updated: October 29, 2026

## Summary

The extension does not collect, store, sell, or share any personal or student
information. Everything it does happens inside your own browser.

## What the extension accesses

- **Canvas pages you open.** On Canvas course pages, the extension looks for
  submitted files whose names end in `.heic` or `.heif`. In SpeedGrader it asks
  Canvas for the current submission's list of attached files, using your
  existing Canvas login (the same request Canvas itself makes). No API token is
  used or stored.
- **HEIC files you view.** When a HEIC submission is shown, the extension
  downloads that file from Canvas (exactly as clicking "Download" would) and
  decodes it into an image on your computer using a bundled, open-source
  decoder (libheif).

## What the extension does not do

- It does not send any data to the developer or any third party. Its only
  network requests go to your own Canvas site and Canvas's file storage.
- It does not store submissions, images, names, grades, or comments. Decoded
  images exist only in memory while the viewer is open.
- It does not use analytics, tracking, advertising, or remote code.

## Settings

If you add a custom Canvas address on the Options page, Chrome stores that
permission locally in your browser. You can remove it at any time on the same
page or in `chrome://extensions`.

## Contact

Questions: open an issue on the project's GitHub page.
