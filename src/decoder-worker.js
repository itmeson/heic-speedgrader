// Decoder worker: one libheif (WebAssembly) instance per worker.
// Receives a compiled WebAssembly.Module once, then decodes HEIC buffers to
// ImageBitmaps. Several of these run in parallel (see decoder-pool.js).

import libheifFactory from 'libheif-js/libheif-wasm/libheif.js';

let ready = null;
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
  }).then((lib) => {
    decoder = new lib.HeifDecoder();
    return lib;
  });
  return ready;
}

async function decode(buf) {
  await ready;
  // HeifDecoder frees the previous file's context on each call.
  const images = decoder.decode(new Uint8Array(buf));
  if (!images.length) throw new Error('libheif found no image');
  const img = images[0];
  const width = img.get_width(), height = img.get_height();
  const out = new ImageData(width, height);
  await new Promise((resolve, reject) =>
    img.display(out, (d) => (d ? resolve() : reject(new Error('libheif could not decode the image')))));
  img.free?.();
  return createImageBitmap(out);
}

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'init') {
    init(msg.module).then(() => self.postMessage({ type: 'ready' }),
      (e) => self.postMessage({ type: 'init-error', error: String(e?.message || e) }));
    return;
  }
  try {
    const bitmap = await decode(msg.buf);
    self.postMessage({ id: msg.id, bitmap }, [bitmap]);
  } catch (e) {
    self.postMessage({ id: msg.id, error: String(e?.message || e) });
  }
};
