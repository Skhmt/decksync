/**
 * Local MTG card database, generated at build time by scripts/prepare-data.js
 * from MTGJSON v5 and served from public/card-data.json. Loaded once on page
 * launch into in-memory structures for O(1) lookups:
 *
 *   - names:     Set<string>  — normalized card names (O(1) name validity)
 *   - printings: Map<string,string> — "<set>:<collector number>" -> Scryfall id
 *
 * The goal is to validate OCR readings locally and skip Scryfall API calls
 * entirely for anything that isn't a real card / printing. When the database
 * can't be loaded (e.g. very first run before it was precached) every check
 * degrades to pass-through so the legacy network lookup paths still work.
 */

import { buildCardDatabase, normalizeCardName } from './builders';
import { requestLoad, workersSupported } from './workerClient';

export interface CardDatabase {
  /** False when card-data.json failed to load — all checks are pass-through then */
  ready: boolean;
  names: Set<string>;
  printings: Map<string, string>;
}

/** Re-exported for API stability (also documented in the build scripts). */
export { normalizeCardName };

let db: CardDatabase = { ready: false, names: new Set(), printings: new Map() };
let loadPromise: Promise<CardDatabase> | null = null;

/** Strip leading zeros from the main number of a collector number ("0216" -> "216", "20/270" unchanged). */
function normalizeCollectorNumber(num: string): string {
  const slash = num.indexOf('/');
  const main = slash === -1 ? num : num.slice(0, slash);
  const rest = slash === -1 ? '' : num.slice(slash);
  return main.replace(/^0+(?=\d)/, '') + rest;
}

/** Main-thread fallback when Web Workers are unavailable. */
function loadOnMainThread(): Promise<CardDatabase> {
  return (async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}card-data.json`, {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      db = { ready: true, ...buildCardDatabase(await response.json()) };
    } catch (err) {
      console.warn('Failed to load local card database — falling back to live Scryfall lookups:', err);
      // db stays { ready: false } → validation passes through, legacy paths used
    }
    return db;
  })();
}

/**
 * Loads the card database (idempotent — concurrent calls share one load). The
 * fetch + parse run in a Web Worker so the ~6 MB JSON never blocks the main
 * thread. Resolves even on failure with `ready: false` so callers can proceed
 * using the legacy Scryfall lookup paths.
 */
export function ensureCardData(): Promise<CardDatabase> {
  if (!loadPromise) {
    loadPromise = (async () => {
      // Fast path: fetch + parse in a worker so the ~6 MB JSON never blocks the
      // main thread. If the worker is unavailable or fails for any reason, fall
      // back to loading on the main thread rather than giving up.
      if (workersSupported()) {
        try {
          const built = await requestLoad<{ names: Set<string>; printings: Map<string, string> }>('card-data');
          db = { ready: true, ...built };
          return db;
        } catch (err) {
          console.warn('Worker card-data load failed — retrying on main thread:', err);
        }
      }
      return loadOnMainThread();
    })();
  }
  return loadPromise;
}

/** True once the database is loaded and usable for validation. */
export function isCardDataReady(): boolean {
  return db.ready;
}

/**
 * O(1) card-name validity check. Returns true when the database isn't loaded
 * (pass-through) so a missing data file never blocks a lookup.
 */
export function hasCardName(name: string): boolean {
  if (!db.ready) return true;
  return db.names.has(normalizeCardName(name));
}

/**
 * Resolves a set code + collector number to a Scryfall card id via the local
 * printings map. Returns undefined when the pair isn't a known printing or the
 * database isn't loaded (callers then fall back to the network lookup).
 */
export function findPrintingId(setCode: string, collectorNumber: string): string | undefined {
  if (!db.ready) return undefined;

  const set = setCode.toLowerCase();
  // OCR parsing uppercases everything ("381Z") — the map keys are lowercase.
  const number = normalizeCollectorNumber(collectorNumber.toLowerCase());
  // Superset numbers like "20/270" may be indexed by their main number only.
  const candidates = [number];
  if (number.includes('/')) candidates.push(number.split('/')[0]);

  for (const num of candidates) {
    const id = db.printings.get(`${set}:${num}`);
    if (id) return id;
  }
  return undefined;
}
