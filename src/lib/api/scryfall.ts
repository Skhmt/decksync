import type { ScryfallCard, DeckCardItem } from '../types';
import { getCachedCard, getCachedCardById, cacheCards, getCachedCardByPrinting, cachePrintings } from '../storage/db';
import { pickBestNameMatch } from '../ocr/parse';
import { ensureCardData, findPrintingId, hasCardName, hasCardNameFuzzy, isCardDataReady } from '../data/cardData';

const SCRYFALL_COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const SCRYFALL_SEARCH_URL = 'https://api.scryfall.com/cards/search';
const SCRYFALL_CARD_URL = 'https://api.scryfall.com/cards';
const BATCH_SIZE = 75;
const PRINT_BATCH_SIZE = 10;
const PRINT_PAGE_SIZE = 30;
const MAX_PRINT_PAGES = 3;
// Scryfall allows ~1 request/second sustained (30/min burst). The old 100 ms
// pacing let a multi-candidate lookup fire 4–5 requests in one second and burn
// the whole budget in a single scan; 500 ms keeps us comfortably under the cap.
const RATE_LIMIT_DELAY_MS = 500;
// Per-request timeout + bounded retries for transient failures (timeouts,
// network hiccups, HTTP 429 rate-limit responses, 5xx server errors).
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_RETRIES = 2; // extra attempts after the first one
const RETRY_BACKOFF_BASE_MS = 3_000; // backoff grows linearly: 3 s, then 6 s
const RETRY_AFTER_CAP_MS = 10_000; // never wait longer than this per response

interface ScryfallCollectionResponse {
  object: string;
  not_found?: Array<{ name?: string; id?: string }>;
  data?: ScryfallCard[];
}

interface ScryfallSearchResponse {
  object: string;
  data?: ScryfallCard[];
  has_more?: boolean;
}

/**
 * Categorizes a card's primary type from its type_line.
 * Magic primary types: Creature, Planeswalker, Battle, Instant, Sorcery, Artifact, Enchantment, Land, Other
 */
export function getCardPrimaryType(typeLine = ''): string {
  const line = typeLine.toLowerCase();
  if (line.includes('creature')) return 'Creature';
  if (line.includes('planeswalker')) return 'Planeswalker';
  if (line.includes('battle')) return 'Battle';
  if (line.includes('instant')) return 'Instant';
  if (line.includes('sorcery')) return 'Sorcery';
  if (line.includes('artifact')) return 'Artifact';
  if (line.includes('enchantment')) return 'Enchantment';
  if (line.includes('land')) return 'Land';
  return 'Other';
}

/**
 * Standard card type sort order for "organized by card type, then alphabetically"
 */
export const CARD_TYPE_ORDER: Record<string, number> = {
  'Commander': 0,
  'Creature': 1,
  'Planeswalker': 2,
  'Battle': 3,
  'Instant': 4,
  'Sorcery': 5,
  'Artifact': 6,
  'Enchantment': 7,
  'Land': 8,
  'Other': 9
};

/**
 * Resolves the primary image URL for a card, supporting double-faced / transform cards.
 * If a card image can't be found directly, falls back to Scryfall named?fuzzy image redirect.
 */
export function getCardImageUrl(card?: ScryfallCard, faceIndex = 0): string {
  if (!card) return '';

  if (card.card_faces && card.card_faces.length > faceIndex && card.card_faces[faceIndex]?.image_uris?.normal) {
    return card.card_faces[faceIndex].image_uris!.normal!;
  }

  if (card.image_uris?.normal) {
    return card.image_uris.normal;
  }

  if (card.image_uris?.large) {
    return card.image_uris.large;
  }

  if (card.image_uris?.small) {
    return card.image_uris.small;
  }

  if (card.card_faces && card.card_faces[0]?.image_uris?.normal) {
    return card.card_faces[0].image_uris!.normal!;
  }

  // Fallback: if no image URIs are available, return empty string — the UI shows
  // a generic card placeholder. Previously this hotlinked to api.scryfall.com's
  // redirect endpoint, which counts against the API rate limit and breaks offline.
  return '';
}

/**
 * Fetches card details from Scryfall /cards/collection in batches of 75,
 * utilizing the local IndexedDB cache first.
 */
export async function enrichDeckCards(
  deckCards: DeckCardItem[],
  onProgress?: (progress: number, total: number) => void
): Promise<DeckCardItem[]> {
  const uniqueNames = Array.from(new Set(deckCards.map(c => c.name.trim())));
  const cardMap = new Map<string, ScryfallCard>();
  const missingFromCache: string[] = [];

  const indexCard = (card: ScryfallCard) => {
    // Normalize game_changer boolean flag
    card.game_changer = Boolean(card.game_changer || card['game-changer']);

    cardMap.set(card.name.toLowerCase().trim(), card);

    // Map front and back faces if name has " // " or " / "
    if (card.name.includes(' // ')) {
      const parts = card.name.split(' // ');
      if (parts[0]) cardMap.set(parts[0].toLowerCase().trim(), card);
      if (parts[1]) cardMap.set(parts[1].toLowerCase().trim(), card);
    } else if (card.name.includes(' / ')) {
      const parts = card.name.split(' / ');
      if (parts[0]) cardMap.set(parts[0].toLowerCase().trim(), card);
      if (parts[1]) cardMap.set(parts[1].toLowerCase().trim(), card);
    }

    // Map card_faces array
    if (card.card_faces) {
      for (const face of card.card_faces) {
        if (face.name) {
          cardMap.set(face.name.toLowerCase().trim(), card);
        }
      }
    }
  };

  // 1. Check local IndexedDB cache
  for (const name of uniqueNames) {
    const cached = await getCachedCard(name);
    if (cached) {
      indexCard(cached);
    } else {
      missingFromCache.push(name);
    }
  }

  if (onProgress) {
    onProgress(uniqueNames.length - missingFromCache.length, uniqueNames.length);
  }

  // 2. Fetch missing cards from Scryfall in batches of 75
  const newlyFetched: ScryfallCard[] = [];

  for (let i = 0; i < missingFromCache.length; i += BATCH_SIZE) {
    const batch = missingFromCache.slice(i, i + BATCH_SIZE);
    const identifiers = batch.map(name => ({ name }));

    try {
      const response = await fetch(SCRYFALL_COLLECTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'DeckSync/1.0'
        },
        body: JSON.stringify({ identifiers })
      });

      if (response.ok) {
        const json: ScryfallCollectionResponse = await response.json();
        if (json.data) {
          for (const card of json.data) {
            indexCard(card);
            newlyFetched.push(card);
          }
        }

        // If any cards were reported not_found, retry by cleaning name (e.g. taking left half before / or stripping suffix)
        if (json.not_found && json.not_found.length > 0) {
          const retryNames = json.not_found
            .map(nf => nf.name)
            .filter((n): n is string => Boolean(n))
            .map(n => n.split('/')[0].replace(/[-–—]?\s*\d+.*$/, '').trim())
            .filter(n => n.length > 0);

          if (retryNames.length > 0) {
            try {
              const retryResp = await fetch(SCRYFALL_COLLECTION_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                  'User-Agent': 'DeckSync/1.0'
                },
                body: JSON.stringify({ identifiers: retryNames.map(name => ({ name })) })
              });
              if (retryResp.ok) {
                const retryJson: ScryfallCollectionResponse = await retryResp.json();
                if (retryJson.data) {
                  for (const card of retryJson.data) {
                    indexCard(card);
                    newlyFetched.push(card);
                  }
                }
              }
            } catch (retryErr) {
              console.warn('Secondary Scryfall lookup failed:', retryErr);
            }
          }
        }
      } else {
        console.warn(`Scryfall batch collection returned status ${response.status}`);
      }
    } catch (err) {
      console.error('Failed to fetch Scryfall collection batch:', err);
    }

    if (onProgress) {
      onProgress(
        Math.min(uniqueNames.length, (uniqueNames.length - missingFromCache.length) + i + batch.length),
        uniqueNames.length
      );
    }

    // Rate-limit pause if there are more batches
    if (i + BATCH_SIZE < missingFromCache.length) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
  }

  // 3. Fetch specific printings (set code + collector number) requested by the decklist,
  //    so card images match the exact printing listed. Uses the local printing map
  //    (card-data.json) to resolve Scryfall IDs directly, then batch-fetches via
  //    /cards/collection — eliminating the old paginated search storm. Results are
  //    cached in IndexedDB by printing key so subsequent loads require zero requests.
  const printMap = new Map<string, ScryfallCard>();
  const printRequests: Array<{ name: string; setCode: string; collectorNumber: string }> = [];
  const seenPrintKeys = new Set<string>();

  for (const item of deckCards) {
    if (!item.setCode || !item.collectorNumber) continue;
    const setCode = item.setCode.toLowerCase();
    const collectorNumber = String(item.collectorNumber);
    const key = `${item.name.toLowerCase().trim()}::${setCode}::${collectorNumber}`;
    if (seenPrintKeys.has(key)) continue;
    seenPrintKeys.add(key);

    // Skip when the name lookup already resolved to this exact printing
    const defaultCard = cardMap.get(item.name.toLowerCase().trim());
    if (defaultCard && defaultCard.set === setCode && String(defaultCard.collector_number ?? '') === collectorNumber) {
      continue;
    }

    printRequests.push({ name: item.name, setCode, collectorNumber });
  }

  // 3a. Check the printing-specific IndexedDB cache first (zero network on reload)
  const missingPrints: Array<{ name: string; setCode: string; collectorNumber: string; scryfallId?: string }> = [];
  const newPrintCards: ScryfallCard[] = [];

  for (const req of printRequests) {
    const key = `${req.name.toLowerCase().trim()}::${req.setCode}::${req.collectorNumber}`;

    // Fast path: already cached by printing key
    const cachedPrinting = await getCachedCardByPrinting(req.setCode, req.collectorNumber);
    if (cachedPrinting) {
      printMap.set(key, cachedPrinting);
      continue;
    }

    // Resolve Scryfall ID from the local card-data.json printings map
    let scryfallId: string | undefined;
    if (isCardDataReady()) {
      scryfallId = findPrintingId(req.setCode, req.collectorNumber);
    }

    // Check the name-keyed cache by ID (the card may already be cached under its default name)
    if (scryfallId) {
      const byId = await getCachedCardById(scryfallId);
      if (byId) {
        printMap.set(key, byId);
        newPrintCards.push(byId);
        continue;
      }
    }

    missingPrints.push({ ...req, scryfallId });
  }

  // 3b. Batch-fetch missing printings via /cards/collection using Scryfall IDs (75 per batch)
  const idBatches: Array<{ name: string; setCode: string; collectorNumber: string; scryfallId: string }> = [];
  const noIdPrints: Array<{ name: string; setCode: string; collectorNumber: string }> = [];

  for (const p of missingPrints) {
    if (p.scryfallId) {
      idBatches.push(p as typeof idBatches[number]);
    } else {
      noIdPrints.push(p);
    }
  }

  for (let i = 0; i < idBatches.length; i += BATCH_SIZE) {
    const batch = idBatches.slice(i, i + BATCH_SIZE);
    const identifiers = batch.map(b => ({ id: b.scryfallId }));

    try {
      const response = await fetch(SCRYFALL_COLLECTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'DeckSync/1.0'
        },
        body: JSON.stringify({ identifiers })
      });

      if (response.ok) {
        const json: ScryfallCollectionResponse = await response.json();
        const byId = new Map<string, ScryfallCard>();
        for (const card of json.data ?? []) {
          card.game_changer = Boolean(card.game_changer || card['game-changer']);
          if (card.id) byId.set(card.id, card);
        }

        for (const req of batch) {
          const key = `${req.name.toLowerCase().trim()}::${req.setCode}::${req.collectorNumber}`;
          const card = byId.get(req.scryfallId!);
          if (card) {
            printMap.set(key, card);
            newPrintCards.push(card);
          }
        }
      } else {
        console.warn(`Scryfall printing collection returned status ${response.status}`);
      }
    } catch (err) {
      console.error('Failed to fetch Scryfall printing collection batch:', err);
    }

    if (i + BATCH_SIZE < idBatches.length) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
  }

  // 3c. Fallback: for printings not in the local map (e.g. very new sets), use legacy search
  if (noIdPrints.length > 0) {
    for (let i = 0; i < noIdPrints.length; i += PRINT_BATCH_SIZE) {
      const batch = noIdPrints.slice(i, i + PRINT_BATCH_SIZE);
      const q = batch
        .map(r => `(name:"${r.name.replace(/"/g, '')}" set:${r.setCode})`)
        .join(' OR ');

      try {
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= MAX_PRINT_PAGES) {
          const url = `${SCRYFALL_SEARCH_URL}?q=${encodeURIComponent(q)}&page_size=${PRINT_PAGE_SIZE}&unique=prints&page=${page}`;
          const response = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'DeckSync/1.0' }
          });

          if (!response.ok) break;
          const json: ScryfallSearchResponse = await response.json();

          for (const req of batch) {
            const lowerName = req.name.toLowerCase().trim();
            const key = `${lowerName}::${req.setCode}::${req.collectorNumber}`;
            if (printMap.has(key)) continue;

            const match = (json.data ?? []).find(c => {
              if (String(c.set ?? '').toLowerCase() !== req.setCode) return false;
              if (String(c.collector_number ?? '') !== req.collectorNumber) return false;
              const cardName = c.name.toLowerCase().trim();
              return cardName === lowerName || cardName.startsWith(lowerName + ' /') || cardName.startsWith(lowerName + ' //');
            });

            if (match) {
              match.game_changer = Boolean(match.game_changer || match['game-changer']);
              printMap.set(key, match);
              newPrintCards.push(match);
            }
          }

          hasMore = Boolean(json.has_more);
          page++;
        }
      } catch (err) {
        console.error('Failed to fetch Scryfall printing search fallback:', err);
      }

      if (i + PRINT_BATCH_SIZE < noIdPrints.length) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
      }
    }
  }

  // 4. Save newly fetched cards to IndexedDB cache (both name-keyed and printing-keyed)
  if (newlyFetched.length > 0) {
    await cacheCards(newlyFetched);
  }
  if (newPrintCards.length > 0) {
    // Cache by name (default representative) — dedupe by card.id to avoid overwrites
    const uniqueByCard = new Map<string, ScryfallCard>();
    for (const c of newPrintCards) {
      if (c.id && !c.id.startsWith('custom-')) uniqueByCard.set(c.id, c);
    }
    if (uniqueByCard.size > 0) {
      await cacheCards(Array.from(uniqueByCard.values()));
    }
    // Cache by printing key for zero-network reloads
    const printEntries: Array<{ setCode: string; collectorNumber: string; card: ScryfallCard }> = [];
    for (const [key, card] of printMap) {
      const parts = key.split('::');
      if (parts.length === 3) {
        printEntries.push({ setCode: parts[1], collectorNumber: parts[2], card });
      }
    }
    if (printEntries.length > 0) {
      await cachePrintings(printEntries);
    }
  }

  // 5. Attach Scryfall card data to deck items
  return deckCards.map(item => {
    const lowerName = item.name.toLowerCase().trim();
    let foundCard = cardMap.get(lowerName) || cardMap.get(item.rawName.toLowerCase().trim());

    if (!foundCard) {
      const base = lowerName.split('/')[0].replace(/[-–—]?\s*\d+.*$/, '').trim();
      foundCard = cardMap.get(base);
    }

    // Prefer the exact printing (set + collector number) specified in the decklist;
    // if that printing wasn't found (e.g. invalid set), keep the default name-resolved card
    if (item.setCode && item.collectorNumber) {
      const printKey = `${lowerName}::${item.setCode.toLowerCase()}::${String(item.collectorNumber)}`;
      const specificCard = printMap.get(printKey);
      if (specificCard) {
        foundCard = specificCard;
      }
    }

    if (foundCard) {
      return {
        ...item,
        scryfall: foundCard
      };
    }

    // Fallback for cards not recognized or found in collection:
    // Use an empty image URI — the UI shows a generic card placeholder.
    // Previously this hotlinked to api.scryfall.com's redirect endpoint, which
    // counts against the API rate limit and breaks offline.
    const fallbackImageUrl = '';

    const placeholderCard: ScryfallCard = {
      id: `custom-${item.name}`,
      name: item.name,
      type_line: 'Card',
      color_identity: [],
      game_changer: false,
      image_uris: {
        normal: fallbackImageUrl,
        small: fallbackImageUrl,
        large: fallbackImageUrl
      }
    };

    return {
      ...item,
      scryfall: placeholderCard,
      isCustomOrNotFound: true
    };
  });
}

// --- Camera scan lookups ---

/**
 * Fetches a Scryfall endpoint with a timeout and bounded retries:
 * - aborts after FETCH_TIMEOUT_MS so a stalled request can't hang a scan;
 * - retries transient failures (network errors, timeouts, HTTP 429/5xx) up to
 *   MAX_FETCH_RETRIES times, honoring Retry-After on 429 when present;
 * - returns non-transient responses (e.g. 404) as-is for the caller to decide.
 * NOTE: Scryfall's API guidelines ask for a descriptive User-Agent that
 * includes contact information — add yours to the string below before publishing.
 */
async function fetchScryfall(url: string): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'DeckSync/1.0 (browser PWA)'
        },
        signal: controller.signal
      });
    } catch {
      // Network failure or timeout — transient; retry with linear backoff.
      clearTimeout(timeoutId);
      if (attempt >= MAX_FETCH_RETRIES) throw new Error('Scryfall request failed after retries');
      attempt++;
      await sleepMs(RETRY_BACKOFF_BASE_MS * attempt);
      continue;
    }
    clearTimeout(timeoutId);

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_FETCH_RETRIES) return response;

    // Drain the body so the socket can be reused, then back off.
    await response.body?.cancel().catch(() => { /* already consumed */ });
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
    const delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)
      : RETRY_BACKOFF_BASE_MS * (attempt + 1);
    attempt++;
    await sleepMs(delay);
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeCard(card: ScryfallCard): ScryfallCard {
  // Normalize game_changer boolean flag
  card.game_changer = Boolean(card.game_changer || card['game-changer']);
  return card;
}

/**
 * Looks up a specific printing from the set code + collector number printed on
 * the bottom-left corner of modern cards. Tries the direct /cards/{set}/{number}
 * endpoint first, then falls back to an in-set name search (matched client-side
 * by collector number) when a candidate name is available.
 */
export async function lookupCardByPrinting(
  setCode: string,
  collectorNumber: string,
  candidateName?: string
): Promise<ScryfallCard | null> {
  const set = setCode.toLowerCase();

  // 1. Direct printing endpoint (fast path on the public Scryfall API).
  //    Superset numbers like "20/270" may be indexed by their main number only.
  const numberCandidates = [collectorNumber];
  if (collectorNumber.includes('/')) {
    numberCandidates.push(collectorNumber.split('/')[0]);
  }

  for (const num of numberCandidates) {
    // Scryfall indexes alt-art suffixes in lowercase ("381z"); parsing uppercases them.
    const apiNumber = num.replace(/([A-Z])$/, m => m.toLowerCase());
    try {
      const response = await fetchScryfall(`${SCRYFALL_CARD_URL}/${encodeURIComponent(set)}/${encodeURIComponent(apiNumber)}`);
      if (response.ok) {
        return normalizeCard((await response.json()) as ScryfallCard);
      }
      if (response.status !== 404) break; // other errors: don't retry variants
    } catch {
      // Network hiccup — fall through to the search fallback below
    }
  }

  // 2. In-set name search, matched client-side by collector number
  if (candidateName) {
    try {
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
      const q = `name:"${candidateName.replace(/"/g, '')}" set:${set}`;
      const response = await fetchScryfall(`${SCRYFALL_SEARCH_URL}?q=${encodeURIComponent(q)}&unique=prints`);
      if (response.ok) {
        const json: ScryfallSearchResponse = await response.json();
        const hits = json.data ?? [];
        // Prefer the exact collector-number match (case-insensitive for alt-art
        // suffixes); otherwise accept the first hit
        return normalizeCard(
          hits.find(c => String(c.collector_number ?? '').toUpperCase() === collectorNumber.toUpperCase()) ?? hits[0] ?? null
        );
      }
    } catch (err) {
      console.warn('Scryfall in-set search failed:', err);
    }
  }

  return null;
}

/**
 * Names a candidate reading's closeness to the local card database, for ordering:
 *   0 = exact known name, 1 = fuzzy near-match (likely misread), 2 = unknown/noise.
 * Pass-through (all 0) when the database isn't loaded so legacy behavior holds.
 */
function nameMatchTier(name: string): 0 | 1 | 2 {
  if (!isCardDataReady()) return 0;
  if (hasCardName(name)) return 0;
  if (hasCardNameFuzzy(name)) return 1;
  return 2;
}

/** Session-scoped negative cache for the fuzzy name endpoint: candidates Scryfall
 *  already rejected with 404. OCR repeatedly produces the same garbage on
 *  repeated passes over the same card, so don't burn another API call on them. */
const knownNameMisses = new Set<string>();

/**
 * Fuzzy name lookup for the card-name fallback path (older cards don't print a
 * set code). Uses the local IndexedDB cache first, and — when the card database
 * is loaded — validates the candidate readings against it before any network
 * call: OCR noise that matches no known card name is rejected for free. OCR
 * glues garbage onto the reading — part of the mana cost or type line at the
 * end, an icon artifact (e.g. the graveyard glyph) at the start — so it tries:
 *   1. fuzzy on each candidate (real-name candidates first), cache-checked;
 *   2. a prefix search anchored on the first substantial word(s), scoring the
 *      hits by word overlap (handles long garbage tails fuzzy can't absorb).
 */
export async function lookupCardByName(name: string): Promise<ScryfallCard | null> {
  const words = name.split(/\s+/).filter(Boolean);
  const candidates: string[] = [name];
  if (words.length > 1) {
    candidates.push(words.slice(0, -1).join(' ')); // trailing garbage (cost / type line)
    candidates.push(words.slice(1).join(' ')); // leading garbage (icon artifacts)
  }
  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter(c => {
    const key = c.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Free local validation before spending an API call: if no candidate reading is
  // even close to a real card name, this is OCR noise — bail out without hitting
  // Scryfall. The gate is fuzzy (exact match, or near-match via containment / edit
  // distance) so misread old-frame names still reach the server-side fuzzy search
  // below; final resolution stays authoritative on the Scryfall response.
  // (Pass-through when the database isn't loaded, preserving legacy behavior.)
  const tiers = uniqueCandidates.map(nameMatchTier);
  if (isCardDataReady() && tiers.every(t => t === 2)) {
    return null;
  }

  // Best candidates first (exact > fuzzy > unknown), stable within each tier so
  // reading order is preserved — the fuzzy loop then succeeds on its first attempt
  // instead of burning calls on garbage variants.
  const ordered = isCardDataReady()
    ? uniqueCandidates
        .map((c, i) => ({ c, i, tier: tiers[i] }))
        .sort((a, b) => a.tier - b.tier || a.i - b.i)
        .map(x => x.c)
    : uniqueCandidates;

  let firstAttempt = true;
  for (const candidate of ordered) {
    const missKey = candidate.toLowerCase();
    // Skip candidates Scryfall already rejected with 404 this session.
    if (knownNameMisses.has(missKey)) continue;

    // Be polite to the rate limit between attempts (skipped before the first call).
    if (!firstAttempt) await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    firstAttempt = false;

    // IndexedDB cache first — repeat scans of the same card cost zero API calls.
    const cached = await getCachedCard(candidate);
    if (cached) return cached;

    try {
      const response = await fetchScryfall(`${SCRYFALL_CARD_URL}/named?fuzzy=${encodeURIComponent(candidate)}`);
      if (!response.ok) {
        // 404 is a definitive "no such card" — remember it so repeated passes
        // over the same misread don't burn another API call each time.
        if (response.status === 404) knownNameMisses.add(missKey);
        continue; // fuzzy miss — try the next candidate
      }
      const card = normalizeCard((await response.json()) as ScryfallCard);
      await cacheCards([card]);
      return card;
    } catch (err) {
      console.warn('Scryfall fuzzy name lookup failed:', err);
      return null;
    }
  }

  // Prefix search anchored on the first substantial word(s) of the reading.
  const anchors = words
    .map(w => w.replace(/[^a-z0-9]/gi, '').toLowerCase())
    .filter(w => w.length >= 4)
    .slice(0, 2);

  for (const anchor of anchors) {
    try {
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
      const response = await fetchScryfall(`${SCRYFALL_SEARCH_URL}?q=${encodeURIComponent(`name:${anchor}*`)}&unique=art`);
      if (!response.ok) continue;
      const json: ScryfallSearchResponse = await response.json();
      const hits = json.data ?? [];
      const bestName = pickBestNameMatch(name, hits.map(h => h.name));
      if (bestName) {
        const card = normalizeCard(hits.find(h => h.name === bestName)!);
        await cacheCards([card]);
        return card;
      }
    } catch (err) {
      console.warn('Scryfall prefix name search failed:', err);
      return null;
    }
  }

  return null;
}

/**
 * Resolves a card by its Scryfall id (obtained from the local printings map).
 * Checks the IndexedDB cache first, so repeat scans of a known printing cost
 * zero API calls. Returns null when the fetch fails or 404s.
 */
export async function lookupCardById(scryfallId: string): Promise<ScryfallCard | null> {
  const cached = await getCachedCardById(scryfallId);
  if (cached) return cached;

  try {
    const response = await fetchScryfall(`${SCRYFALL_CARD_URL}/${encodeURIComponent(scryfallId)}`);
    if (!response.ok) return null;
    const card = normalizeCard((await response.json()) as ScryfallCard);
    await cacheCards([card]);
    return card;
  } catch (err) {
    console.warn('Scryfall id lookup failed:', err);
    return null;
  }
}

export interface ScanLookupInput {
  /** OCR'd card-name candidate from the top name bar */
  name?: string;
  /** Set code parsed from the bottom-left corner (modern cards) */
  setCode?: string;
  /** Collector number parsed from the bottom-left corner (modern cards) */
  collectorNumber?: string;
}

/**
 * Resolves a photographed card. When the local card database is loaded, the
 * parsed values are validated against it first — free, no API call:
 *   - set + collector number in the printings map -> resolve by Scryfall id
 *     (IndexedDB cache first, otherwise a single GET /cards/{id});
 *   - set + collector number NOT in the map -> OCR noise, skip the printing
 *     lookup entirely and fall back to the name path;
 *   - name not matching any known card -> OCR noise, return null.
 * Without the database (first run before it was precached) the legacy
 * network-first paths are used unchanged.
 */
export async function identifyScannedCard(input: ScanLookupInput): Promise<ScryfallCard | null> {
  await ensureCardData(); // no-op once loaded; keeps validation data warm

  if (input.setCode && input.collectorNumber) {
    if (isCardDataReady()) {
      const id = findPrintingId(input.setCode, input.collectorNumber);
      if (id) {
        const byId = await lookupCardById(id);
        if (byId) return byId;
        // Id fetch failed (e.g. network hiccup) — fall through to the name path
      }
      // Unknown printing: never spend an API call on it
    } else {
      const byPrinting = await lookupCardByPrinting(input.setCode, input.collectorNumber, input.name);
      if (byPrinting) return byPrinting;
    }
  }

  if (input.name) {
    return await lookupCardByName(input.name);
  }

  return null;
}

/**
 * Finds the loaded-deck entry that corresponds to a Scryfall card. Handles
 * double-faced names ("Front // Back") and face-name variants.
 */
export function matchDeckCard(cards: DeckCardItem[], card: ScryfallCard): DeckCardItem | undefined {
  const names = new Set<string>();
  const add = (n?: string) => {
    if (n) names.add(n.toLowerCase().trim());
  };

  add(card.name);
  for (const sep of [' // ', ' / ']) {
    if (card.name.includes(sep)) {
      card.name.split(sep).forEach(add);
    }
  }
  card.card_faces?.forEach(f => add(f.name));

  return cards.find(c => names.has(c.name.toLowerCase().trim()));
}
