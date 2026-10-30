// HEIC Viewer — viewer page (runs as an extension page, embedded in SpeedGrader).
// Fetches the submission file directly from Canvas using the teacher's own
// session, decodes it locally with libheif (WebAssembly), and draws it.
// No data leaves the browser and nothing is stored.

import { isHeicHevc, parseHeif, thumbnailJob, gridPlan, describe, primarySize } from './heif.js';
import { LocalPool, RemotePool } from './decoder-pool.js';

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

// The decoder: normally a warm worker pool in the long-lived decoder-host
// frame (the content script hands us a port to it); if that doesn't arrive,
// e.g. when this page is opened on its own, start a local pool instead.
const hasSrc = new URLSearchParams(location.hash.slice(1)).has('src');
const poolPromise = new Promise((resolve) => {
  const fallback = setTimeout(() => {
    const p = new LocalPool();
    p.warm();
    resolve(p);
  }, hasSrc ? 1500 : 0);
  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'heic-decoder-port' || !e.ports[0]) return;
    clearTimeout(fallback);
    resolve(new RemotePool(e.ports[0]));
  });
});
window.addEventListener('pagehide', () => poolPromise.then((p) => p.close?.()));

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

async function display(blob, name) {
  fileName = name || '';
  $('name').textContent = fileName;
  document.title = fileName ? `HEIC preview – ${fileName}` : 'HEIC preview';
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', fileName || 'Submitted image');
  setStatus('Decoding image…');

  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const buf = await blob.arrayBuffer();

  if (!isHeicHevc(buf)) {
    log('not a HEIC file; using the browser\'s own decoder');
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    drawBitmap(bmp, bmp.width, bmp.height);
    bmp.close();
    return finish(ms);
  }

  const pool = await poolPromise;
  let m = null;
  try { m = parseHeif(buf); } catch (e) { log('could not read file structure:', e.message); }

  // Plan the full decode: split a tiled image across the worker pool.
  let plan = null;
  if (m) {
    try { plan = gridPlan(m); } catch (e) { plan = { reason: e.message }; }
    if (plan.reason) { log(`decoding in one piece (${plan.reason})`); plan = null; }
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
      } catch (e) {
        log('preview decode failed:', e.message);
        preview = null;
      }
    }
  }

  // 2) Full resolution.
  if (plan) {
    try {
      await decodeTiles(pool, plan, preview, ms);
      preview?.close();
      return finish(ms);
    } catch (e) {
      if (e.message === 'cancelled') return;
      log(`tiled decode failed (${e.message}); decoding in one piece`);
    }
  }
  const bmp = await pool.decode(buf);
  log(`full ${bmp.width}×${bmp.height} shown after ${ms()} ms`);
  const hadPreview = !wrap.hidden;
  drawBitmap(bmp, bmp.width, bmp.height);
  bmp.close();
  preview?.close();
  showCanvas();
  layout(hadPreview && !fit);
  finish(ms);
}

/** Decode all grid tiles in parallel, painting each one as it arrives. */
async function decodeTiles(pool, plan, preview, ms) {
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
  phase.hidden = false;
  phase.textContent = `Sharpening… 0/${tiles.length}`;
  await Promise.all(tiles.map((t) => pool.decode(t.heic.buffer).then((bmp) => {
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
  log(`full ${width}×${height} shown after ${ms()} ms (${tiles.length} tiles, ${pool.size || 'several'} workers)`);
}

function finish() {
  showCanvas();
  phase.hidden = true;
  if (!natW) return;
  layout(false);
  $('save').disabled = false;
}

async function loadFromUrl(src, name) {
  setStatus('Downloading from Canvas…');
  const t0 = performance.now();
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error(`Canvas returned ${res.status} ${res.statusText}`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/html')) {
    throw new Error('Canvas returned a web page instead of the file (are you still logged in?)');
  }
  const blob = await res.blob();
  console.info(`[HEIC Viewer] downloaded ${(blob.size / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t0)} ms`);
  await display(blob, name);
}

// --- controls --------------------------------------------------------------
$('fit').addEventListener('click', () => { fit = true; layout(false); });
$('zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
$('zoom-out').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
$('rotate').addEventListener('click', () => { rotation = (rotation + 90) % 360; layout(); });
$('save').addEventListener('click', () => {
  cv.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = (fileName || 'image').replace(/\.(heic|heif)$/i, '') + '.jpg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }, 'image/jpeg', 0.92);
});
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'r' || e.key === 'R') $('rotate').click();
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

// --- entry -----------------------------------------------------------------
const params = new URLSearchParams(location.hash.slice(1));
const src = params.get('src');
const name = params.get('name') || '';

if (src) {
  loadFromUrl(src, name).catch((err) => {
    console.error(err);
    setStatus(`Couldn't show this file: ${err.message}`, true);
  });
} else {
  // Standalone test mode: open viewer.html directly and pick a local file.
  setStatus('');
  $('picker').hidden = false;
  $('file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) display(f, f.name).catch((err) => setStatus(`Decode failed: ${err.message}`, true));
  });
}
