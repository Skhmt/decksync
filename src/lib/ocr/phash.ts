/**
 * Perceptual hashing (pHash) core for DeckSync card identification.
 *
 * Pure math over RGBA pixel buffers — no DOM, Node, or image-decoding
 * dependencies — so the exact same code runs in the browser (camera frames via
 * canvas) and in the pre-build script scripts/prepare-hashes.js (official card
 * images decoded with sharp). Identical input pixels therefore produce
 * bit-identical hashes on both platforms.
 *
 * Algorithm: luma → bilinear downscale to 32×32 → 2D DCT → keep the lowest
 * 8×8 frequencies (excluding DC) → threshold each against their median →
 * 64-bit hash stored as a 16-char hex string. Similar images differ by only a
 * few Hamming bits, so matching tolerates small rotation, rescale, JPEG
 * artifacts and lighting shifts. Tilted cards are handled by storing
 * pre-rotated hash variants at build time (see HASH_STORE_ANGLES /
 * HASH_STORE_FILLS), so the app only ever hashes a single unrotated crop.
 */

export interface PixelBuffer {
  /** RGBA, row-major, tightly packed (width*height*4 entries) */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** A rectangle expressed as fractions of its parent area (0–1). */
export interface FrameRectLike {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The card-zone region (fractions of the 5:7 card zone, cardZoneForFrame())
 * hashed for identification. The user lines the card up against the dashed
 * guide so it fills the zone; this box then covers the central art area — inside
 * the art window of every frame style (old frames, modern frames, full-art),
 * never touching the name bar or text box. MUST stay in sync with the build
 * scripts (scripts/prepare-hashes.js and scripts/rebuild-hashes-offline.js),
 * which crop the same fractions out of a synthetic 5:7 zone render (the values
 * are also written into card-hashes.bin so the app reads them from there).
 */
export const HASH_ART_REGION = { x0: 0.25, y0: 0.20, x1: 0.75, y1: 0.60 };

/**
 * Camera aspect classes — kept for binary-index format compatibility. The card
 * zone is now a true 5:7 rectangle (cardZoneForFrame) whose shape does NOT depend
 * on the camera aspect, so every class carries identical hashes and the app can
 * match against whichever class hashAspectClassKey() selects. `r` is the legacy
 * per-class zone width/height ratio (no longer used by the build); the two keys
 * simply preserve the two-slot layout of card-hashes.bin.
 */
export const HASH_ASPECT_CLASSES = [
  { key: '43', r: (0.64 * (4 / 3)) / 0.8, maxR: 1.2 },
  { key: '169', r: (0.64 * (16 / 9)) / 0.8, maxR: Infinity }
];

/** Picks the aspect-class key for a frame width/height ratio. */
export function hashAspectClassKey(frameAspect: number): string {
  const r = (0.64 * frameAspect) / 0.8;
  for (const c of HASH_ASPECT_CLASSES) {
    if (r <= c.maxR) return c.key;
  }
  return HASH_ASPECT_CLASSES[HASH_ASPECT_CLASSES.length - 1].key;
}

/**
 * Pre-build variant grid: stored hashes are rendered with the card rotated by
 * each angle (tilt tolerance — a tilted photo matches its own angle variant at
 * near-perfect distance) and scaled to each fill of the zone height (the user
 * may hold the card slightly smaller than the guide). Variant order in the
 * stored arrays: fill outer, angle inner.
 */
export const HASH_STORE_ANGLES = [-8, -4, 0, 4, 8];
export const HASH_STORE_FILLS = [1.15, 1.0, 0.85, 0.70];

/**
 * Max Hamming distance (of 64 bits) for a hash to count as a match.
 *
 * Kept tight on purpose: the index holds ~230k hashes per aspect class, so at a
 * loose threshold non-card crops (blank table, hand, empty frame) land within
 * range of some stored face by pure chance and produce false positives. Real
 * cards match their own pre-rotated/pre-scaled variant at near-zero distance,
 * so 8 trades almost no recall for a large drop in accidental matches. Must
 * stay >= HASH_DEDUP_DISTANCE below or a card's own variants could be split
 * across families at build time.
 */
export const HASH_MATCH_THRESHOLD = 8;

/** Pre-build dedupe: hashes within this distance are the same visual family. */
export const HASH_DEDUP_DISTANCE = 8;

const DCT_SIZE = 32;

let cosTable: Float64Array | null = null;

function getCosTable(): Float64Array {
  if (!cosTable) {
    cosTable = new Float64Array(DCT_SIZE * DCT_SIZE);
    for (let u = 0; u < DCT_SIZE; u++) {
      const off = u * DCT_SIZE;
      for (let x = 0; x < DCT_SIZE; x++) {
        cosTable[off + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_SIZE));
      }
    }
  }
  return cosTable;
}

/** Bilinear sample of a single-channel buffer with edge clamping. */
function sampleBilinear(src: Float64Array, sw: number, sh: number, sx: number, sy: number): number {
  const cx = Math.min(Math.max(sx, 0), sw - 1e-6);
  const cy = Math.min(Math.max(sy, 0), sh - 1e-6);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, sw - 1);
  const y1 = Math.min(y0 + 1, sh - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const top = src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx;
  const bottom = src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Bilinear downscale to n×n (pixel-center mapping, edge clamped). */
function bilinearResize(src: Float64Array, sw: number, sh: number, n: number): Float64Array {
  const out = new Float64Array(n * n);
  const xr = sw / n;
  const yr = sh / n;
  for (let y = 0; y < n; y++) {
    const sy = (y + 0.5) * yr - 0.5;
    const rowOff = y * n;
    for (let x = 0; x < n; x++) {
      out[rowOff + x] = sampleBilinear(src, sw, sh, (x + 0.5) * xr - 0.5, sy);
    }
  }
  return out;
}

/**
 * Unnormalized separable 2D DCT (type II). Output is indexed [v][u] with v the
 * vertical and u the horizontal frequency — only the low-frequency block is
 * ever used downstream, so no normalization is applied.
 */
function dct2d(f: Float64Array): Float64Array {
  const n = DCT_SIZE;
  const cos = getCosTable();

  // Transform rows
  const tmp = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    const rowOff = y * n;
    for (let u = 0; u < n; u++) {
      let sum = 0;
      const cosOff = u * n;
      for (let x = 0; x < n; x++) sum += f[rowOff + x] * cos[cosOff + x];
      tmp[rowOff + u] = sum;
    }
  }

  // Transform columns, transposing into F(v, u) layout
  const out = new Float64Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let v = 0; v < n; v++) {
      let sum = 0;
      const cosOff = v * n;
      for (let y = 0; y < n; y++) sum += tmp[y * n + x] * cos[cosOff + y];
      out[v * n + x] = sum;
    }
  }
  return out;
}

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = 0;
  for (let b = i; b; b &= b - 1) c++;
  POPCOUNT[i] = c;
}

/** Hamming distance between two 16-char hex hashes (0–64). */
export function hammingDistance(a: string, b: string): number {
  if (a === b) return 0;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    dist += POPCOUNT[parseInt(a.slice(i * 2, i * 2 + 2), 16) ^ parseInt(b.slice(i * 2, i * 2 + 2), 16)];
  }
  return dist;
}

/** 16-bit popcount table (built once) — the workhorse for fast Hamming distance. */
let PC16: Uint8Array | null = null;
function pc16(): Uint8Array {
  if (!PC16) {
    PC16 = new Uint8Array(1 << 16);
    for (let i = 1; i < PC16.length; i++) PC16[i] = PC16[i >> 1] + (i & 1);
  }
  return PC16;
}

/** Split a 16-char hex hash into its two 32-bit words [hi, lo]. */
export function splitHash(hash: string): [number, number] {
  return [parseInt(hash.slice(0, 8), 16) >>> 0, parseInt(hash.slice(8), 16) >>> 0];
}

/**
 * Hamming distance (0–64) between two hashes given as packed 32-bit words.
 * Two XORs + four 16-bit popcount lookups — no per-bit string slicing/parsing,
 * so a full-index scan is ~200× cheaper than the string version.
 */
export function hammingPacked(hiA: number, loA: number, hiB: number, loB: number): number {
  if (hiA === hiB && loA === loB) return 0;
  const t = pc16();
  const x = hiA ^ hiB;
  const y = loA ^ loB;
  return t[x & 0xffff] + t[(x >>> 16) & 0xffff] + t[y & 0xffff] + t[(y >>> 16) & 0xffff];
}

/** Pack an array of 16-char hex hashes into two parallel 32-bit word arrays. */
export function packHashes(hashes: string[]): { hi: Uint32Array; lo: Uint32Array } {
  const n = hashes.length;
  const hi = new Uint32Array(n);
  const lo = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    hi[i] = parseInt(hashes[i].slice(0, 8), 16) >>> 0;
    lo[i] = parseInt(hashes[i].slice(8), 16) >>> 0;
  }
  return { hi, lo };
}


/**
 * Computes the 64-bit perceptual hash of an RGBA buffer as a 16-char hex
 * string. The input is downsampled internally to 32×32, so callers may pass
 * any resolution (typically the cropped card-art region).
 */
export function computePHashFromRGBA(pix: PixelBuffer): string {
  const { data, width: sw, height: sh } = pix;
  if (!sw || !sh || data.length < sw * sh * 4) return '0'.repeat(16);

  // Luma (same weights as the OCR preprocessing in cardScanner.ts)
  const src = new Float64Array(sw * sh);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    src[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const small = bilinearResize(src, sw, sh, DCT_SIZE);
  const dct = dct2d(small);

  // Median of the low-frequency block (63 values, DC excluded)
  const vals: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      if (v || u) vals.push(dct[v * DCT_SIZE + u]);
    }
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[31];

  // Fixed bit order: v outer, u inner, (0,0) skipped — MSB-first into bytes
  const bytes = new Uint8Array(8);
  let bit = 0;
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      if (!v && !u) continue;
      if (dct[v * DCT_SIZE + u] > median) bytes[bit >> 3] |= 1 << (7 - (bit & 7));
      bit++;
    }
  }

  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
