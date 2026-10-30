#!/usr/bin/env node
/**
 * Pre-build data preparation for DeckSync.
 *
 * Downloads MTGJSON v5 card data and generates `public/card-data.json`, a small
 * local database the app loads on launch to minimize Scryfall API calls:
 *
 *   - `names`: an array of normalized card names, loaded into a Set on page
 *     load for O(1) card-name validity checks (OCR'd readings that match no
 *     known card are rejected before any network request is made). Names are
 *     stored in their normalized form (lowercase, diacritics and punctuation
 *     stripped) so OCR noise like a missing apostrophe can still be validated.
 *     Double-faced face names are included so a photo of one face validates too.
 *
 *   - `printings`: a dictionary keyed by `<set code>:<collector number>`
 *     (lowercased) with the Scryfall card id as the value, loaded into a Map on
 *     page load. A parsed set + collector number is validated against it for
 *     free; known printings resolve via a single `GET /cards/{id}` (or the
 *     local IndexedDB cache — zero API calls), unknown pairs are skipped.
 *
 * Sources (all MTGJSON v5, https://mtgjson.com/api/v5/):
 *   - AtomicCards.json.gz       -> card names (unique English names + face names)
 *   - csv/cards.csv.gz          -> per-printing rows: language, setCode, number, uuid
 *   - csv/cardIdentifiers.csv.gz-> uuid -> scryfallId
 *
 * NOTE on sources: MTGJSON v5.3+ restructured AtomicCards.json into a
 * name-keyed document that no longer carries collector numbers or Scryfall
 * ids, so the printings dictionary is built from the v5 CSV exports above
 * (joined by card uuid). The files are fetched in their .gz form (~87 MB total
 * download) and cached in scripts/.cache/ for CACHE_TTL_MS before re-downloading.
 *
 * Usage:
 *   npm run prepare:data                      # auto-runs before `dev` and `build`
 *   DECKSYNC_FORCE_DATA=1 npm run prepare:data  # ignore the cache, re-download
 *
 * Fails soft on network errors when a cached copy or an existing
 * public/card-data.json is available (offline dev / CI without network), so a
 * stale-but-present database is always preferred over none.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'public', 'card-data.json');
const CACHE_DIR = path.join(ROOT, 'scripts', '.cache');

const MTGJSON_BASE = 'https://mtgjson.com/api/v5';
const USER_AGENT = 'DeckSync/1.0 (pre-build card data preparation)';
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
/** Re-download cached sources after this long (new sets / data fixes). */
const CACHE_TTL_MS = 1 * 24 * 60 * 60 * 1000;

const SOURCES = [
  { key: 'atomicCards', url: `${MTGJSON_BASE}/AtomicCards.json.gz`, file: 'AtomicCards.json.gz' },
  { key: 'cardsCsv', url: `${MTGJSON_BASE}/csv/cards.csv.gz`, file: 'cards.csv.gz' },
  { key: 'identifiersCsv', url: `${MTGJSON_BASE}/csv/cardIdentifiers.csv.gz`, file: 'cardIdentifiers.csv.gz' }
];

// --- Shared normalization (MUST stay in sync with src/lib/data/cardData.ts) --

/** Lowercase, strip diacritics, keep alphanumerics only — the Set key format. */
function normalizeCardName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Strip leading zeros from the main number of a collector number ("0216" -> "216", "20/270" unchanged). */
function normalizeCollectorNumber(num) {
  const n = String(num);
  const slash = n.indexOf('/');
  const main = slash === -1 ? n : n.slice(0, slash);
  const rest = slash === -1 ? '' : n.slice(slash);
  return main.replace(/^0+(?=\d)/, '') + rest;
}

// --- Download with local cache ----------------------------------------------

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const chunks = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Returns the .gz buffer for a source: fresh download, cached copy within the
 * TTL, or — when the download fails — whatever stale cache exists. Throws only
 * when neither a download nor any cached copy is possible.
 */
async function getSourceBuffer(source) {
  const file = path.join(CACHE_DIR, source.file);
  const force = process.env.DECKSYNC_FORCE_DATA === '1';

  if (!force && existsSync(file)) {
    const age = Date.now() - statSync(file).mtimeMs;
    if (age < CACHE_TTL_MS) {
      console.log(`[prepare-data] cache hit (${Math.round(age / 3600000)}h old): ${source.file}`);
      return readFileSync(file);
    }
  }

  try {
    console.log(`[prepare-data] downloading ${source.url} ...`);
    const buffer = await fetchBuffer(source.url);
    mkdirSync(CACHE_DIR, { recursive: true });
    // Write to a temp file first so an interrupted download never poisons the cache.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, buffer);
    renameSync(tmp, file);
    console.log(`[prepare-data] cached ${source.file} (${(buffer.length / 1048576).toFixed(1)} MB)`);
    return buffer;
  } catch (err) {
    if (existsSync(file)) {
      console.warn(`[prepare-data] download failed (${err.message}) — using stale cache ${source.file}`);
      return readFileSync(file);
    }
    throw err;
  }
}
// --- CSV parsing -------------------------------------------------------------

/**
 * Minimal RFC-4180 row parser (quoted fields, embedded commas/quotes/newlines)
 * as a generator: only the wanted columns are materialized per row, so the
 * ~150 MB decompressed cards.csv never lives in memory as row objects.
 */
function* csvRows(text, start, wantedIdx) {
  const wanted = new Set(wantedIdx);
  let row = [];
  let field = '';
  let col = 0;
  let inQuotes = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      if (wanted.has(col)) row[col] = field;
      field = '';
      col++;
    } else if (ch === '\n') {
      if (wanted.has(col)) row[col] = field;
      yield row;
      row = [];
      field = '';
      col = 0;
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field.length > 0 || col > 0) {
    if (wanted.has(col)) row[col] = field;
    yield row;
  }
}

/** Reads the header row and returns [headerNames, indexAfterHeader]. */
function readCsvHeader(text) {
  const end = text.indexOf('\n');
  if (end === -1) throw new Error('CSV has no header row');
  return [text.slice(0, end).split(','), end + 1];
}

// --- Builders ----------------------------------------------------------------

/** Card names from AtomicCards.json (name-keyed document of face variants). */
function buildNamesSet(gzBuffer) {
  const json = JSON.parse(gunzipSync(gzBuffer).toString('utf8'));
  const data = json.data;
  if (!data || typeof data !== 'object') throw new Error('Unexpected AtomicCards.json shape (missing data object)');

  const names = new Set();
  for (const [name, variants] of Object.entries(data)) {
    const norm = normalizeCardName(name);
    if (norm) names.add(norm);
    // Double-faced / split cards: the photo shows one face — validate those too.
    if (Array.isArray(variants)) {
      for (const v of variants) {
        if (v && typeof v.faceName === 'string') {
          const face = normalizeCardName(v.faceName);
          if (face) names.add(face);
        }
      }
    }
  }
  return names;
}

/** uuid -> scryfallId from cardIdentifiers.csv. */
function buildScryfallIdMap(gzBuffer) {
  const text = gunzipSync(gzBuffer).toString('utf8');
  const [header, afterHeader] = readCsvHeader(text);
  const uuidIdx = header.indexOf('uuid');
  const scryIdx = header.indexOf('scryfallId');
  if (uuidIdx === -1 || scryIdx === -1) {
    throw new Error(`cardIdentifiers.csv missing expected columns (uuid=${uuidIdx}, scryfallId=${scryIdx})`);
  }

  const byUuid = new Map();
  for (const row of csvRows(text, afterHeader, [uuidIdx, scryIdx])) {
    const uuid = row[uuidIdx];
    const scryfallId = row[scryIdx];
    if (uuid && scryfallId) byUuid.set(uuid, scryfallId);
  }
  return byUuid;
}

/** `<set>:<collector number>` -> scryfallId from cards.csv (English printings). */
function buildPrintingsMap(gzBuffer, scryfallByUuid) {
  const text = gunzipSync(gzBuffer).toString('utf8');
  const [header, afterHeader] = readCsvHeader(text);
  const langIdx = header.indexOf('language');
  const setIdx = header.indexOf('setCode');
  const numIdx = header.indexOf('number');
  const uuidIdx = header.indexOf('uuid');
  if ([langIdx, setIdx, numIdx, uuidIdx].some(i => i === -1)) {
    throw new Error(
      `cards.csv missing expected columns (language=${langIdx}, setCode=${setIdx}, number=${numIdx}, uuid=${uuidIdx})`
    );
  }

  const printings = {};
  for (const row of csvRows(text, afterHeader, [langIdx, setIdx, numIdx, uuidIdx])) {
    if (row[langIdx] !== 'English') continue; // English printings only — the app resolves English cards
    const setCode = row[setIdx];
    const number = row[numIdx];
    const uuid = row[uuidIdx];
    if (!setCode || !number || !uuid) continue;
    const scryfallId = scryfallByUuid.get(uuid);
    if (!scryfallId) continue; // not indexed on Scryfall (rare) — nothing to resolve to
    printings[`${setCode.toLowerCase()}:${normalizeCollectorNumber(String(number).toLowerCase())}`] = scryfallId;
  }
  return printings;
}

// --- Main --------------------------------------------------------------------

async function main() {
  const started = Date.now();

  // A failed run must not wipe out a working database: the output file is only
  // replaced once all sources are parsed successfully.
  try {
    const [atomicGz, cardsGz, identifiersGz] = await Promise.all(SOURCES.map(s => getSourceBuffer(s)));

    console.log('[prepare-data] building card name index ...');
    const names = buildNamesSet(atomicGz);

    console.log('[prepare-data] building printing (set + collector number) index ...');
    const scryfallByUuid = buildScryfallIdMap(identifiersGz);
    const printings = buildPrintingsMap(cardsGz, scryfallByUuid);

    if (names.size < 10_000 || Object.keys(printings).length < 10_000) {
      throw new Error(
        `Sanity check failed: names=${names.size}, printings=${Object.keys(printings).length} — upstream data shape likely changed`
      );
    }

    const output = JSON.stringify({
      names: [...names].sort(),
      printings
    });

    mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, output);

    // Write app metadata (version + data pull date) for the About modal.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const metaFile = path.join(ROOT, 'public', 'app-meta.json');
    writeFileSync(metaFile, JSON.stringify({ version: pkg.version, dataPullDate: new Date().toISOString() }));

    console.log(
      `[prepare-data] wrote ${path.relative(ROOT, OUT_FILE)}: ` +
        `${names.size} names, ${Object.keys(printings).length} printings, ` +
        `${(output.length / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
  } catch (err) {
    if (existsSync(OUT_FILE)) {
      console.warn(`[prepare-data] FAILED (${err.message}) — keeping existing ${path.relative(ROOT, OUT_FILE)}`);
      return;
    }
    console.error(`[prepare-data] FAILED and no previous card-data.json exists: ${err.message}`);
    process.exitCode = 1;
  }
}

main();

