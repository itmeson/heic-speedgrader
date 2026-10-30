// Long-lived, invisible frame that keeps a warm pool of decoder workers for
// the whole SpeedGrader session. Each viewer frame gets a MessagePort to it
// (handed over by the content script) and sends decode jobs through it.

import { LocalPool } from './decoder-pool.js';

const pool = new LocalPool();
pool.warm();

let session = 0;

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'heic-decoder-port' || !e.ports[0]) return;
  const port = e.ports[0];
  const mine = ++session;
  pool.cancelOthers(mine); // a new viewer opened: stop work for old ones
  port.onmessage = ({ data }) => {
    if (data.type === 'cancel') { pool.cancelSession(mine); return; }
    pool.decode(data.buf, { session: mine }).then(
      (bitmap) => port.postMessage({ id: data.id, bitmap }, [bitmap]),
      (err) => port.postMessage({ id: data.id, error: err.message }),
    );
  };
  port.postMessage({ type: 'hello', size: pool.size });
});
