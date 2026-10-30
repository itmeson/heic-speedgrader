// Minimal HEIF/HEIC container reader + writer.
//
// HEIC is an ISO-BMFF file: a `meta` box lists items (iinf), where their bytes
// live (iloc), how they relate (iref: 'dimg' = "is built from", 'thmb' = "is a
// thumbnail of"), and their properties (iprp: hvcC decoder config, ispe size,
// irot/imir/clap transforms, ...). Phone photos store the main picture as a
// 'grid' of independently-coded 512×512 tiles plus a small thumbnail.
//
// We use that structure to (1) pull out the thumbnail for an instant preview
// and (2) split the grid into single-tile mini-HEICs that several decoder
// workers can process in parallel.

const td = new TextDecoder('latin1');
const TRANSFORMS = ['clap', 'irot', 'imir'];

// Structural limits: far above what any camera writes, low enough that a
// hostile file can't make the parser do unbounded work.
const MAX_BOXES = 10_000;
const MAX_ITEMS = 4_096;
const MAX_REFS = 8_192;
const MAX_PROPS = 4_096;
const MAX_EXTENTS = 64;

export class HeifFormatError extends Error {
  constructor(message) { super(message); this.name = 'HeifFormatError'; }
}
const fail = (msg) => { throw new HeifFormatError(msg); };

function* boxes(view, start, end) {
  let p = start;
  let n = 0;
  while (p + 8 <= end) {
    if (++n > MAX_BOXES) fail('too many boxes');
    let size = view.getUint32(p);
    const type = td.decode(new Uint8Array(view.buffer, view.byteOffset + p + 4, 4));
    let header = 8;
    if (size === 1) {
      const big = view.getBigUint64(p + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('box too large');
      size = Number(big);
      header = 16;
    }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) return;
    yield { type, start: p, body: p + header, end: p + size };
    p += size;
  }
}

function readN(view, p, n) {
  if (n === 0) return 0;
  if (n === 1) return view.getUint8(p);
  if (n === 2) return view.getUint16(p);
  if (n === 4) return view.getUint32(p);
  if (n === 8) {
    const big = view.getBigUint64(p);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('offset too large');
    return Number(big);
  }
  throw new Error(`bad int size ${n}`);
}

/** Returns the ftyp major brand + compatible brands, or null if not ISO-BMFF. */
export function brands(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 16) return null;
  const first = boxes(view, 0, Math.min(view.byteLength, 4096)).next().value;
  if (!first || first.type !== 'ftyp') return null;
  const list = [];
  for (let p = first.body; p + 4 <= first.end; p += 4) {
    if (p === first.body + 4) continue; // minor_version
    list.push(td.decode(new Uint8Array(buffer, p, 4)));
  }
  return list;
}

export function isHeicHevc(buffer) {
  const b = brands(buffer);
  return !!b && b.some((x) => ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(x)) &&
    !b.includes('avif');
}

export function parseHeif(buffer) {
  const view = new DataView(buffer);
  let meta = null;
  for (const b of boxes(view, 0, view.byteLength)) if (b.type === 'meta') { meta = b; break; }
  if (!meta) return null;
  const m = { buffer, view, primary: 0, types: new Map(), locs: new Map(), refs: [], props: [], assoc: new Map(), idat: null };
  for (const b of boxes(view, meta.body + 4, meta.end)) { // meta is a FullBox
    const v = view.getUint8(b.body);
    let p = b.body + 4;
    switch (b.type) {
      case 'pitm':
        m.primary = v === 0 ? view.getUint16(p) : view.getUint32(p);
        break;
      case 'iinf': {
        p += v === 0 ? 2 : 4;
        for (const e of boxes(view, p, b.end)) {
          if (e.type !== 'infe') continue;
          const ev = view.getUint8(e.body);
          if (ev < 2) continue;
          let q = e.body + 4;
          const id = ev === 2 ? view.getUint16(q) : view.getUint32(q);
          q += (ev === 2 ? 2 : 4) + 2;
          if (m.types.size >= MAX_ITEMS) fail('too many items');
          m.types.set(id, td.decode(new Uint8Array(buffer, q, 4)));
        }
        break;
      }
      case 'iloc': {
        const a = view.getUint8(p), c = view.getUint8(p + 1);
        const offSize = a >> 4, lenSize = a & 15, baseSize = c >> 4, idxSize = v >= 1 ? c & 15 : 0;
        p += 2;
        const count = v < 2 ? view.getUint16(p) : view.getUint32(p);
        p += v < 2 ? 2 : 4;
        if (count > MAX_ITEMS) fail('too many item locations');
        for (let i = 0; i < count; i++) {
          const id = v < 2 ? view.getUint16(p) : view.getUint32(p);
          p += v < 2 ? 2 : 4;
          let method = 0;
          if (v >= 1) { method = view.getUint16(p) & 15; p += 2; }
          p += 2; // data_reference_index
          const base = readN(view, p, baseSize); p += baseSize;
          const n = view.getUint16(p); p += 2;
          if (n > MAX_EXTENTS) fail('too many extents');
          const extents = [];
          for (let k = 0; k < n; k++) {
            p += idxSize;
            const off = readN(view, p, offSize); p += offSize;
            const len = readN(view, p, lenSize); p += lenSize;
            extents.push([base + off, len]);
          }
          m.locs.set(id, { method, extents });
        }
        break;
      }
      case 'iref':
        for (const r of boxes(view, p, b.end)) {
          let q = r.body;
          const w = v === 0 ? 2 : 4;
          const from = w === 2 ? view.getUint16(q) : view.getUint32(q);
          q += w;
          const n = view.getUint16(q); q += 2;
          if (m.refs.length >= MAX_REFS || n > MAX_REFS) fail('too many references');
          const to = [];
          for (let k = 0; k < n; k++) { to.push(w === 2 ? view.getUint16(q) : view.getUint32(q)); q += w; }
          m.refs.push({ type: r.type, from, to });
        }
        break;
      case 'iprp':
        for (const c of boxes(view, b.body, b.end)) {
          if (c.type === 'ipco') {
            for (const pr of boxes(view, c.body, c.end)) {
              if (m.props.length >= MAX_PROPS) fail('too many properties');
              m.props.push(pr);
            }
          } else if (c.type === 'ipma') {
            const cv = view.getUint8(c.body), flags = view.getUint8(c.body + 3);
            let q = c.body + 4;
            const n = view.getUint32(q); q += 4;
            if (n > MAX_ITEMS) fail('too many property associations');
            for (let k = 0; k < n; k++) {
              const id = cv < 1 ? view.getUint16(q) : view.getUint32(q);
              q += cv < 1 ? 2 : 4;
              const cnt = view.getUint8(q++);
              const list = m.assoc.get(id) || [];
              for (let j = 0; j < cnt; j++) {
                const raw = flags & 1 ? view.getUint16(q) : view.getUint8(q);
                q += flags & 1 ? 2 : 1;
                const bits = flags & 1 ? 15 : 7;
                const index = raw & ((1 << bits) - 1);
                if (index > 0) list.push({ essential: raw >> bits, index });
              }
              m.assoc.set(id, list);
            }
          }
        }
        break;
      case 'idat':
        m.idat = b;
        break;
    }
  }
  return m;
}

// --- helpers on a parsed file ------------------------------------------------
const prop = (m, a) => m.props[a.index - 1];
const propsOf = (m, id) => (m.assoc.get(id) || []).filter((a) => prop(m, a));
const findProp = (m, id, type) => propsOf(m, id).map((a) => prop(m, a)).find((p) => p.type === type);
const refsFrom = (m, id, type) => m.refs.find((r) => r.type === type && r.from === id)?.to || [];

function itemBytes(m, id) {
  const loc = m.locs.get(id);
  if (!loc || loc.method > 1 || (loc.method === 1 && !m.idat)) fail(`item ${id}: unsupported location`);
  const base = loc.method === 1 ? m.idat.body : 0;
  const limit = loc.method === 1 ? m.idat.end : m.buffer.byteLength;
  return u8(...loc.extents.map(([o, l]) => {
    if (base + o + l > limit) fail(`item ${id}: data outside the file`);
    return new Uint8Array(m.buffer, base + o, l);
  }));
}

function ispe(m, id) {
  const p = findProp(m, id, 'ispe');
  if (!p) return null;
  const w = m.view.getUint32(p.body + 4), h = m.view.getUint32(p.body + 8);
  return w > 0 && h > 0 ? [w, h] : null;
}

// --- writing a single-image HEIC --------------------------------------------
const enc = new TextEncoder();
function u8(...parts) {
  const len = parts.reduce((s, x) => s + x.length, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}
const be = (n, bytes) => { const a = new Uint8Array(bytes); for (let i = bytes - 1; i >= 0; i--) { a[i] = n & 255; n = Math.floor(n / 256); } return a; };
const box = (type, ...payload) => { const body = u8(...payload); return u8(be(body.length + 8, 4), enc.encode(type), body); };
const full = (type, v, flags, ...payload) => box(type, u8([v], be(flags, 3)), ...payload);

/** A standalone HEIC whose only (primary) item is `id`, with the given property associations. */
function singleItemHeic(m, id, assocs) {
  if (!assocs.some((a) => prop(m, a).type === 'hvcC')) throw new Error(`item ${id}: no hvcC`);
  if (assocs.length > 127) throw new Error('too many properties');
  const data = itemBytes(m, id);
  const propBytes = (a) => { const p = prop(m, a); return new Uint8Array(m.buffer, p.start, p.end - p.start); };
  const build = (dataOffset) => u8(
    box('ftyp', enc.encode('heic'), be(0, 4), enc.encode('mif1'), enc.encode('heic')),
    full('meta', 0, 0,
      full('hdlr', 0, 0, be(0, 4), enc.encode('pict'), be(0, 12), [0]),
      full('pitm', 0, 0, be(1, 2)),
      full('iloc', 0, 0, [0x44, 0x00], be(1, 2), be(1, 2), be(0, 2), be(1, 2), be(dataOffset, 4), be(data.length, 4)),
      full('iinf', 0, 0, be(1, 2), full('infe', 2, 0, be(1, 2), be(0, 2), enc.encode('hvc1'), [0])),
      box('iprp',
        box('ipco', ...assocs.map(propBytes)),
        full('ipma', 0, 0, be(1, 4), be(1, 2), [assocs.length], assocs.map((a, i) => (a.essential << 7) | (i + 1))),
      ),
    ),
  );
  const head = build(0);
  return u8(build(head.length + 8), box('mdat', data));
}

// --- transforms (clap / irot / imir) as a 2-D affine matrix ------------------
/** Matrix [a,b,c,d,e,f] (x' = a·x + c·y + e, y' = b·x + d·y + f) and output size. */
function transformMatrix(m, transforms, w, h) {
  let M = [1, 0, 0, 1, 0, 0];
  const then = (N) => { // M := N ∘ M
    const [a, b, c, d, e, f] = M, [A, B, C, D, E, F] = N;
    M = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  };
  const v = m.view;
  for (const p of transforms) {
    if (p.type === 'clap') {
      const r = (i) => v.getInt32(p.body + i * 4);
      const u = (i) => v.getUint32(p.body + i * 4);
      if (!u(1) || !u(3) || !u(5) || !u(7)) fail('crop has a zero denominator');
      const cw = Math.round(u(0) / u(1));
      const ch = Math.round(u(2) / u(3));
      const offX = r(4) / u(5), offY = r(6) / u(7);
      // same rounding as libheif (left rounds down, top rounds half-up)
      const left = Math.floor(offX + (w - 1) / 2 - (cw - 1) / 2);
      const top = Math.round(offY + (h - 1) / 2 - (ch - 1) / 2);
      if (!(cw > 0 && ch > 0 && left >= 0 && top >= 0 && left + cw <= w && top + ch <= h)) fail('crop is outside the image');
      then([1, 0, 0, 1, -left, -top]);
      w = cw; h = ch;
    } else if (p.type === 'irot') {
      const angle = (v.getUint8(p.body) & 3) * 90; // counter-clockwise
      if (angle === 90) { then([0, -1, 1, 0, 0, w]); [w, h] = [h, w]; }
      else if (angle === 180) then([-1, 0, 0, -1, w, h]);
      else if (angle === 270) { then([0, 1, -1, 0, h, 0]); [w, h] = [h, w]; }
    } else if (p.type === 'imir') {
      // axis bit as libheif interprets it: 0 = flip top↔bottom, 1 = flip left↔right
      if (v.getUint8(p.body) & 1) then([-1, 0, 0, 1, w, 0]);
      else then([1, 0, 0, -1, 0, h]);
    }
  }
  return { matrix: M, width: w, height: h };
}

// --- public: thumbnail -------------------------------------------------------
/** @returns {{heic: Uint8Array} | {reason: string}} */
export function thumbnailJob(m) {
  const thumbs = m.refs.filter((r) => r.type === 'thmb' && m.types.get(r.from) === 'hvc1');
  // things the primary is built from (edited photos: primary 'iden' → grid)
  const related = new Set([m.primary]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of m.refs) {
      if (['dimg', 'base'].includes(r.type) && related.has(r.from)) {
        for (const t of r.to) if (!related.has(t)) { related.add(t); grew = true; }
      }
    }
  }
  thumbs.sort((a, b) => Number(b.to.includes(m.primary)) - Number(a.to.includes(m.primary)));
  const ref = thumbs.find((t) => t.to.some((id) => related.has(id))) || thumbs[0];
  if (!ref) return { reason: m.refs.some((r) => r.type === 'thmb') ? 'thumbnail is not HEVC' : 'file has no embedded thumbnail' };

  // thumbnail's own properties + the primary's orientation if it has none
  const tAssoc = propsOf(m, ref.from);
  const has = (t) => tAssoc.some((a) => prop(m, a).type === t);
  const extra = [...related].flatMap((id) => propsOf(m, id))
    .filter((a) => ['irot', 'imir'].includes(prop(m, a).type));
  const seen = new Set();
  const chosen = [...tAssoc, ...extra.filter((a) => {
    const t = prop(m, a).type;
    if (has(t) || seen.has(t)) return false;
    seen.add(t);
    return true;
  })];
  return { heic: singleItemHeic(m, ref.from, chosen) };
}

// --- public: grid split ------------------------------------------------------
/**
 * @returns {{ tiles: {x:number, y:number, heic: Uint8Array}[], tileW: number, tileH: number,
 *   gridW: number, gridH: number, matrix: number[], width: number, height: number } | {reason: string}}
 * width/height: final displayed size after transforms.
 */
export function gridPlan(m) {
  // Follow 'iden' (identity-derived, used by edits) down to the grid.
  const transforms = [];
  let id = m.primary;
  for (let depth = 0; m.types.get(id) === 'iden' && depth < 4; depth++) {
    transforms.unshift(...propsOf(m, id).map((a) => prop(m, a)).filter((p) => TRANSFORMS.includes(p.type)));
    id = refsFrom(m, id, 'dimg')[0];
  }
  const type = m.types.get(id);
  if (type !== 'grid') return { reason: `primary image is '${type}', not a tiled grid` };
  transforms.unshift(...propsOf(m, id).map((a) => prop(m, a)).filter((p) => TRANSFORMS.includes(p.type)));

  const g = itemBytes(m, id);
  const gv = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const flags = gv.getUint8(1);
  const rows = gv.getUint8(2) + 1, cols = gv.getUint8(3) + 1;
  const big = flags & 1;
  const gridW = big ? gv.getUint32(4) : gv.getUint16(4);
  const gridH = big ? gv.getUint32(big ? 8 : 6) : gv.getUint16(6);

  if (!(gridW > 0 && gridH > 0)) return { reason: 'grid has no size' };
  const tileIds = refsFrom(m, id, 'dimg');
  if (tileIds.length !== rows * cols) return { reason: `grid lists ${tileIds.length} tiles, expected ${rows * cols}` };
  if (tileIds.some((t) => m.types.get(t) !== 'hvc1')) return { reason: 'grid tiles are not HEVC' };
  const size = ispe(m, tileIds[0]);
  if (!size) return { reason: 'tile size unknown' };
  const [tileW, tileH] = size;
  if (cols * tileW < gridW || rows * tileH < gridH) return { reason: 'tiles do not cover the image' };

  const tiles = tileIds.map((t, i) => ({
    x: (i % cols) * tileW,
    y: Math.floor(i / cols) * tileH,
    heic: singleItemHeic(m, t, propsOf(m, t).filter((a) => !TRANSFORMS.includes(prop(m, a).type))),
  }));
  const { matrix, width, height } = transformMatrix(m, transforms, gridW, gridH);
  return { tiles, tileW, tileH, gridW, gridH, matrix, width, height };
}

/** One-line description of the file's structure, for console diagnostics. */
export function describe(m) {
  const items = [...m.types].map(([id, t]) => `${id}:${t}`);
  const short = items.length > 12 ? [...items.slice(0, 6), `…(${items.length} items)`, ...items.slice(-4)] : items;
  const refs = m.refs.map((r) => `${r.type} ${r.from}→${r.to.length > 4 ? r.to.slice(0, 3) + ',…' : r.to}`);
  return { primary: m.primary, items: short.join(' '), refs: refs.join('; ') };
}

/** Size of the primary image before transforms (from its ispe), or null. */
export function primarySize(m) {
  return ispe(m, m.primary);
}
