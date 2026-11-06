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

  /** Whether the current format is Commander/EDH */
  isCommander = $derived(this.format === 'commander');

  /** Color identity derived from all scanned cards */
  colorIdentity = $derived.by(() => {
    const identitySet = new Set<string>();
    for (const card of this.cards) {
      const colors = card.scryfall?.colors;
      if (colors) {
        for (const c of colors) identitySet.add(c);
      }
    }
    return Array.from(identitySet).sort();
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
  addCard(card: ScryfallCard, setCode?: string, collectorNumber?: string): void {
    const id = card.id || card.name.toLowerCase().replace(/\s+/g, '-');
    const existing = this.cards.find(c => c.id === id);

    if (existing) {
      existing.count += 1;
      if (setCode) existing.setCode = setCode;
      if (collectorNumber) existing.collectorNumber = collectorNumber;
    } else {
      this.cards.push({
        id,
        name: card.name,
        count: 1,
        scryfall: card,
        setCode,
        collectorNumber
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
      cards: this.cards,
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
      return true;
    } catch (e) {
      console.warn('Failed to restore scanned deck:', e);
      return false;
    }
  }

  // --- Export ---

  /** Generate a plain-text decklist for pasting into Archidekt, Moxfield, etc. */
  generateExportText(): string {
    const sorted = [...this.cards].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map(c => `${c.count} ${c.name}`).join('\n');
  }

  /** Generate an Archidekt deep-link URL with the decklist */
  generateArchidektUrl(): string {
    const list = this.generateExportText();
    const encoded = encodeURIComponent(list);
    return `https://archidekt.com/deck/create?list=${encoded}`;
  }

  /** Generate a Moxfield import URL (uses the same plain-text format) */
  generateMoxfieldUrl(): string {
    const list = this.generateExportText();
    const encoded = encodeURIComponent(list);
    return `https://www.moxfield.com/deck/create?decklist=${encoded}`;
  }
}

export const scannerStore = new ScannerState();