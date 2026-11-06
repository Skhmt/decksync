<script lang="ts">
  import { deckStore } from "../state/deck.svelte";
  import { scannerStore } from "../state/scanner.svelte";
  import type { MTGFormat } from "../types";
  import {
    banIconSvg,
    boltIconSvg,
    calendarXmarkIconSvg,
    cloneIconSvg,
    colorIcons,
    importIconSvg,
    warningIconSvg,
    cameraIconSvg,
  } from "../icons";

  let {
    headerHeight = $bindable(60),
    appMode = "sync" as "sync" | "scan",
    onAppModeChange,
    onOpenImport,
    onOpenBanned,
    onOpenGameChangers,
    onOpenCopyLimit,
    onOpenNotLegal,
    onOpenAbout,
    onOpenExport,
    onOpenScan,
  }: {
    headerHeight?: number;
    appMode: "sync" | "scan";
    onAppModeChange: (mode: "sync" | "scan") => void;
    onOpenImport: () => void;
    onOpenBanned: () => void;
    onOpenGameChangers: () => void;
    onOpenCopyLimit: () => void;
    onOpenNotLegal: () => void;
    onOpenAbout: () => void;
    onOpenExport: () => void;
    onOpenScan: () => void;
  } = $props();

  const isSync = $derived(appMode === "sync");

  // Dynamic values based on active mode
  const activeBannedCount = $derived(
    isSync ? deckStore.bannedCards.length : scannerStore.bannedCards.length
  );
  const activeGameChangerCount = $derived(
    isSync
      ? (deckStore.isCommander ? deckStore.gameChangerCount : 0)
      : (scannerStore.isCommander ? scannerStore.gameChangerCount : 0)
  );
  const activeCopyLimitCount = $derived(
    isSync ? deckStore.copyLimitViolations.length : scannerStore.copyLimitViolations.length
  );
  const activeColorIdentity = $derived(
    isSync ? deckStore.deckColorIdentity : scannerStore.colorIdentity
  );
  const activeFormat = $derived(isSync ? deckStore.format : scannerStore.format);

  function handleFormatChange(e: Event) {
    const val = (e.currentTarget as HTMLSelectElement).value as MTGFormat;
    if (isSync) {
      deckStore.format = val;
    } else {
      scannerStore.format = val;
    }
  }

  const formats: { value: MTGFormat; label: string }[] = [
    { value: "commander", label: "Commander / EDH" },
    { value: "standard", label: "Standard" },
    { value: "modern", label: "Modern" },
    { value: "pioneer", label: "Pioneer" },
    { value: "legacy", label: "Legacy" },
    { value: "vintage", label: "Vintage" },
    { value: "pauper", label: "Pauper" },
    { value: "oathbreaker", label: "Oathbreaker" },
  ];

  const colorStyles: Record<
    string,
    { bg: string; text: string; ring: string; label: string }
  > = {
    W: { bg: "bg-amber-100", text: "text-black", ring: "ring-amber-700/60", label: "White" },
    U: { bg: "bg-blue-500", text: "text-black", ring: "ring-blue-300/80", label: "Blue" },
    B: { bg: "bg-neutral-400", text: "text-black", ring: "ring-neutral-500/80", label: "Black" },
    R: { bg: "bg-red-500", text: "text-black", ring: "ring-red-300/80", label: "Red" },
    G: { bg: "bg-emerald-600", text: "text-black", ring: "ring-emerald-300/80", label: "Green" },
  };
</script>

<header
  bind:clientHeight={headerHeight}
  class="bg-base-200 border-b border-base-100 shadow-sm sticky top-0 z-30"
>
  <div
    class="max-w-7xl mx-auto px-3 sm:px-4 py-2 sm:py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2 sm:gap-3"
  >
    <!-- Left: Brand + Mode Toggle + Scan -->
    <div class="flex items-center justify-between gap-2 w-full md:w-auto">
      <div class="flex items-center gap-2 sm:gap-3 min-w-0">
        <!-- Logo -->
        <button
          onclick={onOpenAbout}
          class="shrink-0 cursor-pointer"
          title="About DeckSync"
          aria-label="About DeckSync"
        >
          <img
            src={`${import.meta.env.BASE_URL}icon.png`}
            alt="DeckSync"
            class="w-8 h-8 sm:w-10 sm:h-10 rounded-lg sm:rounded-xl shadow-md object-contain"
          />
        </button>

        <!-- Mode Toggle Tabs -->
        <div class="flex rounded-lg bg-base-300 p-0.5 gap-0.5">
          <button
            onclick={() => onAppModeChange("sync")}
            class="px-2.5 sm:px-3 py-1 text-xs sm:text-sm font-semibold rounded-md transition-all {appMode === 'sync'
              ? 'bg-base-100 shadow-sm text-primary'
              : 'text-base-content/60 hover:text-base-content'}"
          >
            Deck Sync
          </button>
          <button
            onclick={() => onAppModeChange("scan")}
            class="px-2.5 sm:px-3 py-1 text-xs sm:text-sm font-semibold rounded-md transition-all {appMode === 'scan'
              ? 'bg-base-100 shadow-sm text-primary'
              : 'text-base-content/60 hover:text-base-content'}"
          >
            Scan Deck
          </button>
        </div>

        <!-- Scan button (always visible, fixed position next to toggle) -->
        <button
          onclick={onOpenScan}
          class="btn btn-primary btn-xs sm:btn-sm gap-1 px-2"
          title={isSync ? "Verify physical cards" : "Scan new cards"}
        >
          <span class="w-3.5 h-3.5 shrink-0">{@html cameraIconSvg}</span>
          <span class="hidden sm:inline">Scan</span>
        </button>
      </div>

      <!-- Actions (mode-specific) -->
      <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {#if isSync}
          <!-- SYNC MODE ACTIONS -->
          <button
            onclick={onOpenImport}
            class="btn btn-primary btn-xs sm:btn-sm gap-1 shadow-sm"
            title="Import Decklist"
          >
            <span class="w-3.5 h-3.5 shrink-0">{@html importIconSvg}</span>
            <span class="hidden sm:inline">Import</span>
          </button>
        {:else}
          <!-- SCAN MODE ACTIONS -->
          <button
            onclick={onOpenExport}
            class="btn btn-outline btn-xs sm:btn-sm gap-1"
            disabled={scannerStore.cards.length === 0}
            title="Export scanned deck"
          >
            <span>Export</span>
          </button>
        {/if}
      </div>
    </div>

    <!-- Format & Summary Badges -->
    <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
      <!-- Color Identity Badges (dynamic) -->
      {#if activeColorIdentity.length > 0}
        <div
          class="flex items-center gap-0.5 sm:gap-1 px-1.5 py-0.5 sm:px-2 sm:py-1 bg-base-100 rounded-lg border border-base-300"
          title="Deck Color Identity"
        >
          {#each activeColorIdentity as color}
            <span
              class="w-4 h-4 sm:w-5 sm:h-5 rounded-full flex items-center justify-center shadow-xs ring-1 {colorStyles[
                color
              ]?.bg || 'bg-base-300'} {colorStyles[color]?.text ||
                'text-base-content'} {colorStyles[color]?.ring ||
                'ring-base-400'}"
              title={colorStyles[color]?.label || color}
            >
              {@html colorIcons[color] ?? ""}
            </span>
          {/each}
        </div>
      {/if}

      <!-- Game Changer Count Badge (Commander / EDH only, dynamic) -->
      {#if activeGameChangerCount > 0}
        <button
          onclick={onOpenGameChangers}
          class="badge badge-warning badge-xs sm:badge-sm md:badge-md gap-1 font-semibold shadow-xs cursor-pointer hover:brightness-90 active:scale-95 transition-all duration-150"
          title="Click to see game changers"
        >
          <span class="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0 text-neutral-900"
            >{@html boltIconSvg}</span
          >
          <span
            >{activeGameChangerCount}
            <span class="hidden sm:inline"
              >Game Changer{activeGameChangerCount === 1 ? "" : "s"}</span
            ><span class="sm:hidden">GC</span></span
          >
        </button>
      {/if}

      <!-- Banned Cards Alert (dynamic) -->
      {#if activeBannedCount > 0}
        <button
          onclick={onOpenBanned}
          class="btn btn-error btn-xs sm:btn-sm gap-1 animate-pulse"
          title="Click to see banned cards"
        >
          <span class="w-3.5 h-3.5 shrink-0">{@html banIconSvg}</span>
          {activeBannedCount} Banned!
        </button>
      {/if}

      <!-- Copy Limit Violations Alert (dynamic) -->
      {#if activeCopyLimitCount > 0}
        <button
          onclick={onOpenCopyLimit}
          class="btn btn-error btn-xs sm:btn-sm gap-1"
          title="Click to see cards over the copy limit"
        >
          <span class="w-3.5 h-3.5 shrink-0">{@html cloneIconSvg}</span>
          {activeCopyLimitCount} Over Limit
        </button>
      {/if}

      <!-- Not Legal in Format Alert (sync only) -->
      {#if isSync && deckStore.notLegalCards.length > 0}
        <button
          onclick={onOpenNotLegal}
          class="btn btn-error btn-xs sm:btn-sm gap-1"
          title="Click to see cards that are not legal in this format"
        >
          <span class="w-3.5 h-3.5 shrink-0">{@html calendarXmarkIconSvg}</span>
          {deckStore.notLegalCards.length} Not Legal
        </button>
      {/if}

      <!-- Card Count Validation Alert (sync only) -->
      {#if isSync && !deckStore.cardCountValidation.isValid && deckStore.cards.length > 0}
        <div
          class="badge badge-error badge-xs sm:badge-sm md:badge-md gap-1 font-semibold"
          title={deckStore.cardCountValidation.message}
        >
          <span class="w-3 h-3 shrink-0">{@html warningIconSvg}</span>
          <span>Count: {deckStore.totalExpectedCards}</span>
        </div>
      {/if}

      <!-- Extra Cards Alert (sync only) -->
      {#if isSync && deckStore.extraCards.length > 0}
        <div
          class="badge badge-warning badge-xs sm:badge-sm md:badge-md gap-1 font-semibold text-neutral-900"
          title="{deckStore.totalExtraCards} extra card{deckStore.totalExtraCards ===
          1
            ? ''
            : 's'} found"
        >
          <span class="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0 text-neutral-900"
            >{@html warningIconSvg}</span
          >
          <span>{deckStore.totalExtraCards} Extra</span>
        </div>
      {/if}

      <!-- Format Selector (shared, binds to active store) -->
      <div class="flex items-center gap-1 ml-auto">
        <label
          for="format-select"
          class="text-xs font-semibold text-base-content/70 hidden lg:inline"
          >Format:</label
        >
        <select
          id="format-select"
          class="select select-bordered select-xs sm:select-sm font-medium bg-base-100"
          value={activeFormat}
          onchange={handleFormatChange}
        >
          {#each formats as fmt}
            <option value={fmt.value}>{fmt.label}</option>
          {/each}
        </select>
      </div>
    </div>
  </div>

  <!-- Progress bar (always rendered for consistent height, fill only in sync) -->
  <div class="w-full bg-base-300 h-1.5 overflow-hidden">
    {#if isSync && deckStore.cards.length > 0}
      <div
        class="bg-success h-full transition-all duration-300 ease-out"
        style="width: {deckStore.verificationPercentage}%"
      ></div>
    {/if}
  </div>
</header>
