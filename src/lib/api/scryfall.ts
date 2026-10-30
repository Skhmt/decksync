import type { ScryfallCard, DeckCardItem } from '../types';
import { getCachedCard, getCachedCardById, cacheCards } from '../storage/db';
import { pickBestNameMatch } from '../ocr/parse';
import { ensureCardData, findPrintingId, hasCardName, hasCardNameFuzzy, isCardDataReady } from '../data/cardData';

const SCRYFALL_COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const SCRYFALL_SEARCH_URL = 'https://api.scryfall.com/cards/search';
const SCRYFALL_CARD_URL = 'https://api.scryfall.com/cards';
const BATCH_SIZE = 75;
const PRINT_BATCH_SIZE = 10;
const PRINT_PAGE_SIZE = 30;
const MAX_PRINT_PAGES = 3;
const RATE_LIMIT_DELAY_MS = 100;

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

  // Fallback: if an image can't be found, get image via Scryfall named?fuzzy image redirect
  if (card.name) {
    const cleanSearch = card.name.split('/')[0].replace(/[-–—]?\s*\d+.*$/, '').trim();
    return `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cleanSearch || card.name)}&format=image`;
  }

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
  //    so card images match the exact printing listed. If a printing can't be found
  //    (e.g. invalid set), no entry is added and the name-resolved default card above
  //    is used instead (current behavior).
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

  for (let i = 0; i < printRequests.length; i += PRINT_BATCH_SIZE) {
    const batch = printRequests.slice(i, i + PRINT_BATCH_SIZE);
    // One OR clause per requested printing: exact name within the requested set.
    // Parentheses keep boolean precedence unambiguous; unknown sets simply match
    // nothing, so they don't affect the other clauses (fallback stays intact).
    // unique=prints is required so all matching printings are returned (the default
    // dedupes to a single representative printing per card).
    const q = batch
      .map(r => `(name:"${r.name.replace(/"/g, '')}" set:${r.setCode})`)
      .join(' OR ');

    try {
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= MAX_PRINT_PAGES) {
        const url = `${SCRYFALL_SEARCH_URL}?q=${encodeURIComponent(q)}&page_size=${PRINT_PAGE_SIZE}&unique=prints&page=${page}`;
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'DeckSync/1.0'
          }
        });

        if (!response.ok) {
          console.warn(`Scryfall printing search returned status ${response.status}`);
          break;
        }

        const json: ScryfallSearchResponse = await response.json();
        for (const card of json.data ?? []) {
          // Normalize game_changer boolean flag
          card.game_changer = Boolean(card.game_changer || card['game-changer']);
        }

        // Match each requested printing against the results by set + collector number
        for (const req of batch) {
          const lowerName = req.name.toLowerCase().trim();
          const key = `${lowerName}::${req.setCode}::${req.collectorNumber}`;
          if (printMap.has(key)) continue;

          const match = (json.data ?? []).find(c => {
            if (String(c.set ?? '').toLowerCase() !== req.setCode) return false;
            if (String(c.collector_number ?? '') !== req.collectorNumber) return false;
            const cardName = c.name.toLowerCase().trim();
            // Exact name, or the decklist only lists the front face of a double-faced card
            return cardName === lowerName || cardName.startsWith(lowerName + ' /') || cardName.startsWith(lowerName + ' //');
          });

          if (match) {
            printMap.set(key, match);
          }
        }

        hasMore = Boolean(json.has_more);
        page++;
      }
    } catch (err) {
      console.error('Failed to fetch Scryfall printing batch:', err);
    }

    // Rate-limit pause if there are more batches
    if (i + PRINT_BATCH_SIZE < printRequests.length) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
  }

  // 4. Save newly fetched cards to IndexedDB cache
  //    (specific printing cards are intentionally NOT cached: the cache is keyed by
  //    card name and stores the default printing, so caching a specific set's art
  //    would change images for future decks that don't specify a set)
  if (newlyFetched.length > 0) {
    await cacheCards(newlyFetched);
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
    // "just get any image": generate fallback image URI pointing to Scryfall named?fuzzy image redirect!
    const cleanSearchName = item.name.split('/')[0].replace(/[-–—]?\s*\d+.*$/, '').trim() || item.name;
    const fallbackImageUrl = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cleanSearchName)}&format=image`;

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

async function fetchScryfall(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'DeckSync/1.0'
    }
  });
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
    // Be polite to the rate limit between attempts (skipped before the first call).
    if (!firstAttempt) await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    firstAttempt = false;

    // IndexedDB cache first — repeat scans of the same card cost zero API calls.
    const cached = await getCachedCard(candidate);
    if (cached) return cached;

    try {
      const response = await fetchScryfall(`${SCRYFALL_CARD_URL}/named?fuzzy=${encodeURIComponent(candidate)}`);
      if (!response.ok) continue; // fuzzy miss — try the next candidate
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
