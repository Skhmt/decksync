#!/usr/bin/env node
/**
 * pHash vs OCR benchmark for DeckSync camera scanning.
 *
 * Simulates photographed cards (tilt, size, JPEG compression) with the exact
 * geometry the app uses — card filling the true 5:7 card zone, art region cropped as
 * HASH_ART_REGION fractions of the zone — then measures both identification
 * channels against those simulations:
 *
 *   1. Hash channel: per-frame crop + hash + match time, accuracy (correct
 *      card id within threshold), distance distribution and the closest
 *      cross-card distance (ambiguity margin).
 *   2. OCR channel: tesseract on the set/collector corner (+ name bar) with
 *      local validation against card-data.json — accuracy and time for a
 *      representative aligned photo per card.
 *   3. Storage cost: card-hashes.bin size (and projected full-build size)
 *      vs the OCR asset footprint.
 *
 * Usage:
 *   npm run prepare:hashes            # build the index first
 *   node scripts/test-hash-vs-ocr.js                     # all indexed cards
 *   DECKSYNC_BENCH_CARDS="Black Lotus" node scripts/test-hash-vs-ocr.js
 *   DECKSYNC_BENCH_OCR=0 ...           # skip the (slow) tesseract part
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import {
  HASH_ART_REGION,
  HASH_ASPECT_CLASSES,
  HASH_MATCH_THRESHOLD,
  computePHashFromRGBA,
  hammingDistance
} from '../src/lib/ocr/phash.ts';
import { parseSetAndCollector, extractCardName } from '../src/lib/ocr/parse.ts';
import { readBinIndex } from './hash-index-bin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH_FILE = path.join(ROOT, 'public', 'card-hashes.bin');
const CARD_DATA_FILE = path.join(ROOT, 'public', 'card-data.json');
const TESS_DIR = path.join(ROOT, 'public', 'tess');

// The card zone is a true 5:7 MTG-card rectangle (cardZoneForFrame in
// cardScanner.ts); its shape no longer depends on the camera aspect. Keep
// CARD_ASPECT in sync with src/lib/ocr/cardScanner.ts.
const CARD_ASPECT = 2.5 / 3.5;
const BG = { r: 90, g: 85, b: 75 };

/** Fit a centered 5:7 (CARD_ASPECT) box in pixel terms inside the frame — mirrors cardZoneForFrame(). */
function cardBox(frameW, frameH, margin = 0.05) {
  const availW = frameW * (1 - 2 * margin);
  const availH = frameH * (1 - 2 * margin);
  const aspect = frameW / frameH;
  const fh = Math.min(availH, (availW * aspect) / CARD_ASPECT);
  const fw = (CARD_ASPECT / aspect) * fh;
  return { x: Math.round((frameW - fw) / 2), y: Math.round((frameH - fh) / 2), w: Math.round(fw), h: Math.round(fh) };
}

// Benchmark matrix (kept small on purpose — each photo costs a sharp render)
const TILTS = [0, 6, 12];
const FILLS = [1.0, 0.9];
const JPEG_Q = 85;
/** Max entries per card name exercised (first / middle / last artwork). */
const MAX_ENTRIES_PER_CARD = 3;

// --- Simulated photos --------------------------------------------------------

async function rawRGBA(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function cropFraction(pix, rect) {
  const x0 = Math.floor(rect.x0 * pix.width);
  const y0 = Math.floor(rect.y0 * pix.height);
  const x1 = Math.max(x0 + 1, Math.floor(rect.x1 * pix.width));
  const y1 = Math.max(y0 + 1, Math.floor(rect.y1 * pix.height));
  const cw = x1 - x0;
  const ch = y1 - y0;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const off = ((y0 + y) * pix.width + x0) * 4;
    pix.data.copy(out, y * cw * 4, off, off + cw * 4);
  }
  return { data: out, width: cw, height: ch };
}

/**
 * Renders a simulated camera photo: the official face centered in the true 5:7
 * card zone of a full frame, scaled to `fill` of the zone height, rotated by
 * `tilt`, JPEG-compressed. Returns the RGBA of the zone crop — exactly what the
 * app would hash / OCR. The camera aspect no longer affects the geometry (the
 * zone is always 5:7), so a fixed frame is used; `cls` is kept for call-site
 * compatibility but no longer changes the render.
 */
async function simulatePhoto(faceBytes, cls, tilt, fill) {
  const fw = 1920;
  const fh = Math.round(fw / (4 / 3)); // fixed frame; zone shape is camera-independent
  const box = cardBox(fw, fh);

  const meta = await sharp(faceBytes).metadata();
  const H = Math.max(8, Math.round(box.h * fill));
  const W = Math.max(8, Math.round(H * meta.width / meta.height));
  const resized = await sharp(faceBytes).resize(W, H).jpeg({ quality: JPEG_Q }).toBuffer();
  const rot = tilt === 0 ? resized : await sharp(resized).rotate(tilt, { background: BG }).toBuffer();
  const rm = await sharp(rot).metadata();

  const frame = await sharp({ create: { width: fw, height: fh, channels: 3, background: BG } })
    .composite([{ input: rot, left: box.x + Math.round((box.w - rm.width) / 2), top: box.y + Math.round((box.h - rm.height) / 2) }])
    .jpeg({ quality: JPEG_Q })
    .toBuffer();
  return cropFraction(await rawRGBA(frame), { x0: box.x / fw, y0: box.y / fh, x1: (box.x + box.w) / fw, y1: (box.y + box.h) / fh });
}

/** Encodes an RGBA crop as a PNG buffer (Node's tesseract worker needs encoded images). */
async function toPng(crop) {
  return sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 4 } }).png().toBuffer();
}

// --- Hash channel -------------------------------------------------------------

/** App-side match for one zone crop (mirrors hashScanner.matchFrame). */
function matchZone(zone, classKey, entries, threshold) {
  const t0 = process.hrtime.bigint();
  const art = cropFraction(zone, HASH_ART_REGION);
  const hash = computePHashFromRGBA(art);
  let best = null;
  for (const e of entries) {
    for (const stored of e.hashes[classKey] ?? []) {
      const d = hammingDistance(stored, hash);
      if (!best || d < best.d) best = { id: e.id, name: e.name, d };
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { match: best && best.d <= threshold ? best : null, nearest: best, ms };
}

async function benchHashChannel(index, names) {
  const entries = index.entries.filter(e => !names || names.has(e.name));
  if (entries.length === 0) return null;

  // Mirror the app's runtime cap (cardHashes.ts): a stale meta value in an old
  // build can't loosen the threshold past what ships in code. An explicit
  // DECKSYNC_BENCH_THRESHOLD override lets us compare against the pre-tuning
  // value (e.g. 12) to quantify the false-positive reduction.
  const override = process.env.DECKSYNC_BENCH_THRESHOLD ? Number(process.env.DECKSYNC_BENCH_THRESHOLD) : null;
  const effThreshold = override ?? Math.min(index.threshold ?? HASH_MATCH_THRESHOLD, HASH_MATCH_THRESHOLD);

  // Group by card id so cross-card distances are measured correctly
  const byCard = new Map();
  for (const e of entries) {
    if (!byCard.has(e.id)) byCard.set(e.id, []);
    byCard.get(e.id).push(e);
  }

  const faceCache = new Map(); // entry id -> face bytes (from prepare-hashes cache)
  async function faceFor(entry) {
    if (!faceCache.has(entry.id + ':' + entry.face)) {
      const file = path.join(ROOT, 'scripts', '.cache', 'hashes', `${entry.id}-f${entry.face}.jpg`);
      faceCache.set(entry.id + ':' + entry.face, existsSync(file) ? readFileSync(file) : null);
    }
    return faceCache.get(entry.id + ':' + entry.face);
  }

  const stats = { total: 0, correct: 0, wrongCard: 0, noMatch: 0 };
  const distances = [];
  const times = [];
  let minCross = Infinity;

  for (const [cardId, cardEntries] of byCard) {
    // Sample first / middle / last artwork of the card
    const sample = MAX_ENTRIES_PER_CARD >= cardEntries.length
      ? cardEntries
      : [cardEntries[0], cardEntries[Math.floor(cardEntries.length / 2)], cardEntries[cardEntries.length - 1]];

    for (const entry of sample) {
      const face = await faceFor(entry);
      if (!face) continue;
      for (const cls of HASH_ASPECT_CLASSES) {
        for (const tilt of TILTS) {
          for (const fill of FILLS) {
            const zone = await simulatePhoto(face, cls, tilt, fill);
            const { match, ms } = matchZone(zone, cls.key, entries, effThreshold);
            stats.total++;
            times.push(ms);
            if (match?.id === cardId) {
              stats.correct++;
              distances.push(match.d);
            } else if (match) {
              stats.wrongCard++;
              // How close did the WRONG card come? That is the real ambiguity risk.
              minCross = Math.min(minCross, match.d);
            } else {
              stats.noMatch++;
            }
          }
        }
      }
    }
  }

  const pct = n => ((100 * n) / stats.total).toFixed(1);
  const sorted = [...distances].sort((a, b) => a - b);
  const p = q => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : '-');
  console.log('\n--- Hash channel ---');
  console.log(`entries indexed: ${entries.length} (${byCard.size} cards)`);
  console.log(`photos simulated: ${stats.total} (tilt ${TILTS.join('/')} x fill ${FILLS.join('/')} x ${HASH_ASPECT_CLASSES.length} aspects, q${JPEG_Q})`);
  console.log(`correct id:       ${stats.correct} (${pct(stats.correct)}%)`);
  console.log(`wrong card id:    ${stats.wrongCard} (${pct(stats.wrongCard)}%)  <- misidentification risk`);
  console.log(`no match (>thr):  ${stats.noMatch} (${pct(stats.noMatch)}%)  <- falls through to OCR`);
  if (distances.length) {
    console.log(`match distance:   p50=${p(0.5)} p95=${p(0.95)} max=${sorted[sorted.length - 1]} (threshold ${effThreshold})`);
  }
  console.log(`closest wrong-card hit: ${minCross === Infinity ? 'none' : minCross + ' bits'} — margin to threshold: ${minCross === Infinity ? '-' : minCross - effThreshold}`);
  times.sort((a, b) => a - b);
  console.log(`per-frame cost:   p50=${times[Math.floor(times.length / 2)].toFixed(1)} ms  p95=${times[Math.floor(0.95 * times.length)].toFixed(1)} ms  (crop + hash + match, Node)`);
}

// --- OCR channel ----------------------------------------------------------------

async function benchOcrChannel(index, names) {
  const entries = index.entries.filter(e => !names || names.has(e.name));
  if (entries.length === 0) return;

  let printings = new Map();
  let nameSet = new Set();
  if (existsSync(CARD_DATA_FILE)) {
    const cd = JSON.parse(readFileSync(CARD_DATA_FILE, 'utf8'));
    for (const [k, v] of Object.entries(cd.printings ?? {})) printings.set(k.toLowerCase(), v);
    for (const n of cd.names ?? []) nameSet.add(n);
  }

  console.log('\n--- OCR channel (aligned photos only: tilt 0, fill 1.0) ---');
  if (!existsSync(path.join(TESS_DIR, 'worker.min.js'))) {
    console.log('skipped — public/tess not present');
    return;
  }
  // Node runs tesseract.js' own worker_threads script — do NOT pass the
  // browser worker.min.js as workerPath. langPath may be a local directory in
  // Node, so traineddata is read from disk (core comes from node_modules).
  const worker = await createWorker('eng', 1, {
    langPath: TESS_DIR
  });
  await worker.setParameters({ user_defined_dpi: '300' });

  // Same region mapping as cardScanner.ts (fractions of the card zone)
  const SET_REGION = { x0: 0.0, y0: 0.77, x1: 0.60, y1: 1.0 };
  const NAME_REGION = { x0: 0.02, y0: 0.03, x1: 0.98, y1: 0.12 };

  // One representative printing per card (the first indexed entry)
  const seen = new Set();
  const samples = entries.filter(e => !seen.has(e.name) && seen.add(e.name));
  let okCount = 0;

  for (const entry of samples) {
    const file = path.join(ROOT, 'scripts', '.cache', 'hashes', `${entry.id}-f${entry.face}.jpg`);
    if (!existsSync(file)) continue;
    const face = readFileSync(file);

    const zone = await simulatePhoto(face, HASH_ASPECT_CLASSES[0], 0, 1.0);
    // Node's tesseract worker only accepts encoded images (Buffer/path/URL),
    // not raw RGBA objects — encode the crops before timing the OCR itself.
    const setImg = await toPng(cropFraction(zone, SET_REGION));
    const nameImg = await toPng(cropFraction(zone, NAME_REGION));

    const t0 = process.hrtime.bigint();
    const setRead = await worker.recognize(setImg);
    const nameRead = await worker.recognize(nameImg);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const parsed = parseSetAndCollector((setRead.data?.text ?? '').trim());
    let resolved = null;
    if (parsed?.setCode && parsed.collectorNumber) {
      resolved = printings.get(`${parsed.setCode.toLowerCase()}:${parsed.collectorNumber}`);
    }
    const name = extractCardName(nameRead.data?.text ?? '');
    const norm = n => n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const nameValid = name ? nameSet.has(norm(name)) : false;

    const ok = resolved === entry.id || (name && norm(name) === norm(entry.name.split(' // ')[0]));
    if (ok) okCount++;
    console.log(
      `  ${entry.name.padEnd(28)} ${ok ? 'OK  ' : 'MISS'}  ${ms.toFixed(0).padStart(5)} ms` +
        `  corner="${(setRead.data?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 32)}"` +
        (resolved ? '' : nameValid ? '  (name valid)' : '')
    );
  }
  console.log(`OCR accuracy: ${okCount}/${samples.length} aligned photos resolved to the right card`);
  await worker.terminate();
}

// --- Storage cost ------------------------------------------------------------------

function benchStorage(index) {
  console.log('\n--- Storage cost ---');
  const hashSize = existsSync(HASH_FILE) ? statSync(HASH_FILE).size : 0;
  const perEntry = index.entries.length ? Math.round(hashSize / index.entries.length) : 0;
  console.log(`card-hashes.bin:            ${(hashSize / 1024).toFixed(0)} KB for ${index.entries.length} entries (~${perEntry} B/entry)`);
  // Rough full-build projection: ~15k unique card names, ~1.6 unique artworks each
  console.log(`projected full build:     ~${((15000 * 1.6 * perEntry) / 1024 / 1024).toFixed(1)} MB (15k cards x ~1.6 faces)`);

  let tessSize = 0;
  if (existsSync(TESS_DIR)) {
    for (const f of ['worker.min.js', 'eng.traineddata.gz']) {
      const p = path.join(TESS_DIR, f);
      if (existsSync(p)) tessSize += statSync(p).size;
    }
  }
  const cardDataSize = existsSync(CARD_DATA_FILE) ? statSync(CARD_DATA_FILE).size : 0;
  console.log(`OCR assets (tess):        ${(tessSize / 1024 / 1024).toFixed(1)} MB (worker + traineddata, one-time download)`);
  console.log(`card-data.json:           ${(cardDataSize / 1024 / 1024).toFixed(1)} MB (name/printing validation)`);
}

/** Parses the binary index: header (region/threshold) + entry records. */
function loadHashIndex() {
  const { header, records } = readBinIndex(HASH_FILE);
  return { entries: records, region: header.region, threshold: header.threshold };
}

// --- Main -----------------------------------------------------------------------------

async function main() {
  if (!existsSync(HASH_FILE)) {
    console.error('public/card-hashes.bin not found — run `npm run prepare:hashes` first.');
    process.exitCode = 1;
    return;
  }
  const index = loadHashIndex();
  if (index.entries.length === 0) {
    console.error('card-hashes.bin has no entries — run `npm run prepare:hashes` first.');
    process.exitCode = 1;
    return;
  }

  const names = process.env.DECKSYNC_BENCH_CARDS
    ? new Set(process.env.DECKSYNC_BENCH_CARDS.split(',').map(s => s.trim()).filter(Boolean))
    : null;

  console.log(`pHash vs OCR benchmark — threshold ${index.threshold ?? HASH_MATCH_THRESHOLD}, region ${JSON.stringify(index.region ?? HASH_ART_REGION)}`);
  await benchHashChannel(index, names);
  if (process.env.DECKSYNC_BENCH_OCR !== '0') {
    await benchOcrChannel(index, names);
  }
  benchStorage(index);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exitCode = 1;
});
