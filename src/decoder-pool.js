// A pool of decoder workers sharing one compiled copy of libheif.
// LocalPool runs the workers itself; RemotePool talks to a pool that lives in
// the long-lived decoder-host frame (so it stays warm between students).

const WASM_URL = chrome.runtime.getURL('libheif.wasm');
const WORKER_URL = chrome.runtime.getURL('decoder-worker.js');
const IDLE_MS = 10 * 60 * 1000; // free the workers' memory after 10 idle minutes

let modulePromise = null;
const compileOnce = () =>
  (modulePromise ??= WebAssembly.compileStreaming(fetch(WASM_URL)));

export function defaultWorkerCount() {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(6, cores - 1));
}

export class LocalPool {
  constructor(size = defaultWorkerCount()) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.nextId = 1;
    this.idleTimer = null;
  }

  /** Start compiling + spawning now so the first decode doesn't wait. */
  warm() {
    compileOnce().then((module) => {
      while (this.workers.length < this.size) this.#spawn(module);
    }).catch((e) => console.warn('[HEIC Viewer] decoder failed to load:', e));
  }

  #spawn(module) {
    const w = new Worker(WORKER_URL);
    const slot = { w, busy: null, ready: false };
    w.onmessage = ({ data }) => {
      if (data.type === 'ready') { slot.ready = true; this.#pump(); return; }
      if (data.type === 'init-error') { console.warn('[HEIC Viewer] worker init failed:', data.error); return; }
      const job = slot.busy;
      slot.busy = null;
      if (job && job.id === data.id) {
        if (data.error) job.reject(new Error(data.error));
        else job.resolve(data.bitmap);
      }
      this.#pump();
    };
    w.onerror = (e) => {
      console.warn('[HEIC Viewer] worker error:', e.message);
      slot.busy?.reject(new Error(e.message || 'worker crashed'));
      slot.busy = null;
    };
    w.postMessage({ type: 'init', module });
    this.workers.push(slot);
  }

  /** Decode a HEIC (ArrayBuffer, transferred) → ImageBitmap. */
  decode(buf, { session = 0 } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, buf, session, resolve, reject });
      clearTimeout(this.idleTimer);
      if (this.workers.length < this.size) this.warm();
      this.#pump();
    });
  }

  /** Drop queued (not yet started) jobs that don't belong to `keepSession`. */
  cancelOthers(keepSession) {
    this.queue = this.queue.filter((j) => {
      if (j.session === keepSession) return true;
      j.reject(new Error('cancelled'));
      return false;
    });
  }

  cancelSession(session) {
    this.queue = this.queue.filter((j) => {
      if (j.session !== session) return true;
      j.reject(new Error('cancelled'));
      return false;
    });
  }

  #pump() {
    for (const slot of this.workers) {
      if (!this.queue.length) break;
      if (!slot.ready || slot.busy) continue;
      const job = this.queue.shift();
      slot.busy = job;
      slot.w.postMessage({ id: job.id, buf: job.buf }, [job.buf]);
    }
    if (!this.queue.length && this.workers.every((s) => !s.busy)) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.#shutdown(), IDLE_MS);
    }
  }

  #shutdown() {
    for (const s of this.workers) s.w.terminate();
    this.workers = [];
  }
}

/** Client for a pool living in another frame, reached through a MessagePort. */
export class RemotePool {
  constructor(port) {
    this.port = port;
    this.pending = new Map();
    this.nextId = 1;
    this.size = 0;
    port.onmessage = ({ data }) => {
      if (data.type === 'hello') { this.size = data.size; return; }
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.bitmap);
    };
  }

  decode(buf) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ id, buf }, [buf]);
    });
  }

  close() {
    try { this.port.postMessage({ type: 'cancel' }); } catch { /* ignore */ }
  }
}
