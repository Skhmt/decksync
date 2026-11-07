<script lang="ts">
  import type { MTGFormat, ScryfallCard } from '../types';
  import { boltIconSvg } from '../icons';

  /** A card as shown in a warning modal — works for both deck and scanned cards. */
  interface WarningCard {
    name: string;
    targetCount?: number;
    count?: number;
    scryfall?: ScryfallCard;
  }

  let { isOpen, onClose, cards = [], format }: {
    isOpen: boolean;
    onClose: () => void;
    cards?: WarningCard[];
    format: MTGFormat;
  } = $props();

  const qty = (c: WarningCard) => c.targetCount ?? c.count ?? 1;
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal modal-open z-50 p-2 sm:p-4" onclick={onClose}>
    <div
      class="modal-box max-w-lg bg-base-100 border border-warning/30 shadow-2xl p-4 sm:p-6 w-full max-h-[92dvh] flex flex-col"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="flex items-center justify-between pb-3 border-b border-base-300">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-full bg-warning flex items-center justify-center">
            <span class="w-5 h-5 text-neutral-900">{@html boltIconSvg}</span>
          </div>
          <div>
            <h3 class="font-bold text-lg text-base-content">Game Changers</h3>
            <p class="text-xs text-base-content/60">
              Flagged by Scryfall for <span class="font-semibold text-base-content uppercase">{format}</span>
            </p>
          </div>
        </div>
        <button
          onclick={onClose}
          class="btn btn-sm btn-circle btn-ghost"
          aria-label="Close modal"
        >
          ✕
        </button>
      </div>

      <div class="mt-4 space-y-2">
        <p class="text-xs text-base-content/70">
          The following cards in this deck are flagged as game changers by Scryfall — cards that significantly impact the format:
        </p>

        <div class="space-y-1.5 max-h-72 overflow-y-auto mt-2">
          {#each cards as card}
            <div class="flex items-center justify-between p-2.5 bg-warning/10 border border-warning/20 rounded-xl text-xs">
              <div>
                <span class="font-bold text-base-content">{card.name}</span>
                <span class="text-base-content/60 ml-2">({card.scryfall?.type_line || 'Card'})</span>
              </div>
              <span class="badge badge-sm badge-warning font-mono">
                {qty(card)}x
              </span>
            </div>
          {/each}
        </div>
      </div>

    </div>
  </div>
{/if}