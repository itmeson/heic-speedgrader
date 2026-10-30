// Decoder worker: one libheif (WebAssembly) instance per worker.
// Receives a compiled WebAssembly.Module once, then decodes HEIC buffers to
// ImageBitmaps. Several of these run in parallel (see decoder-pool.js).

import libheifFactory from 'libheif-js/libheif-wasm/libheif.js';
import { MAX_PIXELS } from './limits.js';

let ready = null;
let lib = null;
let decoder = null;

function init(module) {
  ready = new Promise((resolve, reject) => {
    // The factory fills in (and returns) the very object we pass it, and may
    // finish initialising before it returns — so resolve with that object.
    const opts = {
      // This libheif build sets itself up synchronously, so instantiate the
      // (already compiled) module synchronously too — fine inside a worker.
      instantiateWasm(imports, done) {
        try {
          return done(new WebAssembly.Instance(module, imports), module);
        } catch (e) {
          reject(e);
          throw e;
        }
      },
      onRuntimeInitialized() { resolve(opts); },
      print() {},
      printErr() {},
    };
    libheifFactory(opts);
  }).then((l) => {
    lib = l;
    decoder = new lib.HeifDecoder();
    return lib;
  });
  return ready;
}

/** Release libheif's copy of the last file. */
function releaseContext() {
  if (decoder?.decoder) {
    lib.heif_context_free(decoder.decoder);
    decoder.decoder = null;
  }
}

async function decode(buf) {
  await ready;
  let images = [];
  try {
    images = decoder.decode(new Uint8Array(buf));
    if (!images.length) throw new Error('libheif found no image in this file');
    // Prefer the primary image; libheif lists top-level images.
    const img = images.find((i) => i.is_primary?.()) || images[0];
    const width = img.get_width(), height = img.get_height();
    if (!(width > 0 && height > 0)) throw new Error('image has no size');
    if (width * height > MAX_PIXELS) throw new Error(`LIMIT: image is too large (${width}×${height})`);
    const out = new ImageData(width, height);
    await new Promise((resolve, reject) =>
      img.display(out, (d) => (d ? resolve() : reject(new Error('libheif could not decode the image')))));
    return await createImageBitmap(out);
  } finally {
    for (const i of images) { try { i.free(); } catch { /* already freed */ } }
    releaseContext();
  }
}

self.onmessage = async ({ data: msg }) => {
  if (msg?.type === 'init') {
    init(msg.module).then(() => self.postMessage({ type: 'ready' }),
      (e) => self.postMessage({ type: 'init-error', error: String(e?.message || e) }));
    return;
  }
  if (!Number.isSafeInteger(msg?.id) || !(msg.buf instanceof ArrayBuffer)) return;
  try {
    const bitmap = await decode(msg.buf);
    self.postMessage({ id: msg.id, bitmap }, [bitmap]);
  } catch (e) {
    self.postMessage({ id: msg.id, error: String(e?.message || e) });
  }
};
