<script lang="ts">
  import { onMount } from 'svelte';
  import { deckStore } from './lib/state/deck.svelte';
  import { ensureCardData } from './lib/data/cardData';
  import Header from './lib/components/Header.svelte';
  import FilterBar from './lib/components/FilterBar.svelte';
  import CardGrid from './lib/components/CardGrid.svelte';
  import CardList from './lib/components/CardList.svelte';
  import ImportModal from './lib/components/ImportModal.svelte';
  import HistoryModal from './lib/components/HistoryModal.svelte';
  import BannedModal from './lib/components/BannedModal.svelte';
  import GameChangerModal from './lib/components/GameChangerModal.svelte';
  import CopyLimitModal from './lib/components/CopyLimitModal.svelte';
  import NotLegalModal from './lib/components/NotLegalModal.svelte';
  import AboutModal from './lib/components/AboutModal.svelte';
  import CardScanModal from './lib/components/CardScanModal.svelte';
  import VerificationToast from './lib/components/VerificationToast.svelte';
  import CategoryNav from './lib/components/CategoryNav.svelte';
  import { archiveIconSvg, warningIconSvg } from './lib/icons';

  let isImportOpen = $state(false);
  let isHistoryOpen = $state(false);
  let isBannedOpen = $state(false);
  let isGameChangersOpen = $state(false);
  let isCopyLimitOpen = $state(false);
  let isNotLegalOpen = $state(false);
  let isAboutOpen = $state(false);
  let isScanOpen = $state(false);
  let headerHeight = $state(60);
  let filterBarHeight = $state(56);

  onMount(async () => {
    // Load the local card database (card names + printings index) used by the
    // scanner for free OCR validation — fails soft, lookups fall back to Scryfall.
    void ensureCardData();
    // Attempt to restore prior session
    await deckStore.restoreSession();
  });
</script>

<div class="min-h-dvh flex flex-col bg-base-300 text-base-content">
  <!-- Top Navigation & Summary -->
  <Header
    bind:headerHeight
    onOpenImport={() => isImportOpen = true}
    onOpenHistory={() => isHistoryOpen = true}
    onOpenBanned={() => isBannedOpen = true}
    onOpenGameChangers={() => isGameChangersOpen = true}
    onOpenCopyLimit={() => isCopyLimitOpen = true}
    onOpenNotLegal={() => isNotLegalOpen = true}
    onOpenAbout={() => isAboutOpen = true}
  />

  <!-- Format Warnings Banner (if card count invalid or banned cards) -->
  {#if !deckStore.cardCountValidation.isValid && deckStore.cards.length > 0}
    <div class="bg-error/15 border-b border-error/30 text-error-content px-3 sm:px-4 py-2 text-xs flex items-center justify-between">
      <div class="flex items-center gap-2 max-w-7xl mx-auto w-full">
        <span class="w-4 h-4 shrink-0 text-error">{@html warningIconSvg}</span>
        <span class="font-medium text-error">{deckStore.cardCountValidation.message}</span>
      </div>
    </div>
  {/if}

  <!-- Filter & View Controls Bar -->
  {#if deckStore.cards.length > 0}
    <FilterBar {headerHeight} bind:filterHeight={filterBarHeight} onOpenScan={() => isScanOpen = true} />
  {/if}

  <!-- Main Content Area -->
  <main class="flex-1 max-w-7xl w-full mx-auto px-2 sm:px-4 py-4 sm:py-6">
    <!-- Loading Overlay -->
    {#if deckStore.isLoading}
      <div class="py-24 flex flex-col items-center justify-center text-center space-y-4">
        <div class="w-16 h-16 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
        <div>
          <h3 class="font-bold text-base text-base-content">{deckStore.loadingMessage || 'Loading...'}</h3>
          {#if deckStore.loadingProgress}
            <div class="w-64 bg-base-200 rounded-full h-2 mt-2 overflow-hidden mx-auto">
              <div
                class="bg-primary h-full transition-all duration-200"
                style="width: {(deckStore.loadingProgress.current / deckStore.loadingProgress.total) * 100}%"
              ></div>
            </div>
            <p class="text-xs text-base-content/60 mt-1">
              {deckStore.loadingProgress.current} / {deckStore.loadingProgress.total} cards processed
            </p>
          {/if}
        </div>
      </div>
    {:else if deckStore.cards.length === 0}
      <!-- Empty State -->
      <div class="py-24 text-center max-w-md mx-auto space-y-4">
        <div class="w-20 h-20 rounded-2xl bg-base-200 mx-auto flex items-center justify-center text-primary shadow-sm">
          <span class="w-10 h-10">{@html archiveIconSvg}</span>
        </div>
        <div>
          <h2 class="text-xl font-bold text-base-content">No Deck Loaded</h2>
          <p class="text-xs text-base-content/60 mt-1">
            Import a decklist from Moxfield, Archidekt, MTGGoldfish, TappedOut or paste raw text to begin verifying cards.
          </p>
        </div>
        <div class="pt-2 flex justify-center gap-3">
          <button onclick={() => isImportOpen = true} class="btn btn-primary btn-sm">
            Import Decklist
          </button>
        </div>
      </div>
    {:else}
      <!-- Cards Display View: Grid or List, with floating category legend on desktop -->
      <div class="flex items-start gap-4">
        <div class="flex-1 min-w-0">
          {#if deckStore.viewMode === 'grid'}
            <CardGrid />
          {:else}
            <CardList />
          {/if}
        </div>
        <!-- Floating category legend (desktop only, needs grouped sections) -->
        <CategoryNav stickyTop={headerHeight + filterBarHeight + 8} />
      </div>
    {/if}
  </main>

  <!-- Modals -->
  <ImportModal isOpen={isImportOpen} onClose={() => isImportOpen = false} />
  <HistoryModal isOpen={isHistoryOpen} onClose={() => isHistoryOpen = false} />
  <BannedModal isOpen={isBannedOpen} onClose={() => isBannedOpen = false} />
  <GameChangerModal isOpen={isGameChangersOpen} onClose={() => isGameChangersOpen = false} />
  <CopyLimitModal isOpen={isCopyLimitOpen} onClose={() => isCopyLimitOpen = false} />
  <NotLegalModal isOpen={isNotLegalOpen} onClose={() => isNotLegalOpen = false} />
  <AboutModal isOpen={isAboutOpen} onClose={() => isAboutOpen = false} />
  <CardScanModal isOpen={isScanOpen} onClose={() => isScanOpen = false} />

  <!-- Bottom toast with undo when a card is verified or removed in the filtered views -->
  <VerificationToast />
</div>
