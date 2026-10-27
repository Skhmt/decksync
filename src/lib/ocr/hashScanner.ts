/**
 * Runtime pHash identification for camera frames. Crops the hashed art region
 * out of a full frame (the same geometry scripts/prepare-hashes.js rendered),
 * hashes it once with computePHashFromRGBA and matches against the local
 * index — typically well under 100 ms per frame, no network involved.
 *
 * Tilt tolerance comes from the on-device perspective warp (cardWarp.ts), which
 * re-renders each frame upright before hashing; size tolerance comes from the
 * stored fill variants. The app side only ever hashes a single crop per frame.
 * Multiple frames vote; the card with the most votes wins (ties break on lowest
 * average distance).
 */

import { ensureCardHashes, type CardHashEntry, type PackedClass } from '../data/cardHashes';
import { cardZoneForFrame } from './cardScanner';
import {
  computePHashFromRGBA,
  hammingPacked,
  hashAspectClassKey,
  splitHash,
  type PixelBuffer
} from './phash';

/** Best match found for one frame. */
export interface HashFrameMatch {
  entry: CardHashEntry;
  /** Hamming distance (0–64) to the closest stored variant */
  distance: number;
}

/** Final identification result across all frames. */
export interface HashScanResult {
  entry: CardHashEntry;
  /** Best distance seen for the winning card */
  distance: number;
  /** How many of the input frames voted for this card */
  votes: number;
}

/** Max width (px) a crop is downscaled to before hashing — keeps hashing cheap. */
const MAX_CROP_WIDTH = 640;

/**
 * Crops the hashed region out of a full-frame canvas. The region (fractions of
 * the card zone, from the loaded index) is mapped onto the full frame using the
 * same true 5:7 card rectangle the framing guide and OCR regions use — see
 * cardZoneForFrame() in cardScanner.ts. Returns null when the crop is too small
 * to be meaningful.
 */
function cropHashRegion(
  frame: HTMLCanvasElement,
  region: { x0: number; y0: number; x1: number; y1: number }
): PixelBuffer | null {
  // Follow the on-screen card zone — a true 5:7 card rectangle for this frame's
  // aspect (see cardZoneForFrame) — so the hashed crop matches exactly where the
  // user lines the card up against the dashed guide, and the geometry the index
  // was built with (scripts/rebuild-hashes-offline.js / prepare-hashes.js).
  const zone = cardZoneForFrame(frame.width / frame.height);
  const fx0 = zone.x0 + region.x0 * (zone.x1 - zone.x0);
  const fy0 = zone.y0 + region.y0 * (zone.y1 - zone.y0);
  const fx1 = zone.x0 + region.x1 * (zone.x1 - zone.x0);
  const fy1 = zone.y0 + region.y1 * (zone.y1 - zone.y0);

  const sx = frame.width * fx0;
  const sy = frame.height * fy0;
  const sw = frame.width * (fx1 - fx0);
  const sh = frame.height * (fy1 - fy0);
  if (sw < 32 || sh < 32) return null;

  const scale = Math.min(1, MAX_CROP_WIDTH / sw);
  const w = Math.max(8, Math.round(sw * scale));
  const h = Math.max(8, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  return { data: img.data, width: w, height: h };
}

/**
 * Minimum luma dynamic range (1st–99th percentile) for a crop to plausibly
 * contain card artwork. A blank table, empty frame, or a hand has a near-
 * constant luma distribution and would otherwise hash-match some stored face
 * by chance; rejecting it routes the frame to OCR instead. Real card art always
 * spans far more than this across the central region, so this is conservative
 * enough not to cost recall.
 */
const MIN_CONTENT_RANGE = 24;

/** True when the crop has enough luma spread to plausibly contain card art. */
export function hasCardContent(pix: PixelBuffer): boolean {
  const { data, width, height } = pix;
  const n = width * height;
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // Luma — same weights as the OCR preprocessing in cardScanner.ts.
    hist[(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0]++;
  }
  const total = n;
  let lo = 0;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * 0.01) { lo = v; break; }
  }
  let hi = 255;
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= total * 0.01) { hi = v; break; }
  }
  return hi - lo >= MIN_CONTENT_RANGE;
}

/** Finds the closest index entry for one frame (null when nothing is close enough). */
function matchFrame(
  frame: HTMLCanvasElement,
  classKey: string,
  entries: CardHashEntry[],
  packed: Record<string, PackedClass>,
  region: { x0: number; y0: number; x1: number; y1: number },
  threshold: number
): HashFrameMatch | null {
  const pix = cropHashRegion(frame, region);
  if (!pix) return null;
  // Reject near-uniform crops (blank table, empty frame, hand) before hashing —
  // they'd otherwise match some stored face by chance. OCR handles the fallback.
  if (!hasCardContent(pix)) return null;
  const hash = computePHashFromRGBA(pix);

  // Scan the packed per-class arrays (SoA) with a tight numeric Hamming loop —
  // ~200× faster than the old per-bit string scan over every entry's variants.
  const pc = packed[classKey];
  if (!pc || pc.hi.length === 0) return null;
  const [qHi, qLo] = splitHash(hash);
  let bestDist = 65;
  let bestSlot = -1;
  for (let i = 0; i < pc.hi.length; i++) {
    const d = hammingPacked(pc.hi[i], pc.lo[i], qHi, qLo);
    if (d < bestDist) {
      bestDist = d;
      bestSlot = i;
    }
  }
  if (bestSlot < 0 || bestDist > threshold) return null;
  return { entry: entries[pc.owner[bestSlot]], distance: bestDist };
}

/**
 * Identifies a card from one or more full-frame canvases. `frameAspect` is the
 * camera's videoWidth/videoHeight — it selects which aspect class of stored
 * hashes to match against. Resolves null when the index isn't loaded or no
 * frame comes within threshold (the OCR channel then carries the scan).
 */
export async function identifyByHash(
  frames: HTMLCanvasElement[],
  frameAspect: number
): Promise<HashScanResult | null> {
  const idx = await ensureCardHashes();
  if (!idx.ready || idx.entries.length === 0) return null;

  const classKey = hashAspectClassKey(frameAspect);
  // Votes per entry id (a card can have several face entries — front + DFC back)
  const votes = new Map<string, { card: string; count: number; totalDist: number }>();
  let bestEntry: CardHashEntry | null = null;
  let bestDistance = Infinity;

  for (const frame of frames) {
    const m = matchFrame(frame, classKey, idx.entries, idx.packed, idx.region, idx.threshold);
    if (!m) continue;
    const v = votes.get(m.entry.id) ?? { card: m.entry.id, count: 0, totalDist: 0 };
    v.count++;
    v.totalDist += m.distance;
    votes.set(m.entry.id, v);
    if (m.distance < bestDistance) {
      bestDistance = m.distance;
      bestEntry = m.entry;
    }
  }

  if (!bestEntry || votes.size === 0) return null;

  // Most votes wins; ties break on the lower average distance of the votes
  let winner: { card: string; count: number; totalDist: number } | null = null;
  for (const v of votes.values()) {
    if (!winner || v.count > winner.count || (v.count === winner.count && v.totalDist < winner.totalDist)) {
      winner = v;
    }
  }
  if (!winner) return null;

  // Prefer the voting entry whose id matches the winner when several faces share it
  const entry = idx.entries.find(e => e.id === winner.card) ?? bestEntry;
  return { entry, distance: bestDistance, votes: winner.count };
}