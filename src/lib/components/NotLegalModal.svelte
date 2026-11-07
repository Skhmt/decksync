<script lang="ts">
  import type { MTGFormat, ScryfallCard } from '../types';
  import { calendarXmarkIconSvg } from '../icons';

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
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal modal-open z-50 p-2 sm:p-4" onclick={onClose}>
    <div
      class="modal-box max-w-lg bg-base-100 border border-error/30 shadow-2xl p-4 sm:p-6 w-full max-h-[92dvh] flex flex-col"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="flex items-center justify-between pb-3 border-b border-base-300">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-full bg-error text-error-content flex items-center justify-center">
            <span class="w-4.5 h-4.5">{@html calendarXmarkIconSvg}</span>
          </div>
          <div>
            <h3 class="font-bold text-lg text-base-content">Not Legal in This Format</h3>
            <p class="text-xs text-base-content/60">
              Format: <span class="font-semibold text-base-content uppercase">{format}</span>
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
          The following cards can't be played in {format} according to official MTG format rules from Scryfall — typically because their set has rotated out of the format or the set isn't part of the format's pool:
        </p>

        <div class="space-y-1.5 max-h-72 overflow-y-auto mt-2">
          {#each cards as card}
            <div class="flex items-center justify-between p-2.5 bg-error/10 border border-error/20 rounded-xl text-xs">
              <div class="min-w-0">
                <span class="font-bold text-error">{card.name}</span>
                <span class="text-base-content/60 ml-2 truncate inline-block max-w-[180px] align-bottom">({card.scryfall?.type_line || 'Card'})</span>
              </div>
              <span class="badge badge-sm badge-error font-mono shrink-0 ml-2 uppercase">
                Not Legal
              </span>
            </div>
          {/each}
        </div>
      </div>

    </div>
  </div>
{/if}