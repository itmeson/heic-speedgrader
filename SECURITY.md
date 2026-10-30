# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
**Security → Report a vulnerability** on
https://github.com/itmeson/heic-speedgrader/security/advisories/new

Please **do not** include real student work, student names or IDs, grades,
Canvas file links (they contain access tokens), cookies, or screenshots of
real courses. A description, the extension version, your Chrome version, and,
if needed, a synthetic test file are enough.

Only the latest published version is supported with fixes.

## Security design (summary)

- The extension has no server and sends nothing to the developer.
- File downloads use the teacher's existing Canvas login. Before the viewer
  opens a file, the background script checks that the request came from the
  extension's content script on a Canvas page it runs on, and that the address
  is a Canvas file download on that same site; the viewer then receives a
  single-use ticket, valid only in that tab. After download, files that came
  from an unexpected host are rejected.
- The viewer and the decoder accept messages only from the extension's own
  origin.
- Images are decoded by WebAssembly in a dedicated worker, with limits on
  file size (64 MB), image size (120 megapixels), tile count (1,024), and
  decode time (20 seconds).

## Known issues

The bundled decoder (libheif 1.23.5, libde265 1.0.15, via libheif-js 1.23.5)
is affected by upstream advisories fixed in libheif 1.23.7 and libde265 1.1.x,
including denial-of-service and memory-safety issues triggered by crafted
image files. The mitigations above (WebAssembly sandbox, isolated worker,
time and size limits) reduce the impact to failing to display the crafted
file. The decoder will be updated when libheif-js publishes fixed builds.
Details: `licenses/DECODER.md`.
