#!/usr/bin/env node
/**
 * Copies the self-contained OpenCV.js build into public/opencv/ so the app can
 * serve it from its own origin (no third-party CDN) and Workbox can cache it for
 * offline use — the same treatment as the Tesseract assets in public/tess.
 *
 * The source is the installed @techstark/opencv-js package (version-pinned by
 * package.json); we copy dist/opencv.js, a single ~13 MB file with the wasm
 * embedded, so there is no separate .wasm to fetch. It is loaded lazily at scan
 * time (src/lib/ocr/cardWarp.ts), never bundled into the initial page load.
 *
 * Usage:
 *   npm run prepare:opencv     # auto-runs before `dev` and `build`
 *
 * Fails soft: if the package isn't installed yet (e.g. a fresh checkout before
 * `npm i`) it warns and leaves any existing public/opencv/opencv.js in place, so
 * the build never breaks over a missing optional asset.
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const src = path.join(root, 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv.js');
const outDir = path.join(root, 'public', 'opencv');
const dest = path.join(outDir, 'opencv.js');

if (!existsSync(src)) {
  if (existsSync(dest)) {
    console.warn('[prepare:opencv] @techstark/opencv-js not installed; keeping existing public/opencv/opencv.js.');
  } else {
    console.warn('[prepare:opencv] @techstark/opencv-js not found and no prior asset — run `npm i` then re-run. Card warp will fall back to manual alignment until it is present.');
  }
  process.exit(0); // fail soft
}

mkdirSync(outDir, { recursive: true });
copyFileSync(src, dest);
const kb = Math.round(statSync(dest).size / 1024);
console.log(`[prepare:opencv] copied opencv.js -> public/opencv/opencv.js (${kb} KB)`);
