#!/usr/bin/env node
/**
 * Offline rebuild of public/card-hashes.bin against the true 5:7 card zone.
 *
 * Why this exists
 * ---------------
 * The framing guide, the OCR crops and the pHash channel all use the same true
 * MTG-card (5:7) rectangle — cardZoneForFrame() in src/lib/ocr/cardScanner.ts.
 * The original index was built by scripts/prepare-hashes.js against the older
 * fixed CARD_ZONE box, so its hashes no longer line up with the 5:7 crop the app
 * now reads. This script regenerates the index from the locally cached face
 * images (scripts/.cache/hashes/) using the 5:7 geometry — with NO network: it
 * never calls Scryfall or MTGJSON.
 *
 * Data source
 * -----------
 * scripts/.cache/hashes-progress.jsonl is the face-level ledger written by the
 * original build; each line is {id, face, name, status}. Only faces recorded as
 * "accepted" (i.e. present in the current card-hashes.bin) are re-hashed, so the
 * rebuilt index has exactly the same card coverage as today — only the hash
 * values change, to match the new 5:7 crop. The cached image for each face is
 * scripts/.cache/hashes/<id>-f<face>.jpg.
 *
 * Geometry
 * --------
 * Each face is rendered into a synthetic zone that is ALWAYS a 5:7 (CARD_ASPECT)
 * box — the camera aspect no longer matters, because the card now fills a true
 * card-shaped guide. The central HASH_ART_REGION of that box is hashed for every
 * stored variant (fill × angle), exactly mirroring what the app hashes at scan
 * time (hashScanner.cropHashRegion). Because the zone is camera-independent, both
 * aspect classes in the index carry identical hashes; the binary format still
 * stores two class slots and we fill both with the same values (no size change
 * vs. today's index).
 *
 * Safety
 * ------
 * Output goes to a .tmp file first and is only promoted to card-hashes.bin
 * (backing up the previous one to card-hashes.bin.bak) after every face has been
 * written, so a killed run never corrupts the served index.
 *
 * Usage
 * -----
 *   npm run rebuild:hashes                              # full offline rebuild
 *   node scripts/rebuild-hashes-offline.js --dry-run    # report counts only
 *   node scripts/rebuild-hashes-offline.js --limit=20   # smoke-test on 20 faces
 *   node scripts/rebuild-hashes-offline.js --concurrency=16  # tune parallelism
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  HASH_ASPECT_CLASSES,
  HASH_ART_REGION,
  HASH_STORE_FILLS,
  HASH_STORE_ANGLES,
  computePHashFromRGBA
} from '../src/lib/ocr/phash.ts';
import { writeHeader, appendBinRecord } from './hash-index-bin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'public', 'card-hashes.bin');
const TMP_FILE = `${OUT_FILE}.tmp`;
const CACHE_DIR = path.join(ROOT, 'scripts', '.cache', 'hashes');
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.cache', 'hashes-progress.jsonl');

// Keep in sync with CARD_ASPECT in src/lib/ocr/cardScanner.ts (2.5" x 3.5").
const CARD_ASPECT = 2.5 / 3.5;
/** Width (px) of the synthetic zone canvas used for pre-build renders. */
const ZONE_RENDER_WIDTH = 1024;
/** Background fill outside the card in synthetic renders (never inside the art box). */
const BG = { r: 90, g: 85, b: 75 };

// --- Args ----------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg
  ? parseInt(limitArg.split('=')[1], 10)
  : (process.env.DECKSYNC_REBUILD_LIMIT ? parseInt(process.env.DECKSYNC_REBUILD_LIMIT, 10) : Infinity);
// Faces built in parallel (sharp's libvips work overlaps across faces); appends
// to the index still happen in input order so the file stays deterministic.
const concArg = args.find(a => a.startsWith('--concurrency='));
const CONCURRENCY = Math.max(1, concArg
  ? parseInt(concArg.split('=')[1], 10)
  : (process.env.DECKSYNC_REBUILD_CONCURRENCY ? parseInt(process.env.DECKSYNC_REBUILD_CONCURRENCY, 10) : 8));

// --- Geometry helpers ----------------------------------------------------------

/** Crops a centered rectangle (fractions of the buffer) out of an RGBA buffer. */
function cropFraction(rgba, width, height, rect) {
  const x0 = Math.floor(rect.x0 * width);
  const y0 = Math.floor(rect.y0 * height);
  const x1 = Math.max(x0 + 1, Math.floor(rect.x1 * width));
  const y1 = Math.max(y0 + 1, Math.floor(rect.y1 * height));
  const cw = x1 - x0;
  const ch = y1 - y0;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcOff = ((y0 + y) * width + x0) * 4;
    rgba.copy(out, y * cw * 4, srcOff, srcOff + cw * 4);
  }
  return { data: out, width: cw, height: ch };
}

/**
 * Hashes one face image against the 5:7 card zone. The card is centered in a
 * CARD_ASPECT box, scaled to `fill` of the box height and rotated by `angle` —
 * exactly the geometry hashScanner.cropHashRegion reads at scan time. Returns
 * { [classKey]: hexHash[] } where every class carries the same list (the zone is
 * camera-independent), in fill-outer / angle-inner order. Keep in sync with
 * buildFaceHashes() in scripts/prepare-hashes.js.
 */
async function buildFaceHashes(bytes) {
  const meta = await sharp(bytes).metadata();
  const zw = ZONE_RENDER_WIDTH;
  const zh = Math.round(zw / CARD_ASPECT); // 5:7 zone, independent of camera aspect
  const list = [];
  for (const fill of HASH_STORE_FILLS) {
    const H = Math.max(8, Math.round(zh * fill));
    const W = Math.max(8, Math.round(H * meta.width / meta.height));
    const resized = await sharp(bytes).resize(W, H).png().toBuffer();
    for (const ang of HASH_STORE_ANGLES) {
      const rot = ang === 0 ? resized : await sharp(resized).rotate(ang, { background: BG }).png().toBuffer();
      const rm = await sharp(rot).metadata();
      // Canvas must fit the rotated card; the zone is its central zw×zh rect.
      const cw = Math.max(zw, rm.width);
      const ch = Math.max(zh, rm.height);
      const canvas = await sharp({ create: { width: cw, height: ch, channels: 3, background: BG } })
        .composite([{ input: rot, left: Math.round((cw - rm.width) / 2), top: Math.round((ch - rm.height) / 2) }])
        .png()
        .toBuffer();
      const { data, info } = await sharp(canvas).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      // Zone (centered in the canvas), then the art region inside the zone.
      const zone = cropFraction(data, info.width, info.height, {
        x0: (cw - zw) / 2 / cw,
        y0: (ch - zh) / 2 / ch,
        x1: 1 - (cw - zw) / 2 / cw,
        y1: 1 - (ch - zh) / 2 / ch
      });
      const art = cropFraction(zone.data, zone.width, zone.height, HASH_ART_REGION);
      list.push(computePHashFromRGBA(art));
    }
  }
  // Zone is camera-independent → every aspect class stores identical hashes.
  const result = {};
  for (const cls of HASH_ASPECT_CLASSES) result[cls.key] = list;
  return result;
}

// --- Manifest ------------------------------------------------------------------

/** Reads the face ledger and returns the accepted faces ({id, face, name}). */
function readAcceptedFaces() {
  if (!existsSync(PROGRESS_FILE)) throw new Error(`missing progress ledger: ${PROGRESS_FILE}`);
  const byKey = new Map();
  for (const raw of readFileSync(PROGRESS_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.status !== 'accepted') continue;
    const key = `${rec.id}|${rec.face}`;
    byKey.set(key, { id: String(rec.id), face: Number(rec.face) >>> 0, name: String(rec.name ?? '') });
  }
  return [...byKey.values()];
}

const imageFileFor = (face) => path.join(CACHE_DIR, `${face.id}-f${face.face}.jpg`);

// --- Main ----------------------------------------------------------------------

async function main() {
  const faces = readAcceptedFaces();
  console.log(`[rebuild-offline] ${faces.length} accepted faces in ledger`);
  if (faces.length === 0) throw new Error('no accepted faces found in the progress ledger');

  let withImage = 0;
  for (const face of faces) if (existsSync(imageFileFor(face))) withImage++;
  console.log(`[rebuild-offline] ${withImage}/${faces.length} faces have a cached image in ${path.relative(ROOT, CACHE_DIR)}`);

  if (DRY_RUN) {
    console.log('[rebuild-offline] dry run — nothing rendered or written.');
    return;
  }

  // Start from a clean tmp file (drop any stale one left by a killed run).
  if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE);
  writeHeader(TMP_FILE);

  const toProcess = LIMIT === Infinity ? faces : faces.slice(0, LIMIT);
  const complete = toProcess.length === faces.length;
  let written = 0;
  let missing = 0;
  let failed = 0;
  let done = 0;
  let lastLogged = 0;
  const t0 = Date.now();

  // Build hashes concurrently (sharp's libvips work overlaps across faces) but
  // append to the index in input order, so the file stays deterministic.
  for (let start = 0; start < toProcess.length; start += CONCURRENCY) {
    const chunk = toProcess.slice(start, start + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (face) => {
      const file = imageFileFor(face);
      if (!existsSync(file)) return { face, status: 'missing' };
      try {
        const bytes = readFileSync(file);
        const hashes = await buildFaceHashes(bytes);
        return { face, status: 'ok', hashes };
      } catch (err) {
        return { face, status: 'failed', message: err.message };
      }
    }));
    for (const r of results) {
      done++;
      if (r.status === 'missing') { missing++; continue; }
      if (r.status === 'failed') { failed++; console.warn(`[rebuild-offline]   ${r.face.id} f${r.face.face}: ${r.message}`); continue; }
      appendBinRecord(TMP_FILE, { id: r.face.id, name: r.face.name, face: r.face.face, hashes: r.hashes });
      written++;
    }
    if (done - lastLogged >= 500 || done === toProcess.length) {
      lastLogged = done;
      const elapsed = (Date.now() - t0) / 1000;
      const perFace = elapsed / done;
      const eta = perFace * (toProcess.length - done);
      console.log(`[rebuild-offline]   ${done}/${toProcess.length} (${written} written, ${missing} missing, ${failed} failed) — ${elapsed.toFixed(0)}s elapsed, ~${eta.toFixed(0)}s left`);
    }
  }

  const size = statSync(TMP_FILE).size;
  console.log(`[rebuild-offline] rendered ${written} entries in ${((Date.now() - t0) / 1000).toFixed(0)}s — tmp index ${(size / 1024 / 1024).toFixed(2)} MB`);

  if (complete) {
    // Promote: back up the current index, then swap the finished tmp into place.
    if (existsSync(OUT_FILE)) writeFileSync(`${OUT_FILE}.bak`, readFileSync(OUT_FILE));
    renameSync(TMP_FILE, OUT_FILE);
    console.log(`[rebuild-offline] promoted to ${path.relative(ROOT, OUT_FILE)} (previous backed up to card-hashes.bin.bak)`);
  } else {
    console.log(`[rebuild-offline] partial run (${toProcess.length}/${faces.length}) — NOT promoted. Re-run without --limit for the full rebuild.`);
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('[rebuild-offline] fatal:', err);
  process.exit(1);
});