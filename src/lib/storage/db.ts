import type { DeckVerificationLog, SavedDeckSession, ScryfallCard, SavedScannedDeck } from '../types';

const DB_NAME = 'decksync_db';
const DB_VERSION = 2;

interface CachedCardEntry {
  name: string;
  card: ScryfallCard;
  cachedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not supported in this environment'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;

      // Logs store: for permanent verification history logs
      if (!db.objectStoreNames.contains('logs')) {
        const logStore = db.createObjectStore('logs', { keyPath: 'id' });
        logStore.createIndex('timestamp', 'timestamp', { unique: false });
        logStore.createIndex('deckName', 'deckName', { unique: false });
      }

      // Sessions store: for currently active / saved deck lists & checklist states
      if (!db.objectStoreNames.contains('sessions')) {
        const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' });
        sessionStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      // Card cache store: to cache Scryfall card data
      if (!db.objectStoreNames.contains('cardCache')) {
        db.createObjectStore('cardCache', { keyPath: 'name' });
      }

      // Scanned decks store: for deck scanner mode sessions
      if (!db.objectStoreNames.contains('scannedDecks')) {
        const scannedStore = db.createObjectStore('scannedDecks', { keyPath: 'id' });
        scannedStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

// --- Verification Logs ---

export async function saveVerificationLog(log: DeckVerificationLog): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');
    const req = store.put(log);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getAllVerificationLogs(): Promise<DeckVerificationLog[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('logs', 'readonly');
    const store = tx.objectStore('logs');
    const index = store.index('timestamp');
    const req = index.openCursor(null, 'prev'); // newest first
    const results: DeckVerificationLog[] = [];

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteVerificationLog(id: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearAllLogs(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// --- Deck Sessions ---

export async function saveDeckSession(session: SavedDeckSession): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const req = store.put(session);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getLatestDeckSession(): Promise<SavedDeckSession | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly');
    const store = tx.objectStore('sessions');
    const index = store.index('updatedAt');
    const req = index.openCursor(null, 'prev');

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        resolve(cursor.value);
      } else {
        resolve(null);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// --- Card Cache ---

export async function getCachedCard(name: string): Promise<ScryfallCard | null> {
  if (typeof window === 'undefined' || !window.indexedDB) return null;
  const normalized = name.trim().toLowerCase();
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction('cardCache', 'readonly');
      const store = tx.objectStore('cardCache');
      const req = store.get(normalized);
      req.onsuccess = () => {
        const entry = req.result as CachedCardEntry | undefined;
        resolve(entry ? entry.card : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheCards(cards: ScryfallCard[]): Promise<void> {
  if (typeof window === 'undefined' || !window.indexedDB) return;
  try {
    const db = await getDB();
    const tx = db.transaction('cardCache', 'readwrite');
    const store = tx.objectStore('cardCache');
    const now = Date.now();
    for (const card of cards) {
      if (card && card.name) {
        const entry: CachedCardEntry = {
          name: card.name.trim().toLowerCase(),
          card,
          cachedAt: now
        };
        store.put(entry);
      }
    }
  } catch (err) {
    console.warn('Failed to cache cards in IndexedDB:', err);
  }
}

// The cardCache store is keyed by name, but the scanner resolves printings by
// Scryfall id — so an id -> card index over the whole store is built lazily
// (once per session) to make repeat scans zero-API-call lookups.
let cardIdIndex: Map<string, ScryfallCard> | null = null;
let cardIdIndexPromise: Promise<Map<string, ScryfallCard>> | null = null;

function buildCardIdIndex(): Promise<Map<string, ScryfallCard>> {
  if (!cardIdIndexPromise) {
    cardIdIndexPromise = (async () => {
      const db = await getDB();
      const entries: CachedCardEntry[] = await new Promise((resolve, reject) => {
        const tx = db.transaction('cardCache', 'readonly');
        const req = tx.objectStore('cardCache').getAll();
        req.onsuccess = () => resolve(req.result as CachedCardEntry[]);
        req.onerror = () => reject(req.error);
      });

      const index = new Map<string, ScryfallCard>();
      for (const entry of entries) {
        // Placeholder cards ("custom-...") are never cached, but guard anyway
        if (entry?.card?.id && !entry.card.id.startsWith('custom-')) {
          index.set(entry.card.id, entry.card);
        }
      }
      cardIdIndex = index;
      return index;
    })().catch(err => {
      console.warn('Failed to build card id index:', err);
      return new Map<string, ScryfallCard>();
    });
  }
  return cardIdIndexPromise;
}

/** Looks up a previously cached card by its Scryfall id (null on miss). */
export async function getCachedCardById(scryfallId: string): Promise<ScryfallCard | null> {
  if (typeof window === 'undefined' || !window.indexedDB) return null;
  try {
    const index = await buildCardIdIndex();
    return index.get(scryfallId) ?? null;
  } catch {
    return null;
  }
}

// --- Scanned Decks (Deck Scanner mode) ---

export async function saveScannedDeck(deck: SavedScannedDeck): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scannedDecks', 'readwrite');
    const store = tx.objectStore('scannedDecks');
    const req = store.put(deck);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getLatestScannedDeck(): Promise<SavedScannedDeck | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scannedDecks', 'readonly');
    const store = tx.objectStore('scannedDecks');
    const index = store.index('updatedAt');
    const req = index.openCursor(null, 'prev');

    req.onsuccess = () => {
      const cursor = req.result;
      resolve(cursor ? (cursor.value as SavedScannedDeck) : null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteScannedDeck(id: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scannedDecks', 'readwrite');
    const store = tx.objectStore('scannedDecks');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearScannedDecks(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scannedDecks', 'readwrite');
    const store = tx.objectStore('scannedDecks');
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}


