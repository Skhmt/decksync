export type MTGFormat =
  | 'commander'
  | 'standard'
  | 'modern'
  | 'pioneer'
  | 'legacy'
  | 'vintage'
  | 'pauper'
  | 'oathbreaker';

/**
 * Per-format legality values as reported by Scryfall.
 * - legal: card may be played in the format
 * - not_legal: card is outside the format's pool (set rotation, illegal sets, pauper rarity, etc.)
 * - restricted: card is legal but limited to one copy per deck
 * - banned: card may not be used in the format at all
 */
export type LegalityStatus = 'legal' | 'not_legal' | 'restricted' | 'banned';

export interface CardFace {
  name: string;
  type_line?: string;
  mana_cost?: string;
  oracle_text?: string;
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
    png?: string;
    art_crop?: string;
  };
}

export interface ScryfallCard {
  id: string;
  name: string;
  type_line: string;
  mana_cost?: string;
  cmc?: number;
  colors?: string[];
  color_identity: string[];
  game_changer?: boolean;
  'game-changer'?: boolean;
  layout?: string;
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
    png?: string;
    art_crop?: string;
  };
  card_faces?: CardFace[];
  legalities?: Record<string, LegalityStatus>;
  rarity?: string;
  set?: string;
  collector_number?: string;
}

export interface DeckCardItem {
  id: string; // unique identifier (e.g. name + section)
  name: string;
  rawName: string;
  targetCount: number;
  verifiedCount: number;
  /** How many times this card was captured via camera (0 = never scanned) */
  scanCount?: number;
  extraCount?: number;
  section: 'commander' | 'mainboard' | 'sideboard' | 'companion' | 'other';
  setCode?: string;
  collectorNumber?: string;
  isFoil?: boolean;
  scryfall?: ScryfallCard;
  isCustomOrNotFound?: boolean;
}

export interface DeckVerificationLog {
  id: string;
  deckName: string;
  format: MTGFormat;
  timestamp: number;
  rawPayload: string;
  sourceUrl?: string;
  totalExpected: number;
  totalVerified: number;
  missingCards: Array<{ name: string; count: number }>;
  extraCards: Array<{ name: string; count: number }>;
  checkedStatus: Record<string, number>;
  notes?: string;
}

export interface SavedDeckSession {
  id: string;
  name: string;
  format: MTGFormat;
  rawPayload: string;
  sourceUrl?: string;
  updatedAt: number;
  checkedStatus: Record<string, number>;
  /** card name -> times captured via camera (optional for older sessions) */
  scanCounts?: Record<string, number>;
}

export interface VerificationToast {
  cardId: string;
  cardName: string;
  previousCount: number;
  /** Previous scanCount when the action was a camera capture (undefined for tap actions) */
  previousScanCount?: number;
  action: 'found' | 'unfound';
}

/** Result of a camera scan, shown in the confirmation modal */
export interface CardScanOutcome {
  /** The printing resolved via Scryfall (null when identification failed) */
  card: ScryfallCard | null;
  /** The loaded-deck entry this card matched (null when not in the deck) */
  deckCard: DeckCardItem | null;
  /** Raw OCR text of the bottom-left set/collector region (debug aid) */
  ocrSetRaw?: string;
  /** Raw OCR text of the top name-bar region (debug aid) */
  ocrNameRaw?: string;
  /** Which channel identified the card first (debug aid) */
  method?: 'ocr' | 'hash';
  /** Set when the scan itself failed (e.g. OCR engine could not load) */
  error?: string;
}

// --- Deck Scanner types ---

/** A card in the scanned (collected) deck */
export interface ScannedDeckCard {
  id: string;              // stable unique id (scryfall id or name-based)
  name: string;
  count: number;           // how many copies found via scanning
  scryfall?: ScryfallCard; // enriched card data
  setCode?: string;        // specific printing scanned (from OCR)
  collectorNumber?: string;
  /** How the physical printing was identified. Only 'hash' and 'collector' reflect
   *  the actual card in hand — a 'name' lookup resolves to an arbitrary Scryfall
   *  printing, so its set/collector data is not trustworthy for export. */
  printingSource?: 'hash' | 'collector' | 'name';
}

/** Persisted scanned deck session */
export interface SavedScannedDeck {
  id: string;
  name: string;
  format: MTGFormat;
  cards: ScannedDeckCard[];
  updatedAt: number;
}

