import type { MTGFormat, DeckCardItem, DeckVerificationLog, SavedDeckSession, VerificationToast, LegalityStatus } from '../types';
import { enrichDeckCards, CARD_TYPE_ORDER, getCardPrimaryType } from '../api/scryfall';
import { parseDecklistText } from '../parser/decklist';
import { importDeckFromUrl } from '../parser/urlImporter';
import { saveVerificationLog, saveDeckSession, getLatestDeckSession } from '../storage/db';

export class DeckState {
  deckName = $state<string>('My Deck');
  format = $state<MTGFormat>('commander');
  cards = $state<DeckCardItem[]>([]);
  rawPayload = $state<string>('');
  sourceUrl = $state<string | undefined>(undefined);

  // UI preferences
  viewMode = $state<'grid' | 'list'>('grid');
  groupByType = $state<boolean>(true);
  filterMode = $state<'all' | 'not_found' | 'found'>('all');
  searchQuery = $state<string>('');

  // Undo toast for cards verified in the "not found" view or removed in the "found" view
  verificationToast = $state<VerificationToast | null>(null);

  // Loading states
  isLoading = $state<boolean>(false);
  loadingMessage = $state<string>('');
  loadingProgress = $state<{ current: number; total: number } | null>(null);

  // Derived properties
  totalExpectedCards = $derived(
    this.cards.reduce((sum, c) => sum + c.targetCount, 0)
  );

  totalVerifiedCards = $derived(
    this.cards.reduce((sum, c) => sum + Math.min(c.verifiedCount, c.targetCount), 0)
  );

  totalFoundCards = $derived(
    this.cards.reduce((sum, c) => sum + (c.verifiedCount ?? 0), 0)
  );

  totalMissingCards = $derived(
    this.cards.reduce((sum, c) => sum + Math.max(0, c.targetCount - (c.verifiedCount ?? 0)), 0)
  );

  totalExtraCards = $derived(
    this.cards.reduce((sum, c) => sum + Math.max(0, (c.verifiedCount ?? 0) - c.targetCount), 0)
  );

  verificationPercentage = $derived(
    this.totalExpectedCards > 0
      ? Math.round((this.totalVerifiedCards / this.totalExpectedCards) * 100)
      : 0
  );

  hasCompanion = $derived(
    this.cards.some(c => c.section === 'companion')
  );

  deckColorIdentity = $derived.by(() => {
    const identitySet = new Set<string>();
    for (const card of this.cards) {
      if (card.scryfall?.color_identity) {
        for (const color of card.scryfall.color_identity) {
          identitySet.add(color);
        }
      }
    }
    // MTG WUBRG order
    const order = ['W', 'U', 'B', 'R', 'G'];
    return order.filter(c => identitySet.has(c));
  });

  gameChangerCount = $derived(
    this.cards.reduce((count, c) => {
      if (c.scryfall?.game_changer) {
        return count + c.targetCount;
      }
      return count;
    }, 0)
  );

  // Game changers only matter for Commander / EDH
  isCommander = $derived(this.format === 'commander');

  gameChangerCards = $derived(
    this.cards.filter(c => c.scryfall?.game_changer)
  );

  bannedCards = $derived.by(() => {
    const formatKey = this.format === 'commander' ? 'commander' : this.format;
    return this.cards.filter(c => {
      const legality = c.scryfall?.legalities?.[formatKey];
      return legality === 'banned';
    });
  });

  /**
   * True when the card's type line marks it as a basic land
   * (e.g. "Basic Land — Plains", "Snow-Covered Basic Land — Mountain").
   */
  isBasicLand(card: DeckCardItem): boolean {
    return /basic\s+land/i.test(card.scryfall?.type_line ?? '');
  }

  /**
   * Scryfall legality of the card in the currently selected format.
   * All supported MTGFormat values are valid Scryfall legality keys.
   */
  getFormatLegality(card: DeckCardItem): LegalityStatus | undefined {
    return card.scryfall?.legalities?.[this.format];
  }

  /**
   * Maximum number of copies of this card allowed in the current format,
   * or null when unlimited (basic lands, sideboard cards).
   * - Commander / Oathbreaker: one copy of each unique card (basic lands exempt)
   * - 60-card formats: 4 copies of a non-land card in the main deck,
   *   restricted cards limited to 1, basic lands unlimited, no per-card limit in the sideboard
   */
  getCopyLimit(card: DeckCardItem): number | null {
    // Cards Scryfall couldn't resolve (tokens, proxies, custom) can't be validated
    if (card.isCustomOrNotFound) return null;

    // Basic lands are unlimited in every format
    if (this.isBasicLand(card)) return null;

    if (this.format === 'commander' || this.format === 'oathbreaker') {
      return 1;
    }

    // 60-card formats: sideboards have no per-card copy limit
    if (card.section === 'sideboard') return null;

    // Restricted cards are limited to one copy (e.g. Ancestral Recall in Vintage)
    if (this.getFormatLegality(card) === 'restricted') return 1;

    return 4;
  }

  /**
   * Cards whose listed count exceeds what the current format allows:
   * duplicates in Commander, more than 4 of a card in 60-card formats,
   * more than 1 copy of a restricted card, etc.
   */
  copyLimitViolations = $derived(
    this.cards.filter(c => {
      const limit = this.getCopyLimit(c);
      return limit !== null && c.targetCount > limit;
    })
  );

  /**
   * Cards that can't be played in the current format at all: their set has
   * rotated out of the format's pool, the set isn't allowed in the format,
   * or the card is otherwise outside the format (e.g. non-common in Pauper).
   * Scryfall reports these as `not_legal` for the format.
   */
  notLegalCards = $derived(
    this.cards.filter(c => {
      const legality = c.scryfall?.legalities?.[this.format];
      return legality === 'not_legal';
    })
  );

  cardCountValidation = $derived.by(() => {
    const total = this.totalExpectedCards;
    if (this.cards.length === 0) {
      return { isValid: true, message: '' };
    }

    if (this.format === 'commander') {
      const target = this.hasCompanion ? 101 : 100;
      if (total !== target) {
        return {
          isValid: false,
          message: `Commander decks must contain exactly ${target} cards (currently ${total})`
        };
      }
    } else {
      // 60-card formats (standard, modern, pioneer, legacy, vintage, pauper)
      if (total < 60) {
        return {
          isValid: false,
          message: `${this.format.toUpperCase()} decks must contain at least 60 cards (currently ${total})`
        };
      }
    }

    return { isValid: true, message: 'Card count matches format requirements' };
  });

  missingCards = $derived.by(() => {
    return this.cards
      .filter(c => c.verifiedCount < c.targetCount)
      .map(c => ({
        name: c.name,
        count: c.targetCount - c.verifiedCount
      }));
  });

  extraCards = $derived.by(() => {
    return this.cards
      .filter(c => c.verifiedCount > c.targetCount)
      .map(c => ({
        name: c.name,
        count: c.verifiedCount - c.targetCount
      }));
  });

  // Filtered and sorted card list for display
  displayedCards = $derived.by(() => {
    let result = [...this.cards];

    // Filter by view filter (all / not_found / found)
    // A multi-copy card counts as "found" once any copy is verified, so a
    // partially-found card (e.g. 4/10 Forests) appears in both the "Found" and
    // "Not Found" views until it is fully verified.
    if (this.filterMode === 'not_found') {
      result = result.filter(c => c.verifiedCount < c.targetCount);
    } else if (this.filterMode === 'found') {
      result = result.filter(c => c.verifiedCount > 0);
    }

    // Filter by search query
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.scryfall?.type_line && c.scryfall.type_line.toLowerCase().includes(q))
      );
    }

    // Sort cards
    if (this.groupByType) {
      // Organized by card type, then alphabetically
      result.sort((a, b) => {
        const typeA = a.section === 'commander' ? 'Commander' : getCardPrimaryType(a.scryfall?.type_line);
        const typeB = b.section === 'commander' ? 'Commander' : getCardPrimaryType(b.scryfall?.type_line);

        const orderA = CARD_TYPE_ORDER[typeA] ?? 99;
        const orderB = CARD_TYPE_ORDER[typeB] ?? 99;

        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
      });
    } else {
      // Entire deck listed alphabetically, ignoring card type
      result.sort((a, b) => a.name.localeCompare(b.name));
    }

    return result;
  });

  // Grouped cards for section headers when groupByType is active
  displayedGroups = $derived.by(() => {
    if (!this.groupByType) {
      return [{ title: 'All Cards', cards: this.displayedCards }];
    }

    const groupsMap = new Map<string, DeckCardItem[]>();

    for (const card of this.displayedCards) {
      const typeKey = card.section === 'commander' ? 'Commander' : getCardPrimaryType(card.scryfall?.type_line);
      if (!groupsMap.has(typeKey)) {
        groupsMap.set(typeKey, []);
      }
      groupsMap.get(typeKey)!.push(card);
    }

    // Order groups by CARD_TYPE_ORDER
    const sortedGroupKeys = Array.from(groupsMap.keys()).sort((a, b) => {
      const orderA = CARD_TYPE_ORDER[a] ?? 99;
      const orderB = CARD_TYPE_ORDER[b] ?? 99;
      return orderA - orderB;
    });

    return sortedGroupKeys.map(key => ({
      title: key,
      cards: groupsMap.get(key)!
    }));
  });

  // Actions
  async loadFromText(text: string, name?: string): Promise<void> {
    this.isLoading = true;
    this.loadingMessage = 'Parsing decklist...';
    this.loadingProgress = null;

    try {
      const parsed = parseDecklistText(text, name || 'Imported Deck');
      this.deckName = parsed.deckName;
      this.rawPayload = text;
      this.sourceUrl = undefined;

      this.loadingMessage = 'Fetching card details from Scryfall...';
      const enriched = await enrichDeckCards(parsed.cards, (curr, tot) => {
        this.loadingProgress = { current: curr, total: tot };
      });

      this.cards = enriched;
      await this.persistSession();
    } finally {
      this.isLoading = false;
      this.loadingProgress = null;
      this.loadingMessage = '';
    }
  }

  async loadFromUrl(url: string): Promise<void> {
    this.isLoading = true;
    this.loadingMessage = `Importing from ${new URL(url).hostname}...`;
    this.loadingProgress = null;

    try {
      const parsed = await importDeckFromUrl(url);
      this.deckName = parsed.deckName;
      this.rawPayload = parsed.rawText;
      this.sourceUrl = url;

      this.loadingMessage = 'Fetching card details from Scryfall...';
      const enriched = await enrichDeckCards(parsed.cards, (curr, tot) => {
        this.loadingProgress = { current: curr, total: tot };
      });

      this.cards = enriched;
      await this.persistSession();
    } finally {
      this.isLoading = false;
      this.loadingProgress = null;
      this.loadingMessage = '';
    }
  }

  // Verification actions
  toggleCard(id: string): void {
    const card = this.cards.find(c => c.id === id);
    if (!card) return;

    const previousCount = card.verifiedCount;
    const wasVerified = previousCount >= card.targetCount;

    if (card.targetCount > 1) {
      // Multiple copies (e.g. basic lands): toggle between 0 and targetCount
      if (card.verifiedCount >= card.targetCount) {
        card.verifiedCount = 0;
      } else {
        card.verifiedCount = card.targetCount;
      }
    } else {
      // Single copy: toggle 0 and 1
      card.verifiedCount = card.verifiedCount > 0 ? 0 : 1;
    }

    const isNowVerified = card.verifiedCount >= card.targetCount;

    // In the "not found" view a tap marks the card as found, and in the "found"
    // view it removes it — surface both with an undo toast in case of misclicks
    if (this.filterMode === 'not_found' && !wasVerified && isNowVerified) {
      this.verificationToast = {
        cardId: card.id,
        cardName: card.name,
        previousCount,
        action: 'found'
      };
    } else if (this.filterMode === 'found' && wasVerified && !isNowVerified) {
      this.verificationToast = {
        cardId: card.id,
        cardName: card.name,
        previousCount,
        action: 'unfound'
      };
    }

    this.persistSession();
  }

  // Verification-toast actions
  undoVerificationToast(): void {
    const toast = this.verificationToast;
    if (!toast) return;
    const card = this.cards.find(c => c.id === toast.cardId);
    if (card) {
      card.verifiedCount = toast.previousCount;
      // Camera captures also bump scanCount — revert that too so a cancelled
      // capture doesn't keep the "captured multiple times" badge alive
      if (toast.previousScanCount !== undefined) {
        card.scanCount = toast.previousScanCount;
      }
    }
    this.verificationToast = null;
    this.persistSession();
  }

  dismissVerificationToast(): void {
    this.verificationToast = null;
  }

  /**
   * Register a camera capture of a card: marks one copy as found and records
   * the capture (scanCount) so cards photographed more than once are flagged
   * in the deck views, similar to multi-copy counters.
   */
  recordCameraScan(id: string): void {
    const card = this.cards.find(c => c.id === id);
    if (!card) return;

    // Surface an undo toast so a misclicked capture can be reverted
    this.verificationToast = {
      cardId: card.id,
      cardName: card.name,
      previousCount: card.verifiedCount,
      previousScanCount: card.scanCount ?? 0,
      action: 'found'
    };

    card.verifiedCount += 1;
    card.scanCount = (card.scanCount ?? 0) + 1;
    this.persistSession();
  }

  unverifyCard(id: string): void {
    const card = this.cards.find(c => c.id === id);
    if (!card) return;
    card.verifiedCount = 0;
    // Reset capture history so a re-verification starts fresh
    card.scanCount = 0;
    this.persistSession();
  }

  incrementCard(id: string): void {
    const card = this.cards.find(c => c.id === id);
    if (!card) return;
    card.verifiedCount += 1;
    this.persistSession();
  }

  decrementCard(id: string): void {
    const card = this.cards.find(c => c.id === id);
    if (!card) return;
    if (card.verifiedCount > 0) {
      card.verifiedCount -= 1;
      this.persistSession();
    }
  }

  checkAll(): void {
    for (const card of this.cards) {
      card.verifiedCount = card.targetCount;
    }
    this.persistSession();
  }

  uncheckAll(): void {
    for (const card of this.cards) {
      card.verifiedCount = 0;
      card.scanCount = 0;
    }
    this.persistSession();
  }

  async persistSession(): Promise<void> {
    if (this.cards.length === 0) return;

    const checkedStatus: Record<string, number> = {};
    const scanCounts: Record<string, number> = {};
    for (const c of this.cards) {
      checkedStatus[c.name] = c.verifiedCount;
      if (c.scanCount && c.scanCount > 0) {
        scanCounts[c.name] = c.scanCount;
      }
    }

    const session: SavedDeckSession = {
      id: 'active_session',
      name: this.deckName,
      format: this.format,
      rawPayload: this.rawPayload,
      sourceUrl: this.sourceUrl,
      updatedAt: Date.now(),
      checkedStatus,
      scanCounts
    };

    try {
      await saveDeckSession(session);
    } catch (e) {
      console.warn('Failed to save session to IndexedDB:', e);
    }
  }

  async restoreSession(): Promise<boolean> {
    try {
      const session = await getLatestDeckSession();
      if (!session || !session.rawPayload) return false;

      this.format = session.format || 'commander';
      await this.loadFromText(session.rawPayload, session.name);

      // Restore checked counts
      if (session.checkedStatus) {
        for (const card of this.cards) {
          if (typeof session.checkedStatus[card.name] === 'number') {
            // Never restore a negative count
            card.verifiedCount = Math.max(0, session.checkedStatus[card.name]);
          }
        }
      }
      // Restore camera capture counts (absent in older sessions)
      if (session.scanCounts) {
        for (const card of this.cards) {
          const scans = session.scanCounts[card.name];
          if (typeof scans === 'number' && scans > 0) {
            card.scanCount = scans;
          }
        }
      }
      return true;
    } catch (e) {
      console.warn('Failed to restore deck session:', e);
      return false;
    }
  }

  async logVerification(): Promise<DeckVerificationLog> {
    const checkedStatus: Record<string, number> = {};
    for (const c of this.cards) {
      checkedStatus[c.name] = c.verifiedCount;
    }

    const log: DeckVerificationLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      deckName: this.deckName,
      format: this.format,
      timestamp: Date.now(),
      rawPayload: this.rawPayload,
      sourceUrl: this.sourceUrl,
      totalExpected: this.totalExpectedCards,
      totalVerified: this.totalVerifiedCards,
      missingCards: this.missingCards,
      extraCards: this.extraCards,
      checkedStatus
    };

    await saveVerificationLog(log);
    return log;
  }
}

export const deckStore = new DeckState();

