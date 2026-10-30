// Long-lived, invisible frame that keeps a warm pool of decoder workers for
// the whole SpeedGrader session. Viewer frames find it and connect to it
// directly; every message must come from this extension's own origin, which
// web pages cannot imitate.

import { LocalPool } from './decoder-pool.js';
import { MAX_FILE_BYTES } from './limits.js';

const pool = new LocalPool();
pool.warm();

let session = 0;

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.source) return; // only our own viewer frames
  const msg = e.data;
  if (msg?.type === 'heic-host-ping' && typeof msg.nonce === 'string') {
    e.source.postMessage({ type: 'heic-host-here', nonce: msg.nonce }, location.origin);
    return;
  }
  if (msg?.type !== 'heic-connect' || !e.ports[0]) return;

  const port = e.ports[0];
  const mine = ++session;
  pool.cancelOthers(mine); // a new viewer opened: stop queued work for old ones
  port.onmessage = ({ data }) => {
    if (data?.type === 'cancel') { pool.cancelPending(mine); return; }
    if (data?.type !== 'decode' || !Number.isSafeInteger(data.id) ||
        !(data.buf instanceof ArrayBuffer) || data.buf.byteLength > MAX_FILE_BYTES) {
      if (Number.isSafeInteger(data?.id)) port.postMessage({ id: data.id, error: 'invalid request' });
      return;
    }
    pool.decode(data.buf, { session: mine }).then(
      (bitmap) => port.postMessage({ id: data.id, bitmap }, [bitmap]),
      (err) => port.postMessage({ id: data.id, error: err.name === 'LimitError' ? `LIMIT: ${err.message}` : err.message }),
    );
  };
  port.postMessage({ type: 'hello', size: pool.size });
});
