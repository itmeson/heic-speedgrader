---
title: Privacy policy – HEIC Viewer for Canvas SpeedGrader
---

# Privacy policy

**HEIC Viewer for Canvas SpeedGrader** (the "extension")

Last updated: October 30, 2026

## Summary

The extension shows HEIC/HEIF photos that students submit to Canvas. It does
this inside your own browser. It does **not** send any data to the developer
or to any other service, has no server, and uses no analytics or advertising.
It reads only what it needs from Canvas, using your existing Canvas login,
and keeps nothing after you close the page.

## What the extension reads, and why

The extension runs only on Canvas course pages at `*.instructure.com`, and on
any other Canvas address you add yourself on its Options page.

- **Page addresses and links.** It reads the address of the Canvas page you're
  on (which contains course, assignment, and student or anonymous-grading ID
  numbers) and the names of file links on the page, to find HEIC/HEIF files.
- **Submission and file details from Canvas.** In SpeedGrader it asks Canvas,
  using your existing login, for the current student's submission. Canvas's
  reply includes details such as the student's ID number, the attempt, dates,
  and grade or score, along with the list of attached files. For course file
  links it asks Canvas for that file's details. The extension uses only the
  attached files' names, types, and download addresses; it ignores the rest of
  the reply and doesn't keep it.
- **The image files.** When a HEIC file is shown, the extension downloads it
  from Canvas or Canvas's file storage (`*.instructure.com`,
  `*.canvas-user-content.com`, `*.inscloudgate.net`,
  `instructure-uploads.s3.amazonaws.com`), the same way clicking "Download"
  would, and decodes it into a picture on your computer.

Chrome's Web Store classifies this as handling **website content** and
**personally identifiable information** (student ID numbers). All of it is
processed on your computer only.

## What the extension keeps

- **Nothing about students or submissions.** Downloaded files and decoded
  images exist only in memory while the viewer is open. Downloads are made
  with caching turned off. The decoder releases each file's data as soon as it
  has finished with it, and the decoder itself shuts down after 10 idle
  minutes or when you leave the page.
- **Custom Canvas addresses** you add on the Options page are remembered by
  Chrome as permissions you granted. You can remove them on the Options page
  or at `chrome://extensions`.
- **Save JPG** creates a file on your computer only when you click it, saved
  wherever your browser saves downloads.
- **Console messages** (visible in the browser's developer tools) show counts
  and timings, such as "1 attachment, 1 HEIC", and no names or ID numbers.

## What the extension does not do

- It doesn't transmit, sell, or share any data, and it isn't used for any
  purpose other than displaying images.
- It doesn't load or run code from the internet; all of its code, including
  the image decoder, is packaged inside the extension.
- It doesn't change anything in Canvas.

Canvas itself, and your school, handle student data under their own policies;
this policy covers only the extension.

## Questions and changes

Questions: open an issue at https://github.com/itmeson/heic-speedgrader/issues
(please don't include student work, names, or Canvas links). Security reports:
see https://github.com/itmeson/heic-speedgrader/security/policy .

If this policy changes, the new version will be posted here with a new date.
