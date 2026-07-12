// One-time (and on-upgrade) build: bundle React + Excalidraw + the Sutra bridge
// into a single IIFE that Sutra's no-bundler runtime loads via <script>.
// Run: (cd tools && node build-canvas.mjs)
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const vendor = resolve(here, '../src/vendor');
const assetsDir = resolve(vendor, 'excalidraw-assets');
const fontsSrc = resolve(here, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');

mkdirSync(assetsDir, { recursive: true });

// 1) Bundle JS (+ CSS emitted alongside as excalidraw.bundle.css)
const result = await esbuild.build({
  entryPoints: [resolve(here, 'canvas-host.jsx')],
  bundle: true,
  format: 'iife',
  outfile: resolve(vendor, 'excalidraw.bundle.js'),
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  target: ['es2020', 'safari15'],
  conditions: ['production', 'module', 'import', 'default'],
  loader: { '.js': 'jsx', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  assetNames: 'excalidraw-assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
  metafile: true,
  logLevel: 'info',
});

// 2) Copy Excalidraw's font assets for offline use (Virgil/Excalifont, code fonts, etc.).
//    Skip Xiaolai — a 12 MB CJK handwriting fallback; CJK text falls back to
//    system fonts, saving ~12 MB in the app/APK for a rarely-hit case.
if (existsSync(fontsSrc)) {
  cpSync(fontsSrc, resolve(assetsDir, 'fonts'), {
    recursive: true,
    filter: (src) => !src.includes('/Xiaolai'),
  });
  console.log('copied fonts (excl. Xiaolai) →', resolve(assetsDir, 'fonts'));
} else {
  console.warn('!! fonts dir not found at', fontsSrc);
}

const js = resolve(vendor, 'excalidraw.bundle.js');
const css = resolve(vendor, 'excalidraw.bundle.css');
console.log('\nbuilt:');
for (const f of [js, css]) {
  if (existsSync(f)) console.log(`  ${(statSync(f).size / 1048576).toFixed(2)} MB  ${f.split('/vendor/')[1]}`);
}
