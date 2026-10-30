// Bundles src/ into dist/ (load dist/ as an unpacked extension in Chrome).
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
// Files are overwritten in place (keeps the folder Chrome has loaded).
await mkdir('dist', { recursive: true });

const copy = async (from, to) => writeFile(to, await readFile(from));
await mkdir('dist/icons', { recursive: true });
for (const f of ['manifest.json', 'viewer.html', 'viewer.css', 'content.css', 'content.js', 'decoder-host.html',
  'background.js', 'options.html', 'options.css', 'options.js',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png']) {
  await copy(`src/${f}`, `dist/${f}`);
}
await copy('node_modules/libheif-js/libheif-wasm/libheif.wasm', 'dist/libheif.wasm');
await writeFile('dist/THIRD_PARTY_NOTICES.txt',
  'This extension includes libheif (https://github.com/strukturag/libheif) and libde265,\n' +
  'compiled to WebAssembly by libheif-js (https://github.com/catdad-experiments/libheif-js).\n' +
  'They are licensed under the GNU Lesser General Public License v3; full text below.\n\n' +
  await readFile('node_modules/libheif-js/libheif-wasm/LICENSE', 'utf8'));

const common = {
  bundle: true,
  target: 'chrome120',
  minify: false,          // readable output makes Chrome Web Store review easier
  legalComments: 'inline',
  logLevel: 'info',
  external: ['fs', 'path'], // only referenced by libheif's Node.js code path
};
const builds = [
  { ...common, entryPoints: ['src/viewer.js'], format: 'esm', outfile: 'dist/viewer.js' },
  { ...common, entryPoints: ['src/decoder-host.js'], format: 'esm', outfile: 'dist/decoder-host.js' },
  { ...common, entryPoints: ['src/decoder-worker.js'], format: 'iife', outfile: 'dist/decoder-worker.js' },
];

for (const b of builds) {
  const ctx = await esbuild.context(b);
  if (watch) await ctx.watch();
  else { await ctx.rebuild(); await ctx.dispose(); }
}
if (watch) console.log('Watching… (re-run build for manifest/html/css changes)');
