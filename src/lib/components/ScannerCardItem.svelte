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

<div
  class="relative rounded-2xl overflow-hidden shadow-md group transition-all duration-200 select-none border-2 active:scale-[0.98] {isBanned
    ? 'border-error hover:shadow-xl hover:scale-[1.02]'
    : isOverLimit
      ? 'border-warning ring-2 ring-warning/60 shadow-lg shadow-warning/20 hover:shadow-xl hover:scale-[1.02]'
      : 'border-transparent hover:shadow-xl hover:scale-[1.02]'}"
>
  <div class="aspect-[5/7] bg-neutral-900 w-full relative overflow-hidden flex flex-col justify-between">
    {#if getCardImageUrl(card.scryfall)}
      <img
        src={getCardImageUrl(card.scryfall)}
        alt={card.name}
        loading="lazy"
        class="w-full h-full object-cover transition-transform duration-300 pointer-events-none"
      />
    {:else}
      <div class="w-full h-full p-3 sm:p-4 flex flex-col justify-between bg-gradient-to-b from-neutral-800 to-neutral-950 text-neutral-100">
        <div>
          <span class="text-[10px] font-mono opacity-60">{card.setCode ?? "???"}</span>
          <h3 class="font-bold text-sm leading-tight mt-1">{card.name}</h3>
        </div>
        <p class="text-[10px] opacity-50 line-clamp-2">{card.scryfall?.type_line ?? "Unknown"}</p>
      </div>
    {/if}

    <!-- Top badges -->
    <div class="absolute top-1.5 right-1.5 z-10 flex flex-col items-end gap-1">
      {#if isBanned}
        <span
          class="badge badge-error badge-xs font-bold gap-1 ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
          title="Banned in this format"
        >
          <span class="w-3 h-3 shrink-0">{@html warningIconSvg}</span>
          BANNED
        </span>
      {/if}

      {#if isOverLimit && copyLimit !== null}
        <span
          class="badge badge-warning badge-xs font-bold gap-1 ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
          title={`Max ${copyLimit} copies of this card`}
        >
          Max {copyLimit}
        </span>
      {/if}

      {#if isGameChanger && (scannerStore.format === 'commander' || scannerStore.format === 'oathbreaker')}
        <span
          class="badge badge-warning badge-xs font-bold gap-1 ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
          title="Scryfall Game Changer"
        >
          <span class="w-3 h-3 shrink-0 text-neutral-900">{@html boltIconSvg}</span>
          GC
        </span>
      {/if}
    </div>

    <!-- Bottom bar: count controls + name -->
    <div class="absolute bottom-1.5 inset-x-1.5 sm:bottom-2 sm:inset-x-2 z-10 flex flex-col gap-1">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="flex items-center gap-1 bg-black/85 backdrop-blur-md rounded-xl p-0.5 sm:p-1 border border-white/20 shadow-md w-full justify-between"
        onclick={(e) => e.stopPropagation()}
      >
        <button
          onclick={handleDecrement}
          disabled={card.count <= 0}
          class="btn btn-square btn-xs w-7 h-7 sm:w-6 sm:h-6 min-h-0 btn-neutral text-white disabled:opacity-20 active:scale-90"
          title="Remove one copy"
        >
          -
        </button>

        <span class="font-bold text-xs px-1 text-center {isOverLimit ? 'text-warning font-extrabold' : 'text-white'}">
          ×{card.count}
        </span>

        <div class="flex gap-0.5">
          <button
            onclick={handleIncrement}
            class="btn btn-square btn-xs w-7 h-7 sm:w-6 sm:h-6 min-h-0 btn-neutral text-white active:scale-90"
            title="Add one copy"
          >
            +
          </button>
          <button
            onclick={handleRemoveAll}
            class="btn btn-square btn-xs w-7 h-7 sm:w-6 sm:h-6 min-h-0 btn-error text-white active:scale-90"
            title="Remove all copies"
          >
            ✕
          </button>
        </div>
      </div>

      <div
        class="bg-black/75 backdrop-blur-xs px-2 py-0.5 rounded-md text-[10px] sm:text-[11px] font-medium text-white/90 truncate w-full border border-white/10 shadow-xs"
      >
        {card.name}
      </div>
    </div>
  </div>
</div>