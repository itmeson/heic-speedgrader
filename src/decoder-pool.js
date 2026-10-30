// A pool of decoder workers sharing one compiled copy of libheif.
// LocalPool runs the workers itself; RemotePool talks to a pool that lives in
// the long-lived decoder-host frame (so it stays warm between students).
//
// Every request settles: on success, on a decoder error, on a worker crash,
// on a failed start, on timeout (the worker is terminated and replaced), on
// cancel, or on close.

import { DECODE_TIMEOUT_MS, LimitError, MAX_FILE_BYTES } from './limits.js';

const WASM_URL = chrome.runtime.getURL('libheif.wasm');
const WORKER_URL = chrome.runtime.getURL('decoder-worker.js');
const IDLE_MS = 10 * 60 * 1000; // free the workers' memory after 10 idle minutes
const MAX_RESTARTS = 5;          // per pool, before giving up

let modulePromise = null;
function compileOnce() {
  modulePromise ??= WebAssembly.compileStreaming(fetch(WASM_URL)).catch((e) => {
    modulePromise = null; // allow a later retry
    throw e;
  });
  return modulePromise;
}

export function defaultWorkerCount() {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(6, cores - 1));
}

export function errorFrom(message) {
  const m = String(message || 'decode failed');
  return m.startsWith('LIMIT:') ? new LimitError(m.slice(6).trim()) : new Error(m);
}

export class LocalPool {
  constructor(size = defaultWorkerCount()) {
    this.size = size;
    this.slots = [];      // { w, state: 'starting'|'ready'|'busy', job, timer }
    this.queue = [];
    this.nextId = 1;
    this.restarts = 0;
    this.closed = false;
    this.idleTimer = null;
  }

  /** Start compiling + spawning now so the first decode doesn't wait. */
  warm() {
    if (this.closed) return;
    compileOnce().then(
      (module) => { while (!this.closed && this.slots.length < this.size) this.#spawn(module); },
      (e) => this.#failAll(new Error(`decoder failed to load: ${e.message}`)),
    );
  }

  #spawn(module) {
    const slot = { w: new Worker(WORKER_URL), state: 'starting', job: null, timer: null };
    slot.w.onmessage = ({ data }) => this.#onMessage(slot, data);
    slot.w.onerror = (e) => { e.preventDefault?.(); this.#kill(slot, new Error(e.message || 'decoder crashed')); };
    slot.w.onmessageerror = () => this.#kill(slot, new Error('decoder sent an unreadable reply'));
    slot.w.postMessage({ type: 'init', module });
    this.slots.push(slot);
  }

  #onMessage(slot, data) {
    if (data?.type === 'ready') { slot.state = 'ready'; this.#pump(); return; }
    if (data?.type === 'init-error') { this.#kill(slot, new Error(`decoder failed to start: ${data.error}`)); return; }
    const job = slot.job;
    if (!job || data?.id !== job.id) return;
    clearTimeout(slot.timer);
    slot.job = null;
    slot.state = 'ready';
    if (data.error) job.reject(errorFrom(data.error));
    else if (data.bitmap instanceof ImageBitmap) job.resolve(data.bitmap);
    else job.reject(new Error('decoder sent an invalid reply'));
    this.#pump();
  }

  /** Remove a broken/hung worker, fail its job, and replace it (bounded). */
  #kill(slot, error) {
    clearTimeout(slot.timer);
    slot.w.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
    slot.job?.reject(error);
    slot.job = null;
    if (this.closed) return;
    if (++this.restarts > MAX_RESTARTS) { this.#failAll(new Error('decoder keeps failing; reload the page')); return; }
    if (this.queue.length) this.warm();
    this.#pump();
  }

  #failAll(error) {
    for (const job of this.queue.splice(0)) job.reject(error);
  }

  /** Decode a HEIC (ArrayBuffer, transferred) → ImageBitmap. */
  decode(buf, { session = 0 } = {}) {
    if (this.closed) return Promise.reject(new Error('decoder closed'));
    if (!(buf instanceof ArrayBuffer) || buf.byteLength > MAX_FILE_BYTES) {
      return Promise.reject(new LimitError('file is too large'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, buf, session, resolve, reject });
      clearTimeout(this.idleTimer);
      if (this.slots.length < this.size) this.warm();
      this.#pump();
    });
  }

  /** Drop queued (not started) jobs, optionally only one session's. */
  cancelPending(session) {
    this.queue = this.queue.filter((j) => {
      if (session !== undefined && j.session !== session) return true;
      j.reject(new Error('cancelled'));
      return false;
    });
  }

  /** Drop queued jobs of every session except `keep`. */
  cancelOthers(keep) {
    this.queue = this.queue.filter((j) => {
      if (j.session === keep) return true;
      j.reject(new Error('cancelled'));
      return false;
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.cancelPending();
    for (const s of this.slots) { clearTimeout(s.timer); s.w.terminate(); s.job?.reject(new Error('closed')); }
    this.slots = [];
  }

  #pump() {
    for (const slot of this.slots) {
      if (!this.queue.length) break;
      if (slot.state !== 'ready') continue;
      const job = this.queue.shift();
      slot.job = job;
      slot.state = 'busy';
      // A synchronous WASM decode can't be interrupted, only stopped with its worker.
      slot.timer = setTimeout(() => this.#kill(slot, new LimitError('the image took too long to decode')), DECODE_TIMEOUT_MS);
      slot.w.postMessage({ id: job.id, buf: job.buf }, [job.buf]);
    }
    if (!this.queue.length && this.slots.every((s) => s.state !== 'busy')) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        for (const s of this.slots) s.w.terminate();
        this.slots = [];
        this.restarts = 0;
      }, IDLE_MS);
    }
  }
}

/** Client for a pool living in another frame, reached through a MessagePort. */
export class RemotePool {
  constructor(port) {
    this.port = port;
    this.pending = new Map();
    this.nextId = 1;
    this.size = 0;
    this.closed = false;
    port.onmessage = ({ data }) => {
      if (data?.type === 'hello') { this.size = Number(data.size) || 0; return; }
      const p = this.pending.get(data?.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) p.reject(errorFrom(data.error));
      else if (data.bitmap instanceof ImageBitmap) p.resolve(data.bitmap);
      else p.reject(new Error('decoder sent an invalid reply'));
    };
    port.onmessageerror = () => this.#failAll(new Error('decoder connection failed'));
  }

  #failAll(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  decode(buf) {
    if (this.closed) return Promise.reject(new Error('decoder closed'));
    if (!(buf instanceof ArrayBuffer) || buf.byteLength > MAX_FILE_BYTES) {
      return Promise.reject(new LimitError('file is too large'));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // Safety net in case the host frame disappears; the host enforces the real deadline.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('decoder did not respond'));
      }, DECODE_TIMEOUT_MS * 3);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ type: 'decode', id, buf }, [buf]);
    });
  }

  /** Ask the host to drop this viewer's queued jobs (running ones finish). */
  cancelPending() {
    if (!this.closed) this.port.postMessage({ type: 'cancel' });
  }

  close() {
    if (this.closed) return;
    this.cancelPending();
    this.closed = true;
    this.#failAll(new Error('closed'));
    this.port.close();
  }
}
