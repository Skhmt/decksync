<script lang="ts">
  import type { DeckCardItem } from "../types";
  import { deckStore } from "../state/deck.svelte";
  import { getCardImageUrl } from "../api/scryfall";
  import { boltIconSvg, cameraIconSvg, checkIconSvg, flipIconSvg, warningIconSvg } from "../icons";

  let { card }: { card: DeckCardItem } = $props();

  let activeFaceIndex = $state(0);
  let hasFaces = $derived(
    Boolean(card.scryfall?.card_faces && card.scryfall.card_faces.length > 1),
  );

  let hasTooMany = $derived((card.verifiedCount ?? 0) > card.targetCount);
  let isVerified = $derived((card.verifiedCount ?? 0) >= card.targetCount && !hasTooMany);
  let isPartiallyVerified = $derived(
    (card.verifiedCount ?? 0) > 0 && (card.verifiedCount ?? 0) < card.targetCount,
  );
  let isBanned = $derived(
    card.scryfall?.legalities?.[deckStore.format] === "banned",
  );
  let isNotLegal = $derived(
    card.scryfall?.legalities?.[deckStore.format] === "not_legal",
  );
  let copyLimit = $derived(deckStore.getCopyLimit(card));
  let isOverLimit = $derived(
    copyLimit !== null && card.targetCount > copyLimit,
  );
  // Camera captures: flag cards photographed more than once (like multi-copy counters)
  let scanCount = $derived(card.scanCount ?? 0);
  let capturedMultipleTimes = $derived(scanCount > 1);
  let hasLegalityIssue = $derived(
    isBanned || isNotLegal || isOverLimit,
  );

  let notLegalTooltip = $derived(`Card is not legal in ${deckStore.format}`);

  let currentImageUrl = $derived(
    getCardImageUrl(card.scryfall, activeFaceIndex),
  );

  function handleCardClick() {
    deckStore.toggleCard(card.id);
  }

  function handleIncrement(e: MouseEvent) {
    e.stopPropagation();
    deckStore.incrementCard(card.id);
  }

  function handleDecrement(e: MouseEvent) {
    e.stopPropagation();
    deckStore.decrementCard(card.id);
  }

  function handleFlip(e: MouseEvent) {
    e.stopPropagation();
    activeFaceIndex = activeFaceIndex === 0 ? 1 : 0;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  role="button"
  tabindex="0"
  onclick={handleCardClick}
  class="relative rounded-2xl overflow-hidden shadow-md group transition-all duration-200 cursor-pointer select-none border-2 active:scale-[0.98] {hasLegalityIssue
    ? 'border-error hover:shadow-xl hover:scale-[1.02]'
    : hasTooMany
      ? 'border-warning ring-2 ring-warning/60 shadow-lg shadow-warning/20 hover:shadow-xl hover:scale-[1.02]'
      : isVerified
        ? 'border-success/50 card-verified'
        : isPartiallyVerified
          ? 'border-warning'
          : 'border-transparent card-unverified hover:shadow-xl hover:scale-[1.02]'}"
>
  <!-- Card Image or Fallback Container -->
  <div
    class="aspect-[5/7] bg-neutral-900 w-full relative overflow-hidden flex flex-col justify-between"
  >
    {#if currentImageUrl}
      <img
        src={currentImageUrl}
        alt={card.name}
        loading="lazy"
        class="w-full h-full object-cover transition-transform duration-300 pointer-events-none"
      />
    {:else}
      <!-- Fallback when Scryfall image is not available or custom card -->
      <div
        class="w-full h-full p-3 sm:p-4 flex flex-col justify-between bg-gradient-to-b from-neutral-800 to-neutral-950 text-neutral-100"
      >
        <div>
          <span
            class="text-[11px] sm:text-xs font-mono uppercase tracking-wider text-neutral-400"
          >
            {card.scryfall?.type_line || "Card"}
          </span>
          <h3 class="font-bold text-sm sm:text-base mt-1 line-clamp-3">{card.name}</h3>
        </div>
        <div class="text-xs text-neutral-400">
          {card.scryfall?.mana_cost || ""}
        </div>
      </div>
    {/if}

    <!-- Verified Checkmark Giant Overlay when Verified, or Warning when Too Many -->
    {#if hasTooMany}
      <div
        class="absolute inset-0 bg-black/25 flex items-center justify-center pointer-events-none"
      >
        <div
          class="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-warning text-neutral-900 flex items-center justify-center shadow-lg border-2 border-white/60"
          title="Too many cards of this type"
        >
          <span class="w-7 h-7 sm:w-8 sm:h-8">{@html warningIconSvg}</span>
        </div>
      </div>
    {:else if isVerified}
      <div
        class="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none"
      >
        <div
          class="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-success text-success-content flex items-center justify-center shadow-lg border-2 border-white/50"
        >
          <span class="w-7 h-7 sm:w-8 sm:h-8">{@html checkIconSvg}</span>
        </div>
      </div>
    {/if}

    <!-- Light yellow tint overlay when there are too many cards of that type -->
    {#if hasTooMany}
      <div class="absolute inset-0 bg-warning/20 pointer-events-none"></div>
    {/if}

    <!-- Light red tint overlay for cards with legality issues (sits below z-10 badges) -->
    {#if hasLegalityIssue}
      <div class="absolute inset-0 bg-error/20 pointer-events-none"></div>
    {/if}

    <!-- Top Right: Banned / Not Legal / Over Limit & Game Changer Badges & Flip Button -->
    <div class="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 z-10 flex flex-col items-end gap-1 sm:gap-1.5">
      {#if hasTooMany}
        <span
          class="badge badge-warning badge-xs sm:badge-sm font-bold ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)] uppercase tracking-wider text-neutral-900"
          title="Too many cards of this type ({card.verifiedCount} of {card.targetCount})"
        >
          +{card.verifiedCount - card.targetCount} Extra
        </span>
      {/if}

      {#if isBanned}
        <span
          class="badge badge-error badge-xs sm:badge-sm font-bold ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)] uppercase tracking-wider"
        >
          Banned
        </span>
      {/if}

      {#if isNotLegal}
        <span
          class="badge badge-error badge-xs sm:badge-sm font-bold ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)] uppercase tracking-wider"
          title={notLegalTooltip}
        >
          Not Legal
        </span>
      {/if}

      {#if isOverLimit}
        <span
          class="badge badge-error badge-xs sm:badge-sm font-bold ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)] uppercase tracking-wider"
          title="{deckStore.format} allows max {copyLimit} copies of this card"
        >
          Max {copyLimit}
        </span>
      {/if}

      {#if deckStore.isCommander && card.scryfall?.game_changer}
        <span
          class="badge badge-warning badge-xs font-bold gap-1 ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)]"
          title="Scryfall Game Changer"
        >
          <span class="w-3 h-3 shrink-0 text-neutral-900">{@html boltIconSvg}</span>
          GC
        </span>
      {/if}

      {#if capturedMultipleTimes}
        <span
          class="badge badge-warning badge-xs font-bold gap-1 ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)]"
          title={`Captured ${scanCount} times via camera`}
        >
          <span class="w-3 h-3 shrink-0 text-neutral-900">{@html cameraIconSvg}</span>
          ×{scanCount}
        </span>
      {/if}

      {#if hasFaces}
        <button
          onclick={handleFlip}
          class="btn btn-circle btn-xs w-7 h-7 sm:w-6 sm:h-6 min-h-0 bg-black/70 hover:bg-black text-white border-white/30 shadow-md backdrop-blur-xs active:scale-90"
          title="Flip card face"
          aria-label="Flip card face"
        >
          <span class="w-3.5 h-3.5 shrink-0">{@html flipIconSvg}</span>
        </button>
      {/if}
    </div>

    <!-- Bottom Bar: Multi-copy count & +/- buttons above Card Name -->
    <div
      class="absolute bottom-1.5 inset-x-1.5 sm:bottom-2 sm:inset-x-2 z-10 flex flex-col gap-1"
    >
      {#if card.targetCount > 1 || hasTooMany}
        <!-- Multi-copy counter bar above card name -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="flex items-center gap-1 bg-black/85 backdrop-blur-md rounded-xl p-0.5 sm:p-1 border border-white/20 shadow-md w-full justify-between"
          onclick={(e) => e.stopPropagation()}
        >
          <!-- Decrement button -->
          <button
            onclick={handleDecrement}
            disabled={card.verifiedCount <= 0}
            class="btn btn-square btn-xs w-7 h-7 sm:w-6 sm:h-6 min-h-0 btn-neutral text-white disabled:opacity-20 active:scale-90"
            title="Decrement verified count"
            aria-label="Decrement count"
          >
            -
          </button>

          <!-- Count Display: Verified / Target -->
          <span
            class="font-bold text-xs px-1 text-center {hasTooMany
              ? 'text-warning font-extrabold'
              : isVerified
                ? 'text-success'
                : isPartiallyVerified
                  ? 'text-warning'
                  : 'text-white'}"
          >
            {card.verifiedCount} / {card.targetCount}
          </span>

          <!-- Increment button -->
          <button
            onclick={handleIncrement}
            class="btn btn-square btn-xs w-7 h-7 sm:w-6 sm:h-6 min-h-0 btn-neutral text-white active:scale-90"
            title="Increment verified count"
            aria-label="Increment count"
          >
            +
          </button>
        </div>
      {/if}

      <!-- Always show Card Name so users can identify cards -->
      <div
        class="bg-black/75 backdrop-blur-xs px-2 py-0.5 rounded-md text-[10px] sm:text-[11px] font-medium text-white/90 truncate w-full border border-white/10 shadow-xs"
      >
        {card.name}
      </div>
    </div>
  </div>
</div>
