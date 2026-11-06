<script lang="ts">
  import type { ScannedDeckCard } from "../types";
  import { scannerStore } from "../state/scanner.svelte";
  import { getCardImageUrl } from "../api/scryfall";
  import { warningIconSvg, boltIconSvg } from "../icons";

  let { card }: { card: ScannedDeckCard } = $props();

  let copyLimit = $derived(scannerStore.getCopyLimit(card));
  let isOverLimit = $derived(copyLimit !== null && card.count > copyLimit);
  let isBanned = $derived(
    card.scryfall?.legalities?.[scannerStore.format] === "banned"
  );
  let isGameChanger = $derived(
    Boolean(card.scryfall?.game_changer || card.scryfall?.['game-changer'])
  );

  function handleIncrement(e: MouseEvent) {
    e.stopPropagation();
    scannerStore.incrementCard(card.id);
  }

  function handleDecrement(e: MouseEvent) {
    e.stopPropagation();
    scannerStore.removeCard(card.id);
  }

  function handleRemoveAll(e: MouseEvent) {
    e.stopPropagation();
    scannerStore.removeCardAll(card.id);
  }
</script>

<div class="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 hover:bg-base-200/50 transition-colors">
  <!-- Thumbnail -->
  <div class="w-10 h-14 sm:w-12 sm:h-16 rounded-md overflow-hidden bg-neutral-900 shrink-0 border border-base-300">
    {#if getCardImageUrl(card.scryfall)}
      <img
        src={getCardImageUrl(card.scryfall)}
        alt={card.name}
        loading="lazy"
        class="w-full h-full object-cover"
      />
    {:else}
      <div class="w-full h-full p-1 flex items-center justify-center bg-gradient-to-b from-neutral-800 to-neutral-950">
        <span class="text-[9px] font-mono opacity-60">{card.setCode ?? "?"}</span>
      </div>
    {/if}
  </div>

  <!-- Name + badges + type line -->
  <div class="flex-1 min-w-0">
    <div class="flex items-center gap-1.5 flex-wrap">
      <h3 class="font-semibold text-sm truncate">{card.name}</h3>
      {#if isBanned}
        <span class="badge badge-error badge-xs font-bold gap-1 shrink-0" title="Banned in this format">
          <span class="w-3 h-3 shrink-0">{@html warningIconSvg}</span>BANNED
        </span>
      {/if}
      {#if isOverLimit && copyLimit !== null}
        <span class="badge badge-warning badge-xs font-bold shrink-0" title={`Max ${copyLimit} copies of this card`}>
          Max {copyLimit}
        </span>
      {/if}
      {#if isGameChanger && (scannerStore.format === 'commander' || scannerStore.format === 'oathbreaker')}
        <span class="badge badge-warning badge-xs font-bold gap-1 shrink-0" title="Scryfall Game Changer">
          <span class="w-3 h-3 shrink-0 text-neutral-900">{@html boltIconSvg}</span>GC
        </span>
      {/if}
    </div>
    <div class="text-[11px] sm:text-xs text-base-content/50 truncate">
      {card.scryfall?.type_line || "Card"}
    </div>
  </div>

  <!-- Count controls -->
  <div class="flex items-center gap-0.5 sm:gap-1 bg-base-200 rounded-lg p-0.5 border border-base-300 shrink-0">
    <button
      onclick={handleDecrement}
      disabled={card.count <= 0}
      class="btn btn-ghost btn-square w-7 h-7 min-h-0 text-sm disabled:opacity-20 active:scale-90"
      title="Remove one copy"
      aria-label="Remove one copy"
    >
      -
    </button>
    <span class="font-bold text-xs px-1 sm:px-1.5 min-w-[2rem] sm:min-w-[2.5rem] text-center {isOverLimit ? 'text-warning font-extrabold' : 'text-base-content'}">
      ×{card.count}
    </span>
    <button
      onclick={handleIncrement}
      class="btn btn-ghost btn-square w-7 h-7 min-h-0 text-sm active:scale-90"
      title="Add one copy"
      aria-label="Add one copy"
    >
      +
    </button>
    <button
      onclick={handleRemoveAll}
      class="btn btn-ghost btn-square w-7 h-7 min-h-0 text-xs text-error active:scale-90"
      title="Remove all copies"
      aria-label="Remove all copies"
    >
      ✕
    </button>
  </div>
</div>
