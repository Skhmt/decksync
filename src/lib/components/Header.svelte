<script lang="ts">
  import { deckStore } from "../state/deck.svelte";
  import type { MTGFormat } from "../types";
  import {
    banIconSvg,
    boltIconSvg,
    calendarXmarkIconSvg,
    clockIconSvg,
    cloneIconSvg,
    colorIcons,
    importIconSvg,
    saveLogIconSvg,
    warningIconSvg,
  } from "../icons";

  let {
    headerHeight = $bindable(60),
    onOpenImport,
    onOpenHistory,
    onOpenBanned,
    onOpenGameChangers,
    onOpenCopyLimit,
    onOpenNotLegal,
    onOpenAbout,
  }: {
    headerHeight?: number;
    onOpenImport: () => void;
    onOpenHistory: () => void;
    onOpenBanned: () => void;
    onOpenGameChangers: () => void;
    onOpenCopyLimit: () => void;
    onOpenNotLegal: () => void;
    onOpenAbout: () => void;
  } = $props();

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
    W: {
      bg: "bg-amber-100",
      text: "text-black",
      ring: "ring-amber-700/60",
      label: "White",
    },
    U: {
      bg: "bg-blue-500",
      text: "text-black",
      ring: "ring-blue-300/80",
      label: "Blue",
    },
    B: {
      bg: "bg-neutral-400",
      text: "text-black",
      ring: "ring-neutral-500/80",
      label: "Black",
    },
    R: {
      bg: "bg-red-500",
      text: "text-black",
      ring: "ring-red-300/80",
      label: "Red",
    },
    G: {
      bg: "bg-emerald-600",
      text: "text-black",
      ring: "ring-emerald-300/80",
      label: "Green",
    },
  };

  let isLoggingSuccess = $state(false);

  async function handleLogVerification() {
    await deckStore.logVerification();
    isLoggingSuccess = true;
    setTimeout(() => {
      isLoggingSuccess = false;
    }, 2500);
  }
</script>

<header
  bind:clientHeight={headerHeight}
  class="bg-base-200 border-b border-base-100 shadow-sm sticky top-0 z-30"
>
  <div
    class="max-w-7xl mx-auto px-3 sm:px-4 py-2 sm:py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2 sm:gap-3"
  >
    <!-- Top Row on Mobile: Brand, Title & Actions -->
    <div class="flex items-center justify-between gap-2 w-full md:w-auto">
      <!-- Brand & Deck Title -->
      <div class="flex items-center gap-2 sm:gap-3 min-w-0">
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
        <div class="min-w-0">
          <div class="flex items-center gap-1.5 sm:gap-2">
            <h1
              class="text-sm sm:text-lg md:text-xl font-bold tracking-tight text-base-content truncate max-w-[130px] xs:max-w-[190px] sm:max-w-xs md:max-w-md"
            >
              {deckStore.deckName || "DeckSync"}
            </h1>
            {#if deckStore.cards.length > 0}
              <span
                class="badge badge-xs sm:badge-sm badge-neutral shrink-0 font-mono"
              >
                {deckStore.totalVerifiedCards}/{deckStore.totalExpectedCards}
                <span class="hidden sm:inline ml-0.5">Verified</span>
              </span>
            {/if}
          </div>
          <p class="text-[11px] text-base-content/60 hidden md:block">
            MTG Physical Deck Checklist & Verifier
          </p>
        </div>
      </div>

      <!-- Actions on Mobile (pushed to right) -->
      <div class="flex items-center gap-1.5 sm:gap-2 shrink-0 md:hidden">
        <button
          onclick={onOpenImport}
          class="btn btn-primary btn-xs sm:btn-sm gap-1 shadow-sm"
          title="Import Decklist"
        >
          <span class="w-3.5 h-3.5 shrink-0">{@html importIconSvg}</span>
          <span class="text-xs">Import</span>
        </button>

        {#if deckStore.cards.length > 0}
          <button
            onclick={handleLogVerification}
            class="btn btn-outline btn-xs sm:btn-sm px-2 gap-1"
            disabled={isLoggingSuccess}
            title="Save verification log"
          >
            {#if isLoggingSuccess}
              <span class="text-success font-bold text-xs">✓</span>
            {:else}
              <span class="w-3.5 h-3.5 shrink-0">{@html saveLogIconSvg}</span>
            {/if}
          </button>
        {/if}

        <button
          onclick={onOpenHistory}
          class="btn btn-ghost btn-xs sm:btn-sm btn-square"
          title="Verification History & Logs"
          aria-label="Verification History"
        >
          <span class="w-4 h-4">{@html clockIconSvg}</span>
        </button>

        <a
          href="https://github.com/Skhmt/decksync"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-ghost btn-xs sm:btn-sm btn-square"
          title="DeckSync on GitHub"
          aria-label="DeckSync on GitHub"
        >
          <span class="w-4 h-4">{@html githubIconSvg}</span>
        </a>
      </div>
    </div>

    <!-- Format & Summary Badges -->
    <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
      <!-- Format Selector -->
      <div class="flex items-center gap-1">
        <label
          for="format-select"
          class="text-xs font-semibold text-base-content/70 hidden lg:inline"
          >Format:</label
        >
        <select
          id="format-select"
          class="select select-bordered select-xs sm:select-sm font-medium bg-base-100"
          value={deckStore.format}
          onchange={(e) =>
            (deckStore.format = e.currentTarget.value as MTGFormat)}
        >
          {#each formats as fmt}
            <option value={fmt.value}>{fmt.label}</option>
          {/each}
        </select>
      </div>

      <!-- Color Identity Badges -->
      {#if deckStore.deckColorIdentity.length > 0}
        <div
          class="flex items-center gap-0.5 sm:gap-1 px-1.5 py-0.5 sm:px-2 sm:py-1 bg-base-100 rounded-lg border border-base-300"
          title="Deck Color Identity"
        >
          {#each deckStore.deckColorIdentity as color}
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

      <!-- Game Changer Count Badge (Commander / EDH only) -->
      {#if deckStore.isCommander && deckStore.gameChangerCount > 0}
        <button
          onclick={onOpenGameChangers}
          class="badge badge-warning badge-xs sm:badge-sm md:badge-md gap-1 font-semibold shadow-xs cursor-pointer hover:brightness-90 active:scale-95 transition-all duration-150"
          title="Click to see game changers in this deck"
        >
          <span class="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0 text-neutral-900"
            >{@html boltIconSvg}</span
          >
          <span
            >{deckStore.gameChangerCount}
            <span class="hidden sm:inline"
              >Game Changer{deckStore.gameChangerCount === 1 ? "" : "s"}</span
            ><span class="sm:hidden">GC</span></span
          >
        </button>
      {/if}

      <!-- Banned Cards Alert -->
      {#if deckStore.bannedCards.length > 0}
        <button
          onclick={onOpenBanned}
          class="btn btn-error btn-xs sm:btn-sm gap-1 animate-pulse"
          title="Click to see banned cards found in this deck"
        >
          <span class="w-3.5 h-3.5 shrink-0">{@html banIconSvg}</span>
          {deckStore.bannedCards.length} Banned!
        </button>
      {/if}

      <!-- Copy Limit Violations Alert -->
      {#if deckStore.copyLimitViolations.length > 0}
        <button
          onclick={onOpenCopyLimit}
          class="btn btn-error btn-xs sm:btn-sm gap-1"
          title="Click to see cards with more copies than this format allows"
        >
          <span class="w-3.5 h-3.5 shrink-0">{@html cloneIconSvg}</span>
          {deckStore.copyLimitViolations.length} Over Limit
        </button>
      {/if}

      <!-- Not Legal in Format Alert (set rotation / illegal sets) -->
      {#if deckStore.notLegalCards.length > 0}
        <button
          onclick={onOpenNotLegal}
          class="btn btn-error btn-xs sm:btn-sm gap-1"
          title="Click to see cards that are not legal in this format"
        >
          <span class="w-3.5 h-3.5 shrink-0">{@html calendarXmarkIconSvg}</span>
          {deckStore.notLegalCards.length} Not Legal
        </button>
      {/if}

      <!-- Card Count Validation Alert -->
      {#if !deckStore.cardCountValidation.isValid && deckStore.cards.length > 0}
        <div
          class="badge badge-error badge-xs sm:badge-sm md:badge-md gap-1 font-semibold"
          title={deckStore.cardCountValidation.message}
        >
          <span class="w-3 h-3 shrink-0">{@html warningIconSvg}</span>
          <span>Count: {deckStore.totalExpectedCards}</span>
        </div>
      {/if}

      <!-- Extra Cards Alert -->
      {#if deckStore.extraCards.length > 0}
        <div
          class="badge badge-warning badge-xs sm:badge-sm md:badge-md gap-1 font-semibold text-neutral-900"
          title="{deckStore.totalExtraCards} extra card{deckStore.totalExtraCards === 1 ? '' : 's'} found"
        >
          <span class="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0 text-neutral-900">{@html warningIconSvg}</span>
          <span>{deckStore.totalExtraCards} Extra</span>
        </div>
      {/if}
    </div>

    <!-- Actions on Desktop (hidden on mobile, shown on md+) -->
    <div class="hidden md:flex items-center gap-2">
      <button
        onclick={onOpenImport}
        class="btn btn-primary btn-sm gap-1.5 shadow-sm"
      >
        <span class="w-4 h-4 shrink-0">{@html importIconSvg}</span>
        <span>Import</span>
      </button>

      {#if deckStore.cards.length > 0}
        <button
          onclick={handleLogVerification}
          class="btn btn-outline btn-sm gap-1.5"
          disabled={isLoggingSuccess}
          title="Save this verification checkpoint to permanent local log"
        >
          {#if isLoggingSuccess}
            <span
              class="text-success font-bold text-xs flex items-center gap-1"
            >
              ✓ Logged!
            </span>
          {:else}
            <span class="w-4 h-4 shrink-0">{@html saveLogIconSvg}</span>
            <span class="hidden sm:inline">Save Log</span>
          {/if}
        </button>
      {/if}

      <button
        onclick={onOpenHistory}
        class="btn btn-ghost btn-sm btn-square"
        title="Verification History & Logs"
        aria-label="Verification History"
      >
        <span class="w-5 h-5">{@html clockIconSvg}</span>
      </button>
    </div>
  </div>

  <!-- Progress bar across entire deck -->
  {#if deckStore.cards.length > 0}
    <div class="w-full bg-base-300 h-1.5 overflow-hidden">
      <div
        class="bg-success h-full transition-all duration-300 ease-out"
        style="width: {deckStore.verificationPercentage}%"
      ></div>
    </div>
  {/if}
</header>
