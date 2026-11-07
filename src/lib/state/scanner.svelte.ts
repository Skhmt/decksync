import { type MTGFormat, type ScannedDeckCard, type SavedScannedDeck, type ScryfallCard } from '../types';
import { saveScannedDeck, getLatestScannedDeck, deleteScannedDeck } from '../storage/db';

const ACTIVE_SESSION_ID = 'active_scanner_session';
import { getCardPrimaryType, CARD_TYPE_ORDER } from '../api/scryfall';

/**
 * Reactive state for the Deck Scanner mode.
 *
 * Mirrors the DeckState pattern (Svelte 5 runes) but is fully independent —
 * it tracks a free-form collected deck built by scanning physical cards, with
 * no pre-loaded decklist to verify against.
 */
export class ScannerState {
  // --- Reactive state ---
  cards = $state<ScannedDeckCard[]>([]);
  format = $state<MTGFormat>('commander');
  viewMode = $state<'grid' | 'list'>('grid');
  groupByType = $state(true);
  searchQuery = $state('');
  deckName = $state('My Scanned Deck');

  // --- Derived ---

  /** Total number of physical cards in the scanned deck */
  totalCards = $derived(this.cards.reduce((sum, c) => sum + c.count, 0));

  /** Unique card count (not copies) */
  uniqueCardCount = $derived(this.cards.length);

  /** Cards that are banned in the current format */
  bannedCards = $derived(
    this.cards.filter(c => c.scryfall?.legalities?.[this.format] === 'banned')
  );

  /** Cards flagged as game-changers by Scryfall */
  gameChangerCards = $derived(
    this.cards.filter(c => c.scryfall?.game_changer || c.scryfall?.['game-changer'])
  );

  /** Count of game changer cards */
  gameChangerCount = $derived(this.gameChangerCards.length);

  /** Cards that can't be played in the current format (Scryfall `not_legal`) */
  notLegalCards = $derived(
    this.cards.filter(c => c.scryfall?.legalities?.[this.format] === 'not_legal')
  );

  /** Whether the current format is Commander/EDH */
  isCommander = $derived(this.format === 'commander');

  /** Color identity derived from all scanned cards (rules-text identity, WUBRG order) */
  colorIdentity = $derived.by(() => {
    const identitySet = new Set<string>();
    for (const card of this.cards) {
      // Use Scryfall's `color_identity` (rules text), not `colors` (card colors),
      // so off-color commanders / artifacts like Bolas's Citadel are captured.
      const identity = card.scryfall?.color_identity;
      if (identity) {
        for (const c of identity) identitySet.add(c);
      }
    }
    // MTG standard WUBRG order rather than alphabetical
    const order = ['W', 'U', 'B', 'R', 'G'];
    return order.filter((c) => identitySet.has(c));
  });

  /** Cards whose count exceeds the format's copy limit */
  copyLimitViolations = $derived(
    this.cards.filter(c => {
      const limit = this.getCopyLimit(c);
      return limit !== null && c.count > limit;
    })
  );

  /** Filtered and sorted cards for display */
  displayedCards = $derived.by(() => {
    let result = [...this.cards];

    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.scryfall?.type_line && c.scryfall.type_line.toLowerCase().includes(q))
      );
    }

    if (this.groupByType) {
      result.sort((a, b) => {
        const typeA = getCardPrimaryType(a.scryfall?.type_line);
        const typeB = getCardPrimaryType(b.scryfall?.type_line);
        const orderA = CARD_TYPE_ORDER[typeA] ?? 99;
        const orderB = CARD_TYPE_ORDER[typeB] ?? 99;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
      });
    } else {
      result.sort((a, b) => a.name.localeCompare(b.name));
    }

    return result;
  });

  /** Grouped cards for section headers when groupByType is active */
  displayedGroups = $derived.by(() => {
    if (!this.groupByType) {
      return [{ title: 'All Cards', cards: this.displayedCards }];
    }

    const groupsMap = new Map<string, ScannedDeckCard[]>();
    for (const card of this.displayedCards) {
      const typeKey = getCardPrimaryType(card.scryfall?.type_line);
      if (!groupsMap.has(typeKey)) {
        groupsMap.set(typeKey, []);
      }
      groupsMap.get(typeKey)!.push(card);
    }

    const sortedGroupKeys = Array.from(groupsMap.keys()).sort((a, b) => {
      return (CARD_TYPE_ORDER[a] ?? 99) - (CARD_TYPE_ORDER[b] ?? 99);
    });

    return sortedGroupKeys.map(key => ({
      title: key,
      cards: groupsMap.get(key)!
    }));
  });


  // --- Helpers ---

  /**
   * Maximum number of copies of this card allowed in the current format.
   * Returns null when unlimited (basic lands) or when the card can't be validated.
   */
  getCopyLimit(card: ScannedDeckCard): number | null {
    if (!card.scryfall) return null;

    // Basic lands are unlimited
    if (/basic\s+land/i.test(card.scryfall.type_line ?? '')) return null;

    if (this.format === 'commander' || this.format === 'oathbreaker') {
      return 1;
    }

    // Restricted cards limited to 1
    if (card.scryfall.legalities?.[this.format] === 'restricted') return 1;

    return 4;
  }

  // --- Actions ---

  /** Add a card (or increment its count) to the scanned deck */
  addCard(
    card: ScryfallCard,
    setCode?: string,
    collectorNumber?: string,
    source?: 'hash' | 'collector' | 'name'
  ): void {
    // Key by normalized name so different printings of the same card merge into
    // one entry — otherwise scanning e.g. two different Counterspell sets would
    // create two separate count-1 entries and bypass singleton copy limits.
    const nameKey = card.name.toLowerCase().trim();
    const existing = this.cards.find(c => c.name.toLowerCase().trim() === nameKey);

    if (existing) {
      existing.count += 1;
      // Only trust printing metadata from reliable detections (image hash or
      // collector-info OCR). A name-only hit maps to an *arbitrary* Scryfall
      // printing, so it must never clobber a real printing we already captured
      // or downgrade the source — otherwise a later name fallback would hide
      // collector info we legitimately have.
      if (source && source !== 'name') {
        existing.printingSource = source;
        if (setCode) existing.setCode = setCode;
        if (collectorNumber) existing.collectorNumber = collectorNumber;
      }
    } else {
      this.cards.push({
        id: nameKey,
        name: card.name,
        count: 1,
        scryfall: card,
        setCode,
        collectorNumber,
        printingSource: source
      });
    }

    this.persistSession();
  }

  /** Remove one copy of a card (removes the entry entirely at zero) */
  removeCard(id: string): void {
    const idx = this.cards.findIndex(c => c.id === id);
    if (idx === -1) return;

    this.cards[idx].count -= 1;
    if (this.cards[idx].count <= 0) {
      this.cards.splice(idx, 1);
    }

    this.persistSession();
  }

  /** Remove all copies of a card */
  removeCardAll(id: string): void {
    const idx = this.cards.findIndex(c => c.id === id);
    if (idx === -1) return;
    this.cards.splice(idx, 1);
    this.persistSession();
  }

  /** Increment a card's count manually */
  incrementCard(id: string): void {
    const card = this.cards.find(c => c.id === id);
    if (card) {
      card.count += 1;
      this.persistSession();
    }
  }

  /** Clear all cards from the scanned deck and remove any persisted session */
  async clearAll(): Promise<void> {
    this.cards = [];
    try {
      await deleteScannedDeck(ACTIVE_SESSION_ID);
    } catch (e) {
      console.warn('Failed to clear persisted scanned deck:', e);
    }
  }

  // --- Persistence ---

  async persistSession(): Promise<void> {
    if (this.cards.length === 0) return;

    const session: SavedScannedDeck = {
      id: ACTIVE_SESSION_ID,
      name: this.deckName,
      format: this.format,
      // Svelte 5 $state arrays are Proxies — both IndexedDB and structuredClone
      // reject them, so we round-trip through JSON to get plain objects.
      cards: JSON.parse(JSON.stringify(this.cards)),
      updatedAt: Date.now()
    };

    try {
      await saveScannedDeck(session);
    } catch (e) {
      console.warn('Failed to save scanned deck:', e);
    }
  }

  async restoreSession(): Promise<boolean> {
    try {
      const session = await getLatestScannedDeck();
      if (!session || session.cards.length === 0) return false;

      this.format = session.format || 'commander';
      this.deckName = session.name || 'My Scanned Deck';
      this.cards = session.cards;
      console.info(`[DeckSync] scanner restore: ${session.cards.length} card(s) loaded from IndexedDB`);
      return true;
    } catch (e) {
      console.warn('Failed to restore scanned deck:', e);
      return false;
    }
  }

  // --- Export ---

  /**
   * Generate a plain-text decklist for pasting into Archidekt, Moxfield, etc.
   * When `includeCollectorInfo` is set, cards whose physical printing was detected
   * via image hash or collector-info OCR get a `(SET) number` suffix, e.g.
   * `1 War Room (SOC) 422`. Cards identified by name only are left plain, since a
   * name lookup does not tell us which printing the user actually has.
   */
  generateExportText(includeCollectorInfo = false): string {
    const sorted = [...this.cards].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map(c => {
      let line = `${c.count} ${c.name}`;
      if (
        includeCollectorInfo &&
        c.setCode &&
        c.collectorNumber &&
        (c.printingSource === 'hash' || c.printingSource === 'collector')
      ) {
        line += ` (${c.setCode.toUpperCase()}) ${c.collectorNumber}`;
      }
      return line;
    }).join('\n');
  }
}

export const scannerStore = new ScannerState();