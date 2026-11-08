import { parseDecklistText, type ParsedDeckResult } from './decklist';
import type { DeckCardItem } from '../types';

export interface UrlImportOptions {
  corsProxy?: boolean;
}

// --- Minimal API response shapes (only the fields we actually read) ---

interface MoxfieldSectionEntry {
  card?: { id?: string; name?: string; set?: string; cn?: number | string };
  quantity?: number;
  isFoil?: boolean;
}

interface MoxfieldDeckResponse {
  name?: string;
  commanders?: Record<string, MoxfieldSectionEntry>;
  companions?: Record<string, MoxfieldSectionEntry>;
  mainboard?: Record<string, MoxfieldSectionEntry>;
  sideboard?: Record<string, MoxfieldSectionEntry>;
}

interface ArchidektCategory {
  name?: string;
  includedInDeck?: boolean;
}

interface ArchidektCardRef {
  oracleCard?: { name?: string };
  name?: string;
  edition?: { editioncode?: string };
  collectorNumber?: string;
}

interface ArchidektDeckItem {
  id?: number | string;
  card?: ArchidektCardRef;
  quantity?: number;
  categories?: (string | { name: string })[];
}

interface ArchidektDeckResponse {
  name?: string;
  cards?: ArchidektDeckItem[];
  categories?: ArchidektCategory[];
}

interface FetchSource {
  name: string;
  buildUrl: (url: string) => string;
  /** Convert the raw response body into the target content. Throw to reject this source. */
  extract?: (raw: string) => string;
}

// Proxy sources raced in parallel for cross-origin fetches. Order only affects
// which error we keep if everything fails — the first *valid* response wins.
//
// jina-reader (r.jina.ai) is the most reliable source for Cloudflare-protected
// deck APIs (Moxfield, Archidekt): it echoes the requesting origin in
// Access-Control-Allow-Origin and returns the full response body wrapped in a
// small text envelope ("Title: ... / URL Source: ... / Markdown Content:\n...").
const JINA_CONTENT_MARKER = 'Markdown Content:\n';

const PROXY_SOURCES: FetchSource[] = [
  {
    name: 'jina-reader',
    buildUrl: (url: string) => `https://r.jina.ai/${url}`,
    extract: (raw: string): string => {
      const idx = raw.indexOf(JINA_CONTENT_MARKER);
      return idx >= 0 ? raw.slice(idx + JINA_CONTENT_MARKER.length) : raw;
    }
  },
  {
    name: 'allorigins-raw',
    buildUrl: (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  },
  {
    name: 'codetabs',
    buildUrl: (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
  },
  {
    name: 'allorigins-json',
    buildUrl: (url: string) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    extract: (raw: string): string => JSON.parse(raw).contents
  },
  {
    // Only works if the user previously opted in on cors-anywhere.com, but it is
    // harmless to race alongside the others.
    name: 'cors-anywhere',
    buildUrl: (url: string) => `https://cors-anywhere.com/${encodeURIComponent(url)}`
  }
];

const DIRECT_TIMEOUT_MS = 8000;
const PROXY_TIMEOUT_MS = 30000;

function isCloudflareChallenge(text: string): boolean {
  if (typeof text !== 'string') return false;
  return (
    text.includes('Just a moment...') ||
    text.includes('Attention Required! | Cloudflare') ||
    text.includes('cf-browser-verification') ||
    text.includes('Checking your browser before accessing')
  );
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[');
}

async function fetchFromSource(
  source: FetchSource,
  url: string,
  timeoutMs: number,
  expectJson: boolean
): Promise<string> {
  const res = await fetch(source.buildUrl(url), {
    headers: { Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) throw new Error(`${source.name} returned HTTP ${res.status}`);

  let content = await res.text();
  if (source.extract) content = source.extract(content);

  if (!content || isCloudflareChallenge(content)) {
    throw new Error(`${source.name} was blocked or returned an empty response`);
  }
  if (expectJson && !looksLikeJson(content)) {
    // e.g. a reader-proxy error page instead of the real payload — let another source win
    throw new Error(`${source.name} returned non-JSON content`);
  }
  return content;
}

/** Resolves with the first fulfilled value, rejects only when every promise fails. */
function firstSuccess(promises: Promise<string>[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let pending = promises.length;
    let lastError: unknown = new Error('All fetch sources failed');
    if (pending === 0) {
      reject(lastError);
      return;
    }
    for (const promise of promises) {
      promise.then(
        (value) => resolve(value),
        (error) => {
          lastError = error;
          if (--pending === 0) reject(lastError);
        }
      );
    }
  });
}

/**
 * Fetches a URL from the browser, working around CORS restrictions:
 * 1. Try a direct fetch first (fast path for sites that allow cross-origin reads).
 * 2. Race a pool of public reader proxies in parallel; the first valid response wins.
 *
 * Deck sites such as Moxfield and Archidekt do not send permissive CORS headers,
 * so step 2 is what actually makes URL imports work for them.
 */
export async function fetchWithFallback(
  url: string,
  options: { expectJson?: boolean } = {}
): Promise<string> {
  const { expectJson = false } = options;

  // 1. Fast path: direct fetch (fails instantly in the browser when CORS blocks it)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS)
    });
    if (res.ok) {
      const text = await res.text();
      if (!isCloudflareChallenge(text) && !(expectJson && !looksLikeJson(text))) {
        return text;
      }
    }
  } catch {
    // Direct fetch failed (likely a browser CORS block), continue to proxies.
  }

  // 2. Race all proxy sources in parallel — first valid response wins
  try {
    return await firstSuccess(
      PROXY_SOURCES.map((source) =>
        fetchFromSource(source, url, PROXY_TIMEOUT_MS, expectJson).catch((err: unknown) => {
          throw err instanceof Error ? err : new Error(String(err));
        })
      )
    );
  } catch {
    // Every source failed — fall through to the final error below.
  }

  throw new Error(
    'Unable to load this deck: the site blocks cross-origin requests and all proxy routes were blocked or timed out. Please open the deck in Moxfield/Archidekt, use its export/copy button, and paste the list into the "Paste Decklist" tab instead.'
  );
}

/**
 * Imports a deck directly from Moxfield URL
 */
async function importFromMoxfield(url: string): Promise<ParsedDeckResult> {
  const match = url.match(/moxfield\.com\/decks\/([a-zA-Z0-9_\-]+)/);
  if (!match) throw new Error('Invalid Moxfield deck URL');
  const deckId = match[1];

  const apiUrl = `https://api.moxfield.com/v2/decks/all/${deckId}`;
  const jsonText = await fetchWithFallback(apiUrl, { expectJson: true });
  let data: MoxfieldDeckResponse;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('Moxfield returned an unexpected response. Please copy and paste the export text instead.');
  }

  const deckName = data.name || 'Moxfield Deck';
  const cards: DeckCardItem[] = [];

  const addEntries = (sectionObj: Record<string, MoxfieldSectionEntry> | undefined, section: DeckCardItem['section']) => {
    if (!sectionObj) return;
    for (const key of Object.keys(sectionObj)) {
      const entry = sectionObj[key];
      const card = entry.card || {};
      const count = entry.quantity || 1;
      const name = card.name || key;
      cards.push({
        id: `moxfield-${card.id || key}-${section}-${Math.random().toString(36).substring(2, 6)}`,
        name,
        rawName: name,
        targetCount: count,
        verifiedCount: 0,
        section,
        setCode: card.set?.toLowerCase(),
        collectorNumber: card.cn != null ? String(card.cn) : undefined,
        isFoil: entry.isFoil || false
      });
    }
  };

  addEntries(data.commanders, 'commander');
  addEntries(data.companions, 'companion');
  addEntries(data.mainboard, 'mainboard');
  addEntries(data.sideboard, 'sideboard');

  const rawLines = cards.map(c => `${c.targetCount} ${c.name}`);

  return {
    deckName,
    cards,
    rawText: rawLines.join('\n')
  };
}

/**
 * Imports a deck directly from Archidekt URL
 */
async function importFromArchidekt(url: string): Promise<ParsedDeckResult> {
  const match = url.match(/archidekt\.com\/decks\/(\d+)/);
  if (!match) throw new Error('Invalid Archidekt deck URL');
  const deckId = match[1];

  const apiUrl = `https://archidekt.com/api/decks/${deckId}/`;
  const jsonText = await fetchWithFallback(apiUrl, { expectJson: true });
  let data: ArchidektDeckResponse;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('Archidekt returned an unexpected response. Please copy and paste the export text instead.');
  }

  const deckName = data.name || 'Archidekt Deck';
  const cards: DeckCardItem[] = [];

  // Categories the deck owner marked as "not in deck" (e.g. the built-in Maybeboard,
  // whose default is includedInDeck: false). Cards tagged with any of these are not
  // part of the playable decklist and must be skipped.
  const excludedCategories = new Set<string>();
  if (Array.isArray(data.categories) && data.categories.length > 0) {
    for (const cat of data.categories) {
      if (cat && typeof cat.name === 'string' && cat.includedInDeck === false) {
        excludedCategories.add(cat.name.toLowerCase());
      }
    }
  } else {
    // Fallback when the API omits category metadata: Maybeboard is not in the deck by default.
    excludedCategories.add('maybeboard');
  }

  if (Array.isArray(data.cards)) {
    for (const item of data.cards) {
      const cardName = item.card?.oracleCard?.name || item.card?.name;
      if (!cardName) continue;

      const count = item.quantity || 1;
      const categories: string[] = Array.isArray(item.categories)
        ? item.categories.map((c) => (typeof c === 'string' ? c : c.name).toLowerCase())
        : [];

      // Skip cards in "not in deck" categories (Maybeboard, custom excluded categories, ...)
      if (categories.some(c => excludedCategories.has(c))) continue;

      let section: DeckCardItem['section'] = 'mainboard';
      if (categories.some(c => c.includes('commander'))) {
        section = 'commander';
      } else if (categories.some(c => c.includes('companion'))) {
        section = 'companion';
      } else if (categories.some(c => c.includes('sideboard'))) {
        section = 'sideboard';
      }

      cards.push({
        id: `archidekt-${item.id || cardName}-${section}-${Math.random().toString(36).substring(2, 6)}`,
        name: cardName,
        rawName: cardName,
        targetCount: count,
        verifiedCount: 0,
        section,
        setCode: item.card?.edition?.editioncode?.toLowerCase(),
        collectorNumber: item.card?.collectorNumber
      });
    }
  }

  const rawLines = cards.map(c => `${c.targetCount} ${c.name}`);
  return {
    deckName,
    cards,
    rawText: rawLines.join('\n')
  };
}

/**
 * Imports from MTGGoldfish
 */
async function importFromMTGGoldfish(url: string): Promise<ParsedDeckResult> {
  const match = url.match(/mtggoldfish\.com\/deck\/(?:visual\/|download\/)?(\d+)/);
  if (!match) throw new Error('Invalid MTGGoldfish deck URL');
  const deckId = match[1];

  const downloadUrl = `https://www.mtggoldfish.com/deck/download/${deckId}`;
  const text = await fetchWithFallback(downloadUrl);
  return parseDecklistText(text, `MTGGoldfish #${deckId}`);
}

/**
 * Imports from TappedOut
 */
async function importFromTappedOut(url: string): Promise<ParsedDeckResult> {
  const match = url.match(/tappedout\.net\/mtg-decks\/([a-zA-Z0-9_\-]+)/);
  if (!match) throw new Error('Invalid TappedOut deck URL');
  const slug = match[1];

  const textUrl = `https://tappedout.net/mtg-decks/${slug}/?fmt=txt`;
  const text = await fetchWithFallback(textUrl);
  return parseDecklistText(text, slug.replace(/-/g, ' '));
}

/**
 * Imports from any deck URL (Moxfield, Archidekt, MTGGoldfish, TappedOut, or raw text file)
 */
export async function importDeckFromUrl(url: string): Promise<ParsedDeckResult> {
  const trimmed = url.trim();

  if (/moxfield\.com/i.test(trimmed)) {
    return importFromMoxfield(trimmed);
  }
  if (/archidekt\.com/i.test(trimmed)) {
    return importFromArchidekt(trimmed);
  }
  if (/mtggoldfish\.com/i.test(trimmed)) {
    return importFromMTGGoldfish(trimmed);
  }
  if (/tappedout\.net/i.test(trimmed)) {
    return importFromTappedOut(trimmed);
  }

  // Generic URL: fetch text content directly with CORS proxy
  const raw = await fetchWithFallback(trimmed);
  return parseDecklistText(raw, 'Imported Deck');
}
