// HEIC Viewer — viewer page (an extension page embedded in Canvas).
//
// Learns which file to show by redeeming a one-time ticket with the
// background script (never from its own URL), downloads it with the
// teacher's Canvas login, decodes it on this computer with libheif
// (WebAssembly) and draws it. Nothing is stored or sent elsewhere.

import { isHeicHevc, parseHeif, thumbnailJob, gridPlan, describe, primarySize } from './heif.js';
import { LocalPool, RemotePool } from './decoder-pool.js';
import { isAllowedFinalUrl } from './url-policy.js';
import { LimitError, MAX_FILE_BYTES, MAX_PIXELS, MAX_TILES } from './limits.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const wrap = $('wrap');
const cv = $('cv');
const statusEl = $('status');
const zoomLabel = $('zoom-label');
const phase = $('phase');

const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

let natW = 0, natH = 0;   // decoded image size
let rotation = 0;         // 0, 90, 180, 270
let fit = true;
let scale = 1;            // used when fit === false
let fileName = '';

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = !msg;
}

const rotatedSize = () =>
  rotation % 180 ? [natH, natW] : [natW, natH];

function fitScale() {
  const [rw, rh] = rotatedSize();
  const pad = 16;
  const s = Math.min((stage.clientWidth - pad) / rw, (stage.clientHeight - pad) / rh);
  return Math.min(s, 1); // like SpeedGrader: shrink to fit, never enlarge
}

const currentScale = () => (fit ? fitScale() : scale);

/** Lay out the image. `anchor` keeps the point under the viewport center fixed. */
function layout(anchor = true) {
  if (!natW) return;
  // remember which part of the image is at the center of the view
  const cx = (stage.scrollLeft + stage.clientWidth / 2) / Math.max(wrap.offsetWidth, 1);
  const cy = (stage.scrollTop + stage.clientHeight / 2) / Math.max(wrap.offsetHeight, 1);

  const s = currentScale();
  const [rw, rh] = rotatedSize();
  wrap.style.width = `${Math.round(rw * s)}px`;
  wrap.style.height = `${Math.round(rh * s)}px`;
  cv.style.width = `${natW * s}px`;
  cv.style.height = `${natH * s}px`;
  cv.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;

  if (anchor) {
    stage.scrollLeft = cx * wrap.offsetWidth - stage.clientWidth / 2;
    stage.scrollTop = cy * wrap.offsetHeight - stage.clientHeight / 2;
  }
  $('fit').setAttribute('aria-pressed', String(fit));
  zoomLabel.textContent = `${Math.round(s * 100)}%`;
}

function zoomBy(factor) {
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentScale() * factor));
  fit = false;
  layout();
}

const log = (...a) => console.info('[HEIC Viewer]', ...a);
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const mp = (w, h) => `${Math.round((w * h) / 1e6)} megapixels`;

// ---------------------------------------------------------------------------
// Decoder connection. Normally a warm worker pool in the long-lived
// decoder-host frame on the same page. We find it by pinging sibling frames
// with targetOrigin = our own extension origin, and accept only replies from
// that origin (web pages can't send messages that claim it). Otherwise we
// start our own pool.
// ---------------------------------------------------------------------------
function connectToHost(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (window.parent === window) { resolve(null); return; }
    const nonce = crypto.randomUUID();
    const onMsg = (e) => {
      if (e.origin !== location.origin || !e.source || e.data?.type !== 'heic-host-here' ||
          e.data.nonce !== nonce) return;
      cleanup();
      const { port1, port2 } = new MessageChannel();
      e.source.postMessage({ type: 'heic-connect', nonce }, location.origin, [port2]);
      resolve(new RemotePool(port1));
    };
    const ping = () => {
      const frames = window.parent.frames;
      for (let i = 0; i < frames.length; i++) {
        try { if (frames[i] !== window) frames[i].postMessage({ type: 'heic-host-ping', nonce }, location.origin); } catch { /* gone */ }
      }
    };
    const iv = setInterval(ping, 250);
    const to = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    function cleanup() { clearInterval(iv); clearTimeout(to); window.removeEventListener('message', onMsg); }
    window.addEventListener('message', onMsg);
    ping();
  });
}

let poolPromise = null;
function getPool() {
  poolPromise ??= connectToHost().then((remote) => {
    if (remote) return remote;
    const p = new LocalPool();
    p.warm();
    return p;
  });
  return poolPromise;
}

// ---------------------------------------------------------------------------
// Display. Each call gets a generation number; anything that finishes for an
// older generation is discarded, so a late tile or a slow earlier file can't
// paint over the current image.
// ---------------------------------------------------------------------------
let displayGen = 0;
let downloadCtrl = null;
const stale = (gen) => gen !== displayGen;

function resetView(name) {
  natW = natH = 0;
  rotation = 0;
  fit = true;
  scale = 1;
  fileName = name || '';
  cv.width = cv.height = 0;
  wrap.hidden = true;
  phase.hidden = true;
  $('save').disabled = true;
  zoomLabel.textContent = '';
  $('name').textContent = fileName;
  document.title = fileName ? `HEIC preview – ${fileName}` : 'HEIC preview';
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', fileName || 'Submitted image');
}

function showCanvas() {
  setStatus('');
  wrap.hidden = false;
}

/** Put a decoded bitmap on screen, displayed as if it were displayW×displayH. */
function drawBitmap(bitmap, displayW, displayH) {
  cv.width = bitmap.width;
  cv.height = bitmap.height;
  cv.getContext('2d').drawImage(bitmap, 0, 0);
  natW = displayW;
  natH = displayH;
}

function checkPixels(w, h) {
  if (w * h > MAX_PIXELS) throw new LimitError(`image is too large to preview (${mp(w, h)})`);
}

async function display(blob, name) {
  const gen = ++displayGen;
  resetView(name);
  setStatus('Decoding image…');
  if (blob.size > MAX_FILE_BYTES) throw new LimitError('file is too large to preview');

  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const buf = await blob.arrayBuffer();
  if (stale(gen)) return;

  if (!isHeicHevc(buf)) {
    log('not a HEIC file; using the browser\'s own decoder');
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    if (stale(gen)) { bmp.close(); return; }
    checkPixels(bmp.width, bmp.height);
    drawBitmap(bmp, bmp.width, bmp.height);
    bmp.close();
    return finish();
  }

  const pool = await getPool();
  if (stale(gen)) return;
  pool.cancelPending(); // anything still queued for an earlier image

  let m = null;
  try { m = parseHeif(buf); } catch (e) { log(`file structure not readable (${e.message}); letting libheif try`); }

  // Plan the full decode: split a tiled image across the worker pool.
  let plan = null;
  if (m) {
    try { plan = gridPlan(m); } catch (e) { plan = { reason: e.message }; }
    if (plan.reason) { log(`decoding in one piece (${plan.reason})`); plan = null; }
  }
  if (plan) {
    if (plan.tiles.length > MAX_TILES) throw new LimitError(`image has too many tiles (${plan.tiles.length})`);
    checkPixels(plan.width, plan.height);
  } else if (m && primarySize(m)) {
    checkPixels(...primarySize(m));
  }
  const fullSize = plan ? [plan.width, plan.height] : (m && primarySize(m));

  // 1) Quick preview from the small image embedded in the file.
  let preview = null;
  if (m) {
    let job;
    try { job = thumbnailJob(m); } catch (e) { job = { reason: e.message }; }
    if (job.reason) {
      log(`no preview: ${job.reason}`, describe(m));
    } else {
      try {
        preview = await pool.decode(job.heic.buffer);
        if (stale(gen)) { preview.close(); return; }
        const k = fullSize
          ? Math.max(...fullSize) / Math.max(preview.width, preview.height)
          : 10; // unknown size: assume large so Fit fills the view
        log(`preview ${preview.width}×${preview.height} shown after ${ms()} ms`);
        drawBitmap(preview, Math.round(preview.width * k), Math.round(preview.height * k));
        showCanvas();
        phase.textContent = 'Preview · loading full image…';
        phase.hidden = false;
        layout(false);
        await nextPaint();
        if (stale(gen)) { preview.close(); return; }
      } catch (e) {
        if (e.message === 'cancelled' || stale(gen)) return;
        if (e instanceof LimitError) throw e;
        log('preview decode failed:', e.message);
        preview = null;
      }
    }
  }

  // 2) Full resolution.
  try {
    if (plan) {
      try {
        await decodeTiles(pool, plan, preview, gen, ms);
        if (!stale(gen)) finish();
        return;
      } catch (e) {
        if (stale(gen) || e.message === 'cancelled') return;
        if (e instanceof LimitError) throw e; // over a limit: never retry the whole file
        log(`tiled decode failed (${e.message}); decoding in one piece`);
        pool.cancelPending();
      }
    }
    const bmp = await pool.decode(buf);
    if (stale(gen)) { bmp.close(); return; }
    log(`full ${bmp.width}×${bmp.height} shown after ${ms()} ms`);
    const hadPreview = !wrap.hidden;
    drawBitmap(bmp, bmp.width, bmp.height);
    bmp.close();
    showCanvas();
    layout(hadPreview && !fit);
    finish();
  } finally {
    preview?.close();
  }
}

/** Decode all grid tiles in parallel, painting each one as it arrives. */
async function decodeTiles(pool, plan, preview, gen, ms) {
  const { width, height, matrix, gridW, gridH, tiles } = plan;
  const hadPreview = !wrap.hidden;
  cv.width = width;
  cv.height = height;
  natW = width;
  natH = height;
  const ctx = cv.getContext('2d');
  if (preview) ctx.drawImage(preview, 0, 0, width, height); // blurry until tiles land
  else { ctx.fillStyle = '#e8eaec'; ctx.fillRect(0, 0, width, height); }
  showCanvas();
  layout(hadPreview && !fit);

  let done = 0;
  let abandoned = false;
  phase.hidden = false;
  phase.textContent = `Sharpening… 0/${tiles.length}`;
  try {
    await Promise.all(tiles.map((t) => pool.decode(t.heic.buffer).then((bmp) => {
      if (abandoned || stale(gen)) { bmp.close(); return; }
      ctx.save();
      ctx.setTransform(...matrix);
      ctx.beginPath();
      ctx.rect(0, 0, gridW, gridH); // edge tiles overhang the real image size
      ctx.clip();
      ctx.drawImage(bmp, t.x, t.y);
      ctx.restore();
      bmp.close();
      phase.textContent = `Sharpening… ${++done}/${tiles.length}`;
    })));
  } catch (e) {
    abandoned = true; // late tiles must not paint over whatever comes next
    throw e;
  }
  log(`full ${width}×${height} shown after ${ms()} ms (${tiles.length} tiles, ${pool.size || 'several'} workers)`);
}

function finish() {
  showCanvas();
  phase.hidden = true;
  if (!natW) return;
  layout(false);
  $('save').disabled = false;
}

// ---------------------------------------------------------------------------
// Download (with the teacher's Canvas login), bounded in size.
// ---------------------------------------------------------------------------
async function download(url, pageOrigin) {
  setStatus('Downloading from Canvas…');
  downloadCtrl?.abort();
  const ctrl = new AbortController();
  downloadCtrl = ctrl;
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Includes redirects to hosts the extension isn't allowed to read.
    throw new Error('the file couldn\'t be downloaded from Canvas (network error or unexpected file server)');
  }
  // Canvas redirects downloads to its file servers; refuse anywhere else.
  if (!isAllowedFinalUrl(res.url, pageOrigin)) {
    ctrl.abort();
    throw new Error('Canvas sent the file from an unexpected address, so it was not opened.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Canvas didn\'t allow the download. Your login may have expired; reload the page.');
  }
  if (!res.ok) throw new Error(`Canvas returned ${res.status} ${res.statusText}`);
  if ((res.headers.get('content-type') || '').includes('text/html')) {
    throw new Error('Canvas returned a web page instead of the file. Your login may have expired; reload the page.');
  }
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_FILE_BYTES) { ctrl.abort(); throw new LimitError('file is too large to preview'); }
  // Count bytes as they arrive (the declared length may be missing or wrong).
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FILE_BYTES) { ctrl.abort(); throw new LimitError('file is too large to preview'); }
    chunks.push(value);
  }
  log(`downloaded ${(total / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t0)} ms`);
  return new Blob(chunks);
}

function explain(err) {
  if (err instanceof LimitError) return `This file can't be previewed safely: ${err.message}. Download it instead.`;
  return `Couldn't show this file: ${err.message}`;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
$('fit').addEventListener('click', () => { fit = true; layout(false); });
$('zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
$('zoom-out').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
$('rotate').addEventListener('click', () => { rotation = (rotation + 90) % 360; layout(); });

/** The image as shown: full resolution, with the on-screen rotation applied. */
function exportCanvas() {
  if (!rotation) return cv;
  const out = document.createElement('canvas');
  const turned = rotation % 180 !== 0;
  out.width = turned ? cv.height : cv.width;
  out.height = turned ? cv.width : cv.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(cv, -cv.width / 2, -cv.height / 2);
  return out;
}

$('save').addEventListener('click', () => {
  const gen = displayGen;
  const name = (fileName || 'image').replace(/\.(heic|heif)$/i, '') + '.jpg';
  exportCanvas().toBlob((b) => {
    if (gen !== displayGen) return;
    if (!b) { setStatus('Saving failed: the image could not be converted to JPG.', true); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }, 'image/jpeg', 0.92);
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
    // Ask the Canvas page (our content script) to close the pop-up viewer.
    window.parent.postMessage({ type: 'heic-viewer-close' }, location.ancestorOrigins?.[0] || '*');
  } else if (e.key === 'r' || e.key === 'R') $('rotate').click();
  else if (e.key === 'f' || e.key === 'F') $('fit').click();
  else if (e.key === '+' || e.key === '=') $('zoom-in').click();
  else if (e.key === '-') $('zoom-out').click();
});
// Ctrl/⌘ + scroll wheel zooms
stage.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !natW) return;
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });
new ResizeObserver(() => { if (fit) layout(false); }).observe(stage);

window.addEventListener('pagehide', () => {
  displayGen++;
  downloadCtrl?.abort();
  poolPromise?.then((p) => p.close());
});

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname); // tickets are single-use anyway

async function openTicket(ticket) {
  getPool(); // start connecting to the decoder while we download
  const job = await chrome.runtime.sendMessage({ type: 'redeem-ticket', ticket });
  if (!job || job.error) throw new Error(job?.error || 'no response from the extension');
  resetView(job.name);
  const blob = await download(job.url, job.pageOrigin);
  await display(blob, job.name);
}

if (params.get('t')) {
  openTicket(params.get('t')).catch((err) => {
    if (err.name === 'AbortError') return;
    console.warn('[HEIC Viewer]', err.message);
    phase.hidden = true;
    setStatus(explain(err), true);
  });
} else if (params.get('error')) {
  setStatus(`Couldn't open this file: ${params.get('error')}`, true);
} else if (window.parent !== window) {
  setStatus('Nothing to show.', true); // embedded without a ticket: do nothing
} else {
  // Standalone test mode (opened from the Options page): pick a HEIC file from this computer.
  setStatus('');
  $('picker').hidden = false;
  $('file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) {
      display(f, f.name).catch((err) => {
        phase.hidden = true;
        setStatus(explain(err), true);
      });
    }
  });
}
