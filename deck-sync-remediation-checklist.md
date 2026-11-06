# DeckSync Remediation & Action Checklist

This checklist breaks down every recommended action from the code review into concrete, executable sub-steps with the technical rationale behind each change.

---

## Phase 1: Critical Bug Fixes & Mode Decoupling

- [ ] **1. Decouple Modals from `deckStore` to Support "Scan Deck" Mode**
  * **Why**: When in Scan mode (`appMode === 'scan'`), clicking header warning badges (Banned, Over Limit, Game Changers) or the scan summary banner opens modals that statically read from `deckStore`. In scan mode, these modals show unrelated cards from a previously loaded deck or remain empty.
  * [ ] **1.1 Update [`BannedModal.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/BannedModal.svelte)**
    * Accept props `cards: Array<{ name: string; targetCount?: number; count?: number; scryfall?: any }>` and `format: MTGFormat` instead of importing and reading `deckStore.bannedCards` and `deckStore.format`.
    * Render either `card.targetCount` or `card.count` for copy quantity.
  * [ ] **1.2 Update [`CopyLimitModal.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/CopyLimitModal.svelte)**
    * Accept `cards`, `format`, and a `getCopyLimit(card)` callback (or determine limit directly from `format`) instead of reading `deckStore.copyLimitViolations`.
  * [ ] **1.3 Update [`GameChangerModal.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/GameChangerModal.svelte)**
    * Accept `cards` and `format` props instead of reading `deckStore.gameChangerCards`.
  * [ ] **1.4 Update [`NotLegalModal.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/NotLegalModal.svelte)**
    * Accept `cards` and `format` props for consistency and future support in Scan mode.
  * [ ] **1.5 Pass Active State from [`App.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/App.svelte#L194-L197)**
    * Determine active cards and format based on `appMode`:
      ```svelte
      <BannedModal
        isOpen={isBannedOpen}
        cards={appMode === 'sync' ? deckStore.bannedCards : scannerStore.bannedCards}
        format={appMode === 'sync' ? deckStore.format : scannerStore.format}
        onClose={() => isBannedOpen = false}
      />
      ```

---

- [ ] **2. Key Scanned Cards by Normalized Name in `ScannerState`**
  * **Why**: Scanned cards are currently keyed by `card.id` (Scryfall printing UUID). Scanning different printings of the same card (e.g., one *Dominaria* Counterspell and one *Commander Legends* Counterspell) creates two separate entries with `count: 1`. This bypasses Commander singleton copy limit violations, inflates unique card counts, and duplicates export lines.
  * [ ] **2.1 Update Card Identity in [`scanner.svelte.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/state/scanner.svelte.ts#L146-L166)**
    * Key entries in `this.cards` by normalized name (`card.name.toLowerCase().trim()`) rather than `card.id`.
    * If an existing entry with the same name exists, increment its count and optionally update the latest scanned printing metadata (`setCode`, `collectorNumber`, `scryfall`).
  * [ ] **2.2 Pass Scanned Set & Collector Info from [`CardScanModal.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/CardScanModal.svelte#L332-L335)**
    * When `mode === 'collect'`, pass `hit.card.set` and `hit.card.collector_number` to `onCardAdded(card, setCode, collectorNumber)`.
  * [ ] **2.3 Verify `copyLimitViolations` and `uniqueCardCount`**
    * Confirm that multi-copy violations in singleton formats (Commander/Oathbreaker) trigger properly when different printings of the same card are scanned.

---

- [ ] **3. Fix Color Identity & MTG Ordering in `ScannerState`**
  * **Why**: `ScannerState.colorIdentity` currently inspects `card.scryfall.colors` (card color) instead of `card.scryfall.color_identity` (rules text identity), missing cards like *Bolas's Citadel* or off-color commanders. It also sorts alphabetically (`B, G, R, U, W`) rather than MTG standard WUBRG order (`W, U, B, R, G`).
  * [ ] **3.1 Update [`scanner.svelte.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/state/scanner.svelte.ts#L48-L57)**
    * Replace `card.scryfall?.colors` with `card.scryfall?.color_identity`.
    * Filter identity against the WUBRG order array:
      ```typescript
      colorIdentity = $derived.by(() => {
        const identitySet = new Set<string>();
        for (const card of this.cards) {
          if (card.scryfall?.color_identity) {
            for (const c of card.scryfall.color_identity) identitySet.add(c);
          }
        }
        const order = ['W', 'U', 'B', 'R', 'G'];
        return order.filter(c => identitySet.has(c));
      });
      ```

---

- [ ] **4. Prevent History Stack Pollution in `CardScanModal`**
  * **Why**: An `$effect` pushes `{ scannerOpen: true }` to browser history when the camera opens to intercept back gestures, but closing the camera via the UI "✕" button or clicking "Close" leaves the history entry behind. Repeatedly opening and closing the camera stacks dead history entries that trap mobile users.
  * [ ] **4.1 Track Closure Source in [`CardScanModal.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/CardScanModal.svelte#L141-L155)**
    * In `handleClose(isPopState = false)`: if `!isPopState` and `history.state?.scannerOpen`, call `history.back()`.
    * In the `popstate` event listener, pass `handleClose(true)` so the browser's native pop is not doubled.

---

- [ ] **5. Fix Section Key Collisions in `logVerification`**
  * **Why**: `DeckState.persistSession()` keys checked status by `${c.section}|${c.name}` to allow the same card in mainboard and sideboard. But `DeckState.logVerification()` keys by bare `c.name`. When a verified deck with sideboard duplicates is logged and later restored from `HistoryModal`, the sideboard count overwrites the mainboard count.
  * [ ] **5.1 Update [`deck.svelte.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/state/deck.svelte.ts#L534-L538)**
    * Key `checkedStatus` in `logVerification()` by `${c.section}|${c.name}`.
  * [ ] **5.2 Update [`HistoryModal.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/HistoryModal.svelte#L53-L60)**
    * In `handleRestoreLog`, check `log.checkedStatus[`${card.section}|${card.name}`]` first, falling back to `log.checkedStatus[card.name]` for backwards compatibility with legacy logs.

---

- [x] **6. Correct Vite `base` URL Option**
  * **Why**: `base: '.'` triggers a build-time warning in Vite 8 (`(!) invalid "base" option: "."`). Vite requires an absolute URL, `./`, or an empty string.
  * [x] **6.1 Update [`vite.config.ts`](file:///c:/Users/Mike/Desktop/DeckSync/vite.config.ts#L9)**
    * Change `base: '.'` to `base: './'`.

---

## Phase 2: Performance & Memory Optimizations

- [ ] **7. Optimize and Offload `hasCardNameFuzzy` (Combined Strategy)**
  * **Why**: `db.names` holds 37,229 unique card names. When OCR captures camera noise that isn't a known name, `hasCardNameFuzzy` executes up to 37,229 string containment and Levenshtein distance calculations on the main UI thread. In continuous scanning mode (every 700 ms), testing multiple candidate strings locks the UI thread for 100–400+ ms per cycle.
  * [ ] **7.1 Algorithmic Optimization (Bucketing & Fast Rejection)**
    * Reject candidates with fewer than 4 characters or very low vowel/consonant entropy before running fuzzy matching.
    * Partition and bucket names by length (`Math.abs(n.length - q.length) <= 2`) and initial characters so search space is pruned from 37k down to ~500–1,500 candidates.
  * [ ] **7.2 Web Worker Offloading**
    * Run this optimized search inside [`dataLoader.worker.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/data/dataLoader.worker.ts) via async worker messaging (`workerClient.ts`).
    * Keeps the main UI thread at 0 ms overhead for zero dropped frames during camera video streaming.

---

- [ ] **8. Fix `cardIdIndex` Cache Invalidation in `db.ts`**
  * **Why**: `getCachedCardById` relies on a cached in-memory map `cardIdIndex` built once from IndexedDB. When new cards are fetched from Scryfall and stored with `cacheCards(cards)`, `cardIdIndex` is never updated. Subsequent ID lookups for those cards miss the memory index and make unnecessary network requests.
  * [ ] **8.1 Update [`db.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/storage/db.ts#L172-L192)**
    * Inside `cacheCards(cards)`, if `cardIdIndex` has already been instantiated, insert the newly fetched cards into `cardIdIndex`.

---

- [ ] **9. Pool Canvases in Continuous Camera Loop**
  * **Why**: `CardScanModal.svelte` captures a burst of 3 frames every 700 ms. Each frame instantiates a new 1920×1440 canvas element (~11 MB of RGBA data each, ~33 MB per burst). Additional canvases are created for resizing and cropping. This causes intense garbage collection pressure and thermal throttling on mobile devices.
  * [ ] **9.1 Create Scratch Canvas Pool in [`cardScanner.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/ocr/cardScanner.ts)**
    * Allocate reusable offscreen canvas instances for frame capture and region preprocessing instead of calling `document.createElement('canvas')` on every frame.

---

- [ ] **10. Add Rate-Limit Exponential Backoff for Scryfall API**
  * **Why**: Scryfall requires callers to pace requests and handle HTTP 429/503 responses gracefully. If rate-limited, `scryfall.ts` logs a warning and fails the lookup without retrying or respecting the `Retry-After` header.
  * [ ] **10.1 Update `fetchScryfall` in [`scryfall.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/api/scryfall.ts#L382-L390)**
    * Inspect HTTP status: on 429 or 503, parse the `Retry-After` header (or back off with exponential jitter: 500 ms, 1000 ms, 2000 ms) and retry up to 2 times before rejecting.

---

## Phase 3: MTG Domain & Parser Hardening

- [ ] **11. Implement Oathbreaker Deck Size Validation**
  * **Why**: Oathbreaker is a supported format in the dropdown, but `cardCountValidation` lumps it into the `else` branch checking `total < 60`. Oathbreaker decks must contain **exactly 60 cards** (58 maindeck cards + 1 Oathbreaker Planeswalker + 1 Signature Spell in the command zone).
  * [ ] **11.1 Update Validation in [`deck.svelte.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/state/deck.svelte.ts#L165-L190)**
    * Add an explicit check for `this.format === 'oathbreaker'`:
      ```typescript
      if (this.format === 'oathbreaker' && total !== 60) {
        return {
          isValid: false,
          message: `Oathbreaker decks must contain exactly 60 cards (currently ${total})`
        };
      }
      ```

---

- [ ] **12. Validate Sideboard Size Limits (Max 15 Cards)**
  * **Why**: In 60-card formats (Standard, Modern, Pioneer, Legacy, Vintage, Pauper), decks are allowed up to 15 sideboard cards. Currently, a deck with 60 mainboard cards and 25 sideboard cards reports as completely valid.
  * [ ] **12.1 Add Sideboard Validation in [`deck.svelte.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/state/deck.svelte.ts#L180-L188)**
    * Calculate `totalSideboardCards = this.cards.filter(c => c.section === 'sideboard').reduce((s, c) => s + c.targetCount, 0)`.
    * If `totalSideboardCards > 15`, flag the validation as invalid with an informative message.

---

- [ ] **13. Support Superset Slashes in Collector Number Regex**
  * **Why**: When decklists contain collector numbers with superset fractions like `402/500` or `20/270`, pattern 2 in `parseDecklistText` only matches digits (`402`), leaving `/500` in the card name segment, which gets severed by downstream slash splitting.
  * [ ] **13.1 Update Regex in [`decklist.ts`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/parser/decklist.ts#L114)**
    * Allow `/` in collector number patterns: `/[\[\(]([a-zA-Z0-9]{2,6})[\]\)]\s*([a-zA-Z0-9★*\-\.\/]+)?/`.

---

## Phase 4: UI/UX & Accessibility Enhancements

- [ ] **14. Scope `select-none` to Interactive Cards Rather than `<body>`**
  * **Why**: Setting `select-none` on `<body>` in `index.html` prevents users from selecting or copying text anywhere in the app (card names, rules text, error logs, Scryfall IDs, import instructions).
  * [ ] **14.1 Update [`index.html`](file:///c:/Users/Mike/Desktop/DeckSync/index.html#L14)**
    * Remove `select-none` from `<body>`.
  * [ ] **14.2 Add `select-none` to Card Components**
    * Ensure `select-none` is maintained on [`CardItem.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/CardItem.svelte#L68) and [`ScannerCardItem.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/ScannerCardItem.svelte#L35) to prevent accidental text selection during fast tapping.

---

- [ ] **15. Add Keyboard Navigation Handlers to Card Items**
  * **Why**: Card items have `role="button"` and `tabindex="0"`, but lack `onkeydown` handlers, requiring `<!-- svelte-ignore a11y_click_events_have_key_events -->` and preventing keyboard-only / screen-reader verification.
  * [ ] **15.1 Add Keyboard Handler in [`CardItem.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/CardItem.svelte)**
    * Add `onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardClick(); } }}`.
  * [ ] **15.2 Add Keyboard Handler in [`CardList.svelte`](file:///c:/Users/Mike/Desktop/DeckSync/src/lib/components/CardList.svelte)**
    * Add matching keyboard triggers to list rows.
