/**
 * Pure build/parse routines for the local card data assets. Kept free of any
 * fetch/DOM so the exact same code runs in a Web Worker (fast path) and on the
 * main thread (fallback when workers are unavailable). The heavy work — JSON
 * parsing, per-name normalization, and walking/packing the ~12 MB hash index —
 * lives here so it can be executed off the UI thread.
 */

import {
  HASH_ART_REGION,
  HASH_ASPECT_CLASSES,
  HASH_MATCH_THRESHOLD,
  type FrameRectLike
} from '../ocr/phash';

// ---------------------------------------------------------------------------
// Card database (card-data.json → names Set + printings Map)
// ---------------------------------------------------------------------------

/** The on-disk shape of card-data.json. */
export interface CardDataFile {
  names?: string[];
  printings?: Record<string, string>;
}

/**
 * Normalizes a card name for the database: lowercase, diacritics stripped,
 * alphanumerics only. MUST stay in sync with scripts/prepare-data.js — the
 * names array is stored pre-normalized, so lookups must apply the same form.
 */
export function normalizeCardName(name: string): string {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Builds the in-memory validation structures from a parsed card-data.json. */
export function buildCardDatabase(
  file: CardDataFile
): { names: Set<string>; printings: Map<string, string> } {
  const names = new Set<string>();
  for (const name of file.names ?? []) {
    const key = normalizeCardName(name);
    if (key) names.add(key);
  }

  const printings = new Map<string, string>();
  for (const [key, scryfallId] of Object.entries(file.printings ?? {})) {
    if (scryfallId) printings.set(key.toLowerCase(), scryfallId);
  }

  return { names, printings };
}

// ---------------------------------------------------------------------------
// Hash index (card-hashes.bin → packed per-class SoA arrays)
// ---------------------------------------------------------------------------

/** One unique visual face in the hash index. Only the id is kept at runtime —
 *  matching is purely visual (packed hashes); name/face live only in the
 *  build-time file layout, not in this object. */
export interface CardHashEntry {
  /** Scryfall id of the printing this artwork came from (shared by DFC faces) */
  id: string;
}

/**
 * Packed 32-bit-word representation of one aspect class's hashes (structure of
 * arrays). `hi`/`lo` hold each stored hash as two uint32 words so a frame scan
 * is a tight numeric loop (see hammingPacked) instead of per-bit string slicing.
 * `owner[i]` maps slot i back to the index into `entries` that owns it.
 */
export interface PackedClass {
  hi: Uint32Array;
  lo: Uint32Array;
  owner: Int32Array;
}

/** Loaded index. `ready` is false when card-hashes.bin couldn't be loaded. */
export interface CardHashIndex {
  ready: boolean;
  entries: CardHashEntry[];
  /** Hashed region (fractions of the card zone) — from the file, code fallback */
  region: FrameRectLike;
  /** Max Hamming distance for a match — from the file, code fallback */
  threshold: number;
  /** Packed per-class arrays for fast Hamming scans (built once at load). */
  packed: Record<string, PackedClass>;
}

/** "DCH1" — first four bytes of card-hashes.bin. */
const BIN_MAGIC = [0x44, 0x43, 0x48, 0x31];
/** magic(4) + version(4) + region(4×f64=32) + threshold(4). */
const BIN_HEADER_LEN = 44;

/** One record's parsed shape: its id plus, per class, the byte offset of its SoA
 *  hi/lo word block and how many hashes it holds (`off` is absolute in the file). */
interface BinRecord {
  id: string;
  blocks: { key: string; count: number; off: number }[];
}

/**
 * Walks the .bin body, returning one descriptor per whole record (a torn final
 * record from an interrupted build is dropped). Numeric fields are read
 * little-endian via `dv`; ids are decoded as UTF-8. Mirrors
 * scripts/hash-index-bin.js byte for byte.
 */
function parseRecords(bytes: Uint8Array, dv: DataView): BinRecord[] {
  const classKeys = HASH_ASPECT_CLASSES.map(c => c.key);
  const decoder = new TextDecoder();
  const records: BinRecord[] = [];
  let pos = BIN_HEADER_LEN;
  while (pos + 4 <= bytes.length) {
    const bodyLen = dv.getUint32(pos, true);
    if (bodyLen < 8 || pos + 4 + bodyLen > bytes.length) break; // torn trailing record
    let o = pos + 4;
    const idLen = dv.getUint16(o, true); o += 2;
    const id = decoder.decode(bytes.subarray(o, o + idLen)); o += idLen;
    o += 4; // face (u32) — not needed at runtime
    const nameLen = dv.getUint16(o, true); o += 2;
    o += nameLen; // name — not needed at runtime
    const blocks: BinRecord['blocks'] = [];
    let ok = true;
    for (const key of classKeys) {
      if (o + 2 > pos + 4 + bodyLen) { ok = false; break; }
      const count = dv.getUint16(o, true); o += 2;
      blocks.push({ key, count, off: o }); // hi words at off, lo words at off + count*4
      o += count * 8;
    }
    if (!ok) break;
    records.push({ id, blocks });
    pos = o;
  }
  return records;
}

/**
 * Parses a card-hashes.bin buffer into a ready-to-scan index. Throws when the
 * header is missing/unrecognized (callers then degrade to OCR-only). Builds the
 * packed per-class SoA arrays once so frame scans are a tight numeric loop —
 * no hex strings are ever materialized at runtime.
 */
export function parseHashIndex(buf: ArrayBuffer): CardHashIndex {
  const bytes = new Uint8Array(buf);
  if (bytes.length < BIN_HEADER_LEN || !BIN_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new Error('card-hashes.bin has an unrecognized header');
  }

  let region: FrameRectLike = HASH_ART_REGION;
  let threshold = HASH_MATCH_THRESHOLD;
  const dv = new DataView(buf);
  // Region + threshold come from the header; cap the threshold at the code
  // constant so a stale value in an old build can't loosen it.
  const rx = dv.getFloat64(8, true), ry = dv.getFloat64(16, true);
  const rx1 = dv.getFloat64(24, true), ry1 = dv.getFloat64(32, true);
  if ([rx, ry, rx1, ry1].every(Number.isFinite)) region = { x0: rx, y0: ry, x1: rx1, y1: ry1 };
  threshold = Math.min(dv.getUint32(40, true), HASH_MATCH_THRESHOLD);

  const records = parseRecords(bytes, dv);
  const classKeys = HASH_ASPECT_CLASSES.map(c => c.key);
  const totals: Record<string, number> = {};
  for (const k of classKeys) totals[k] = 0;
  for (const r of records) for (const b of r.blocks) totals[b.key] += b.count;

  const packed: Record<string, PackedClass> = {};
  const cursor: Record<string, number> = {};
  for (const k of classKeys) {
    packed[k] = { hi: new Uint32Array(totals[k]), lo: new Uint32Array(totals[k]), owner: new Int32Array(totals[k]) };
    cursor[k] = 0;
  }
  const entries: CardHashEntry[] = records.map(r => ({ id: r.id }));
  for (let ei = 0; ei < records.length; ei++) {
    for (const b of records[ei].blocks) {
      const c = packed[b.key];
      const base = cursor[b.key];
      for (let i = 0; i < b.count; i++) {
        c.hi[base + i] = dv.getUint32(b.off + i * 4, true);
        c.lo[base + i] = dv.getUint32(b.off + b.count * 4 + i * 4, true);
        c.owner[base + i] = ei;
      }
      cursor[b.key] += b.count;
    }
  }

  return { ready: entries.length > 0, entries, region, threshold, packed };
}