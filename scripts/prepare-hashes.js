#!/usr/bin/env node
/**
 * Pre-build perceptual-hash index for DeckSync camera scanning.
 *
 * Builds `public/card-hashes.bin` (compact binary), a local database of 64-bit
 * perceptual hashes (pHash) of card artwork. The camera scanner hashes the
 * central art region of a photographed card and matches it against this file —
 * a fast, network-free second identification channel that runs in parallel
 * with OCR (whichever returns a good result first wins).
 *
 * Each face is hashed once per camera-aspect class (4:3 / 16:9) and once per
 * stored variant (card tilt angle × fill scale), so tilted or slightly
 * mis-sized photos match their own pre-rendered variant at near-perfect
 * distance. The app only ever hashes a single unrotated crop.
 *
 * The index is an append-only stream: as each face image is hashed, its entry
 * record is appended to the END of card-hashes.bin immediately — nothing is
 * held in memory for the whole run and no finished work can be lost. Resume
 * state lives entirely in side-car ledgers under scripts/.cache/ so the served
 * index stays lean (entry lines only, no bookkeeping): a name-level ledger
 * (hashes-done.jsonl) records each name once every printing of it has been
 * processed, and a face-level ledger (hashes-progress.jsonl) records every
 * face that was hashed (accepted or dropped by dedup). Cancelling the run
 * (Ctrl+C / kill) therefore never loses progress: re-running resumes exactly
 * where it left off — complete names are skipped without a single API call,
 * and partially done names only hash faces that were not finished. Downloaded
 * face images are cached in scripts/.cache/hashes/, so even a lost index
 * rebuilds without re-downloading.
 *
 * Target card list:
 *   - DECKSYNC_HASH_CARDS="Card A, Card B" — index exactly these names;
 *   - otherwise the built-in initial test list (a few cards covering old-style,
 *     modern and full-art printings plus a double-faced card) — the full MTG
 *     fetch is deliberately NOT done yet, as the pipeline may need tweaks;
 *   - DECKSYNC_HASH_ALL=1 — index every unique card name from the cached
 *     MTGJSON AtomicCards download (the future full production build).
 *
 * For each target name all English printings with images are searched on
 * Scryfall and the central art region of every face (front + DFC back) is
 * hashed. Hashes within HASH_DEDUP_DISTANCE of an already-accepted hash for
 * the same card are dropped, so reprints sharing artwork collapse to one entry
 * while distinct compositions (e.g. a full-art version) keep their own.
 *
 * Usage:
 *   npm run prepare:hashes                          # incremental, default test list
 *   DECKSYNC_HASH_CARDS="Black Lotus" npm run prepare:hashes
 *
 * Fails soft on network errors — entries appended so far stay in the file and
 * a re-run picks up exactly where the failed one stopped.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import { writeHeader, appendBinRecord, readBinIndex } from './hash-index-bin.js';
import {
  HASH_ART_REGION,
  HASH_ASPECT_CLASSES,
  HASH_DEDUP_DISTANCE,
  HASH_MATCH_THRESHOLD,
  HASH_STORE_ANGLES,
  HASH_STORE_FILLS,
  computePHashFromRGBA,
  hammingDistance
} from '../src/lib/ocr/phash.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Append-only binary index (the artifact served to the app) — see hash-index-bin.js. */
const OUT_FILE = path.join(ROOT, 'public', 'card-hashes.bin');
/** Previous fixed-format index — converted to binary once on first run. */
const LEGACY_OUT_FILE = path.join(ROOT, 'public', 'card-hashes.json');
const CACHE_DIR = path.join(ROOT, 'scripts', '.cache', 'hashes');
/** Face-level progress ledger (accepted + dropped faces) for cancel/resume. */
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.cache', 'hashes-progress.jsonl');
/** Name-level completion ledger — names fully processed in an earlier run, so a
 *  resume skips them without re-downloading/re-hashing. Kept out of the served
 *  index (card-hashes.bin) to keep that artifact lean. */
const DONE_NAMES_FILE = path.join(ROOT, 'scripts', '.cache', 'hashes-done.jsonl');

const SCRYFALL_SEARCH_URL = 'https://api.scryfall.com/cards/search';
const USER_AGENT = 'DeckSync/1.0 (pre-build hash preparation)';
/** Scryfall allows 1 request/second — pace every api.scryfall.com call. */
const API_DELAY_MS = 1100;
const FETCH_TIMEOUT_MS = 2 * 60 * 1000;
/** Max search pages per card (30 printings/page) — caps the worst case. */
const MAX_SEARCH_PAGES = 8;
/** Only these layouts produce scannable single faces (multi-faced layouts are
 *  indexed face-by-face via `card_faces`). */
const ALLOWED_LAYOUTS = new Set(['normal', 'double_faced_card', 'full_art', 'modal_dfc', 'adventure']);

/**
 * Initial test list — deliberately small (no full MTG fetch yet). Covers the
 * frame styles the scanner must handle: old-style printings (Black Lotus /
 * Serra Angel reach back to the 1990s), modern sets (all of them) and
 * full-art versions where Scryfall has them, plus multi-faced cards (a modal
 * DFC whose both faces are hashed, and an adventure card).
 */
const DEFAULT_TEST_CARDS = [
  'Black Lotus',
  'Lightning Bolt',
  'Serra Angel',
  'Jace Beleren',
  'Magik, Illyana Rasputin // Darkchild, Demon Uncaged',
  'Hela, Mistress of Darkness // Dark Tutor'
];

// --- Shared normalization (MUST stay in sync with src/lib/data/cardData.ts) --

function normalizeCardName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// --- Scryfall access ----------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let lastApiCall = 0;

/** Paces api.scryfall.com calls to at most one per second. */
async function paceApi() {
  const wait = lastApiCall + API_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastApiCall = Date.now();
}

async function fetchJson(url) {
  for (let attempt = 0; ; attempt++) {
    await paceApi();
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await sleep(API_DELAY_MS * (attempt + 2));
      continue;
    }
    const err = new Error(`HTTP ${response.status} for ${url}`);
    err.status = response.status; // lets callers tell "no results" (404) apart from real failures
    throw err;
  }
}

/** All English printings of an exact card name (unique=prints, paginated). */
async function searchPrintings(name) {
  const clean = name.replace(/"/g, '');
  // Multi-faced names arrive as "A // B" (MTGJSON style), but Scryfall indexes
  // them with either the double slash or a single "/". Try variants in order —
  // exact full name first, then the single-slash form — and fall back to the
  // front face alone for multi-faced names.
  const multiFaced = clean.includes('//');
  const variants = multiFaced ? [clean, clean.replace('//', ' / ')] : [clean];

  for (const variant of variants) {
    let cards;
    try {
      cards = await searchPrintingsQuery(variant);
    } catch (err) {
      if (!multiFaced) throw err; // single-faced name — surface real errors so they retry next run
      continue;                   // multi-faced: this spelling failed, try the next form
    }
    if (cards.length > 0 || !multiFaced) return cards;
    // Multi-faced name with no results under this spelling — try the next form.
  }

  // Only reached for multi-faced names where neither full-name spelling matched:
  // fall back to the front face, keeping only genuinely multi-faced results. A
  // front-face-only search can also match unrelated single-faced cards that share
  // the front name, so filter those out. (A 404 here yields [] — nothing to hash.)
  const front = clean.split('//')[0].trim();
  return (await searchPrintingsQuery(front)).filter(c => (c.card_faces?.length ?? 0) >= 2);
}

async function searchPrintingsQuery(name) {
  const q = encodeURIComponent(`name:"${name}"`);
  const cards = [];
  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    let json;
    try {
      json = await fetchJson(`${SCRYFALL_SEARCH_URL}?q=${q}&unique=prints&page=${page}`);
    } catch (err) {
      // Scryfall answers a name search with 404 when no card matches that exact
      // name. That is a terminal "nothing to hash" outcome, not a transient
      // failure — return what we have (empty on page 1) instead of throwing so
      // the caller marks the name done and moves on rather than retrying forever.
      if (err.status === 404) return cards;
      throw err;
    }
    const data = json.data ?? [];
    cards.push(...data);
    if (!json.has_more || data.length === 0) break;
  }
  return cards;
}


/** Face image URLs for a printing: front always, plus the back of DFCs. */
function faceImagesFor(card) {
  const faces = [];
  // Some multi-faced printings (e.g. modal DFCs) carry no top-level image —
  // the front lives in card_faces[0] instead.
  const frontUrl = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal;
  if (frontUrl) faces.push({ face: 0, url: frontUrl });
  if (Array.isArray(card.card_faces)) {
    for (let i = 1; i < card.card_faces.length; i++) {
      const url = card.card_faces[i]?.image_uris?.normal;
      if (url) faces.push({ face: i, url });
    }
  }
  return faces;
}

// --- Image cache + hashing ----------------------------------------------------

/** Downloads a face image into the local cache and returns its bytes. */
async function getFaceImage(cardId, face, url) {
  const file = path.join(CACHE_DIR, `${cardId}-f${face}.jpg`);
  if (existsSync(file)) return readFileSync(file);

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, buffer);
  renameSync(tmp, file);
  return buffer;
}

/** Neutral mid-gray "table" background around the card in synthetic renders. */
const BG = { r: 90, g: 85, b: 75 };

/** Width (px) of the synthetic zone canvas used for pre-build renders. */
const ZONE_RENDER_WIDTH = 1024;
// Keep in sync with CARD_ASPECT in src/lib/ocr/cardScanner.ts (2.5" x 3.5").
const CARD_ASPECT = 2.5 / 3.5;

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
 * Renders the official face into a synthetic 5:7 card zone and returns the pHash
 * of HASH_ART_REGION for every stored variant (fill × angle). The card is
 * centered in the zone, scaled to `fill` of the zone height and rotated by
 * `angle` — exactly the geometry the app's framing guide / OCR / pHash crops use
 * (cardZoneForFrame), so a photographed card matches its own variant at
 * near-perfect distance. The zone is camera-independent (always 5:7), so every
 * aspect class carries identical hashes. Variant order: fill outer, angle inner
 * (see HASH_STORE_FILLS / HASH_STORE_ANGLES). Keep in sync with
 * scripts/rebuild-hashes-offline.js.
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

/**
 * True when `hashes` is the same visual family as an accepted entry: for any
 * aspect class, any variant slot (fill/angle position) within distance.
 */
function isDuplicateOf(hashes, acceptedHashes) {
  return acceptedHashes.some(
    other => HASH_ASPECT_CLASSES.some(cls => {
      const a = hashes[cls.key];
      const b = other[cls.key];
      if (!a || !b || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (hammingDistance(a[i], b[i]) <= HASH_DEDUP_DISTANCE) return true;
      }
      return false;
    })
  );
}

/**
 * Processes one card name end to end: searches all English printings with
 * images and hashes the central art region of every face. Each finished face
 * is persisted immediately — accepted entries are appended to
 * card-hashes.bin, faces dropped by dedup only to the progress ledger — so
 * a cancelled run resumes without re-doing any work. Returns per-face counts;
 * `failed > 0` means at least one face errored and the name must NOT get a
 * done marker yet (the next run retries exactly those faces).
 */
async function processName(name, ctx) {
  const printings = await searchPrintings(name);
  const english = printings.filter(
    // Scryfall's search API omits `language` for English cards — missing means English
    c => (!c.language || c.language === 'English') && faceImagesFor(c).length > 0 && ALLOWED_LAYOUTS.has(c.layout ?? 'normal')
  );

  // Seed dedup with the entries this name already has on file, so faces
  // processed after a resume still collapse against pre-existing artwork.
  const key = normalizeCardName(name);
  const acceptedHashes = (ctx.entriesByName.get(key) ?? []).map(e => e.hashes);

  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (const card of english) {
    for (const face of faceImagesFor(card)) {
      const faceKey = `${card.id}|${face.face}`;
      if (ctx.processedKeys.has(faceKey)) {
        skipped++; // already hashed in an earlier (possibly interrupted) run
        continue;
      }
      try {
        const bytes = await getFaceImage(card.id, face.face, face.url);
        const hashes = await buildFaceHashes(bytes);
        if (isDuplicateOf(hashes, acceptedHashes)) {
          appendLine(PROGRESS_FILE, { id: card.id, face: face.face, name, status: 'dropped' });
        } else {
          acceptedHashes.push(hashes);
          // Durable the moment the image is hashed — no work lost on cancel.
          appendBinRecord(OUT_FILE, { id: card.id, name, face: face.face, hashes });
          appendLine(PROGRESS_FILE, { id: card.id, face: face.face, name, status: 'accepted' });
          added++;
        }
        ctx.processedKeys.add(faceKey);
      } catch (err) {
        failed++;
        console.warn(`[prepare-hashes]     ${card.id} face ${face.face}: ${err.message}`);
      }
    }
  }
  if (failed === 0) appendLine(DONE_NAMES_FILE, { type: 'done', name });
  ctx.entriesByName.delete(key); // no longer needed — frees memory on long runs
  return { added, skipped, failed, noMatch: printings.length === 0 };
}

/** All unique card names from the cached MTGJSON AtomicCards download. */
async function allCardNames() {
  const file = path.join(ROOT, 'scripts', '.cache', 'AtomicCards.json.gz');
  let buffer;
  if (existsSync(file)) {
    buffer = readFileSync(file);
  } else {
    console.log('[prepare-hashes] downloading MTGJSON AtomicCards.json.gz ...');
    const response = await fetch('https://mtgjson.com/api/v5/AtomicCards.json.gz', {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5 * 60 * 1000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for AtomicCards.json.gz`);
    buffer = Buffer.from(await response.arrayBuffer());
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, buffer);
  }
  const json = JSON.parse(gunzipSync(buffer).toString('utf8'));
  if (!json.data || typeof json.data !== 'object') throw new Error('Unexpected AtomicCards.json shape');
  return Object.keys(json.data);
}

// --- JSONL index file -----------------------------------------------------------

/** Writes the binary header when the index file is new or empty (resume-safe). */
function ensureIndexFile() {
  if (!existsSync(OUT_FILE) || readFileSync(OUT_FILE).length === 0) writeHeader(OUT_FILE);
}

/** Appends one JSON record as a line — durable immediately (resume-safe). */
function appendLine(file, record) {
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** Reads a JSONL file line by line. Malformed lines (e.g. a torn write from a
 *  killed process) are skipped with a warning instead of failing the run. */
function readJsonl(file) {
  const records = [];
  if (!existsSync(file)) return records;
  for (const [i, raw] of readFileSync(file, 'utf8').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      console.warn(`[prepare-hashes] ${path.relative(ROOT, file)}: skipping malformed line ${i + 1}`);
    }
  }
  return records;
}

/**
 * One-time migration of the old fixed-format card-hashes.json into the new
 * append-only JSONL file. Migrated entries get ledger lines too, so their
 * faces are not re-hashed on the next run. The legacy file is removed once
 * the conversion has been verified line by line.
 */
function migrateLegacyFile() {
  if (existsSync(OUT_FILE) || !existsSync(LEGACY_OUT_FILE)) return;
  let legacy;
  try {
    legacy = JSON.parse(readFileSync(LEGACY_OUT_FILE, 'utf8'));
  } catch (err) {
    console.warn(`[prepare-hashes] legacy card-hashes.json is unreadable (${err.message}) — leaving it in place`);
    return;
  }
  const valid = (Array.isArray(legacy?.entries) ? legacy.entries : []).filter(e => e?.id && e.hashes);
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeHeader(OUT_FILE);
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const e of valid) {
    appendBinRecord(OUT_FILE, e);
    appendLine(PROGRESS_FILE, { id: e.id, face: e.face ?? 0, name: e.name ?? '', status: 'accepted' });
  }
  const migrated = readBinIndex(OUT_FILE).records.filter(r => r?.id && r.hashes).length;
  if (migrated === valid.length) {
    unlinkSync(LEGACY_OUT_FILE);
    console.log(`[prepare-hashes] migrated ${migrated} entries: card-hashes.json → card-hashes.bin`);
  } else {
    console.warn(`[prepare-hashes] migration mismatch (${migrated}/${valid.length}) — keeping card-hashes.json`);
  }
}

// --- Main ----------------------------------------------------------------------

async function main() {
  const started = Date.now();

  migrateLegacyFile();
  mkdirSync(CACHE_DIR, { recursive: true });
  ensureIndexFile();

  // Load existing progress. The binary index is decoded to hex hashes so the
  // per-name dedup seeding below works exactly as before.
  const records = readBinIndex(OUT_FILE).records;
  const entriesByName = new Map(); // normalized name -> entry[]
  let entryCount = 0;
  for (const rec of records) {
    if (rec?.id && rec.hashes && typeof rec.name === 'string') {
      entryCount++;
      const key = normalizeCardName(rec.name);
      if (!entriesByName.has(key)) entriesByName.set(key, []);
      entriesByName.get(key).push(rec);
    }
  }
  // Name-level completion ledger (kept out of the served index): names fully
  // processed in an earlier run are skipped on resume.
  const doneNames = new Set();
  for (const rec of readJsonl(DONE_NAMES_FILE)) {
    if (rec?.type === 'done' && typeof rec.name === 'string') {
      doneNames.add(normalizeCardName(rec.name));
    }
  }
  // Face-level ledger: every face already hashed (accepted or dropped), so a
  // resume never downloads or hashes it again.
  const processedKeys = new Set();
  for (const rec of readJsonl(PROGRESS_FILE)) {
    if (rec?.id != null && rec.face != null) processedKeys.add(`${rec.id}|${rec.face}`);
  }

  let targets;
  // NOTE: on Windows, `set DECKSYNC_HASH_ALL=1 && node ...` (as used by the
  // npm script) assigns the value "1" WITH a trailing space — cmd folds the
  // space before && into the variable. Trim so the check is robust to that.
  if ((process.env.DECKSYNC_HASH_ALL || '').trim() === '1') {
    targets = await allCardNames();
  } else if (process.env.DECKSYNC_HASH_CARDS) {
    targets = process.env.DECKSYNC_HASH_CARDS.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    targets = DEFAULT_TEST_CARDS;
  }

  const toProcess = [...new Set(targets.filter(n => !doneNames.has(normalizeCardName(n))))];
  const total = toProcess.length;
  console.log(
    `[prepare-hashes] ${entryCount} entries on file, ` +
      `${targets.length - toProcess.length}/${targets.length} names complete, ${total} to process`
  );

  // A full run takes hours. stdout can be block-buffered in some terminals
  // (npm/PowerShell), so also append a heartbeat to a log file that flushes to
  // disk immediately — watch live with:
  //   Get-Content -Wait scripts/.cache/prepare-hashes-progress.log
  const progressLog = path.join(ROOT, 'scripts', '.cache', 'prepare-hashes-progress.log');
  writeFileSync(progressLog, ''); // fresh log for this run

  let added = 0;
  let skipped = 0;
  let noMatch = 0;
  let failedNames = 0;
  let processed = 0;
  let currentName = '(starting)';
  const statusLine = () => {
    const elapsed = (Date.now() - started) / 1000;
    const rate = elapsed > 0 ? processed / elapsed : 0; // names per second
    const leftMin = rate > 0 ? (total - processed) / rate / 60 : 0;
    return `[prepare-hashes] ${processed}/${total} ` +
      `(${Math.round((processed / total) * 100)}%) — +${added} hashes, ${noMatch} no-match, ` +
      `${failedNames} failed — ${elapsed.toFixed(0)}s elapsed` +
      (rate > 0 ? `, ~${leftMin.toFixed(0)} min left` : '') +
      ` — on "${currentName}"`;
  };
  // Time-based heartbeat: fires every 15s even while a single name is being
  // fetched, so a slow or hung request (up to FETCH_TIMEOUT_MS = 2min) never
  // looks like the run is stuck. setInterval callbacks fire between awaits.
  const ticker = setInterval(() => {
    const msg = statusLine();
    console.log(msg);
    appendFileSync(progressLog, msg + '\n');
  }, 15000);
  {
    const msg = statusLine(); // immediate first line so the log is never empty
    console.log(msg);
    appendFileSync(progressLog, msg + '\n');
  }

  for (const name of toProcess) {
    currentName = name;
    try {
      const res = await processName(name, { entriesByName, processedKeys });
      added += res.added;
      skipped += res.skipped;
      if (res.noMatch) {
        noMatch++; // Scryfall has no card by this exact name — marked done, nothing to retry
      } else {
        if (res.failed) failedNames++;
        console.log(
          `[prepare-hashes]   ${name}: +${res.added} entries` +
            (res.skipped ? `, ${res.skipped} faces already done` : '') +
            (res.failed ? `, ${res.failed} FAILED — will retry next run` : '')
        );
      }
    } catch (err) {
      failedNames++;
      console.warn(`[prepare-hashes]   ${name}: FAILED (${err.message}) — will retry next run`);
    }
    processed++;
  }
  clearInterval(ticker);

  console.log(
    `[prepare-hashes] done: ${entryCount + added} entries in ${path.relative(ROOT, OUT_FILE)}, ` +
      `${added} new this run (${skipped} faces skipped as already hashed), ` +
      `${noMatch} names had no Scryfall match (marked done), ${failedNames} names failed — ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}

// Ctrl+C: everything appended so far is durable — just re-run to resume.
process.on('SIGINT', () => {
  console.log('\n[prepare-hashes] interrupted — all completed entries are saved; re-run to resume where it stopped');
  process.exit(130);
});

main().catch(err => {
  if (existsSync(OUT_FILE)) {
    console.warn(
      `[prepare-hashes] FAILED (${err.message}) — keeping ${path.relative(ROOT, OUT_FILE)} ` +
        '(append-only: completed entries are safe, re-run to resume)'
    );
    return;
  }
  console.error(`[prepare-hashes] FAILED and no previous ${path.relative(ROOT, OUT_FILE)} exists: ${err.message}`);
  process.exitCode = 1;
});