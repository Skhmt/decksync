#!/usr/bin/env node
/**
 * Diagnostic: simulates the runtime hash pipeline at various fill levels and
 * rotations to measure how close pHash distances are to the acceptance threshold.
 *
 * Usage: node scripts/diagnose-hash-distances.js [--limit=10]
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  HASH_ART_REGION,
  HASH_MATCH_THRESHOLD,
  HASH_STORE_FILLS,
  HASH_STORE_ANGLES,
  computePHashFromRGBA,
  hammingDistance
} from '../src/lib/ocr/phash.ts';
import { readBinIndex } from './hash-index-bin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'scripts', '.cache', 'hashes');
const BIN_FILE = path.join(ROOT, 'public', 'card-hashes.bin');

const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 10;

const CARD_ASPECT = 2.5 / 3.5;
const FRAME_W = 1024;
const FRAME_H = 768;
const BG = { r: 90, g: 85, b: 75 };

function loadStoredHashes() {
  const { header, records } = readBinIndex(BIN_FILE);
  console.log(`Loaded ${records.length} entries (threshold=${header.threshold}, region=${JSON.stringify(header.region)})`);
  // Build a lookup: id -> { name, allHashes: string[] (hex) }
  const map = new Map();
  for (const rec of records) {
    const all = [];
    for (const key of Object.keys(rec.hashes)) {
      all.push(...rec.hashes[key]);
    }
    map.set(rec.id, { name: rec.name, hashes: all });
  }
  return map;
}

async function simulateRuntimeHash(cardImg, fill, angleDeg) {
  const meta = await sharp(cardImg).metadata();
  const margin = 0.05;
  const availW = (1 - 2 * margin) * FRAME_W;
  const availH = (1 - 2 * margin) * FRAME_H;
  let zoneW, zoneH;
  if ((FRAME_W / FRAME_H) > CARD_ASPECT) {
    zoneH = availH;
    zoneW = zoneH * CARD_ASPECT;
  } else {
    zoneW = availW;
    zoneH = zoneW / CARD_ASPECT;
  }
  const cardH = Math.round(zoneH * fill);
  const cardW = Math.max(8, Math.round(cardH * meta.width / meta.height));
  let resized = await sharp(cardImg).resize(cardW, cardH).png().toBuffer();
  if (angleDeg !== 0) {
    resized = await sharp(resized).rotate(angleDeg, { background: BG }).png().toBuffer();
  }
  const rm = await sharp(resized).metadata();
  const zoneX = Math.round((FRAME_W - zoneW) / 2);
  const zoneY = Math.round((FRAME_H - zoneH) / 2);
  const cardX = zoneX + Math.round((zoneW - rm.width) / 2);
  const cardY = zoneY + Math.round((zoneH - rm.height) / 2);
  // Ensure the composited image fits within the frame (rotation can grow bounds)
  const compW = Math.min(rm.width, FRAME_W);
  const compH = Math.min(rm.height, FRAME_H);
  const compImg = compW === rm.width && compH === rm.height ? resized : await sharp(resized).extract({ left: 0, top: 0, width: compW, height: compH }).png().toBuffer();
  const canvas = await sharp({ create: { width: FRAME_W, height: FRAME_H, channels: 3, background: BG } })
    .composite([{ input: compImg, left: cardX, top: cardY }])
    .png().toBuffer();
  const { data, info } = await sharp(canvas).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const zx0 = Math.floor(((FRAME_W - zoneW) / 2 / FRAME_W + HASH_ART_REGION.x0 * (zoneW / FRAME_W)) * info.width);
  const zy0 = Math.floor(((FRAME_H - zoneH) / 2 / FRAME_H + HASH_ART_REGION.y0 * (zoneH / FRAME_H)) * info.height);
  const zx1 = Math.max(zx0 + 1, Math.floor(((FRAME_W - zoneW) / 2 / FRAME_W + HASH_ART_REGION.x1 * (zoneW / FRAME_W)) * info.width));
  const zy1 = Math.max(zy0 + 1, Math.floor(((FRAME_H - zoneH) / 2 / FRAME_H + HASH_ART_REGION.y1 * (zoneH / FRAME_H)) * info.height));
  const artW = zx1 - zx0;
  const artH = zy1 - zy0;
  const artData = new Uint8ClampedArray(artW * artH * 4);
  for (let y = 0; y < artH; y++) {
    const srcOff = ((zy0 + y) * info.width + zx0) * 4;
    const dstOff = y * artW * 4;
    artData.set(data.subarray(srcOff, srcOff + artW * 4), dstOff);
  }
  return computePHashFromRGBA({ data: artData, width: artW, height: artH });
}
async function main() {
  const stored = loadStoredHashes();
  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.jpg')).slice(0, LIMIT);
  console.log(`\nTesting ${files.length} cards at various fill levels and angles...`);
  console.log(`Stored fills: [${HASH_STORE_FILLS}]  Stored angles: [${HASH_STORE_ANGLES}]`);
  console.log(`Test fills: [0.70, 0.85, 1.00, 1.10]  Test angles: [0, +3, -3]  Threshold: ${HASH_MATCH_THRESHOLD}\n`);
  let totalTests = 0, matchesAtThreshold = 0;
  const buckets = { '0-3': 0, '4-8': 0, '9-12': 0, '13-16': 0, '17+': 0 };
  for (const file of files) {
    const id = file.replace(/-f\d+\.jpg$/, '');
    const entry = stored.get(id);
    if (!entry) { console.log(`SKIP ${file}: not in index`); continue; }
    const img = readFileSync(path.join(CACHE_DIR, file));
    // Test fills: within stored range [0.85, 1.0] and outside
    const fills = [0.70, 0.85, 1.00, 1.10];
    const angles = [0, 3, -3];
    let bestDist = Infinity;
    const results = [];
    for (const fill of fills) {
      for (const angle of angles) {
        const hash = await simulateRuntimeHash(img, fill, angle);
        let minDist = Infinity;
        for (const sh of entry.hashes) {
          const d = hammingDistance(hash, sh);
          if (d < minDist) minDist = d;
        }
        results.push({ fill, angle, dist: minDist });
        if (minDist < bestDist) bestDist = minDist;
      }
    }
    totalTests += results.length;
    matchesAtThreshold += results.filter(r => r.dist <= HASH_MATCH_THRESHOLD).length;
    if (bestDist <= 3) buckets['0-3']++;
    else if (bestDist <= 8) buckets['4-8']++;
    else if (bestDist <= 12) buckets['9-12']++;
    else if (bestDist <= 16) buckets['13-16']++;
    else buckets['17+']++;
    const ok = bestDist <= HASH_MATCH_THRESHOLD ? '✅' : '❌';
    console.log(`${ok} ${entry.name.padEnd(28)} best=${bestDist}  ` +
      results.map(r => `${r.fill.toFixed(2)}/${r.angle}°:${r.dist}`).join(' '));
  }
  console.log(`\n--- Summary ---`);
  console.log(`Total (fill,angle) combos: ${totalTests}`);
  console.log(`Within threshold (${HASH_MATCH_THRESHOLD}): ${matchesAtThreshold} (${(100*matchesAtThreshold/totalTests).toFixed(1)}%)`);
  console.log(`\nBest-distance per card (threshold=${HASH_MATCH_THRESHOLD}):`);
  for (const [b, c] of Object.entries(buckets)) {
    console.log(`  ${b.padEnd(5)}: ${'█'.repeat(c)} (${c})`);
  }
  console.log(`\nRandom fill/angle match probability: ${(100*matchesAtThreshold/totalTests).toFixed(1)}%`);
}

main().catch(err => { console.error('Diagnostic failed:', err); process.exit(1); });