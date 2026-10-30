// Builds dist/ (see build.mjs) and zips it for upload to the Chrome Web Store:
//   heic-speedgrader-<version>.zip  (no external zip tool needed)
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { deflateRawSync, crc32 } from 'node:zlib';
import { join } from 'node:path';

// Only files the built extension actually uses (skips leftovers in dist/).
const KEEP = /^(manifest\.json|content\.(js|css)|viewer\.(html|js|css)|options\.(html|js|css)|background\.js|decoder-(host\.(html|js)|worker\.js)|libheif\.wasm|THIRD_PARTY_NOTICES\.txt|LICENSE\.txt|icons\/icon-\d+\.png)$/;

async function walk(dir, base = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walk(join(dir, e.name), rel));
    else if (KEEP.test(rel)) out.push(rel);
  }
  return out.sort();
}

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const files = await walk('dist');
const local = [], central = [];
let offset = 0;
const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1; // fixed date → reproducible zips
for (const name of files) {
  const data = await readFile(join('dist', name));
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const nameBuf = Buffer.from(name);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8);
  h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
  local.push(h, nameBuf, comp);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10);
  c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
  c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const out = `heic-speedgrader-${manifest.version}.zip`;
await writeFile(out, Buffer.concat([...local, cd, end]));
console.log(`${out}: ${files.length} files`);
files.forEach((f) => console.log('  ' + f));
