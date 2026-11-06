<script lang="ts">
  import { scannerStore } from "../state/scanner.svelte";
  import ScannerCardItem from "./ScannerCardItem.svelte";
  import { questionCircleIconSvg } from "../icons";
</script>

<div class="space-y-8 pb-16">
  {#if scannerStore.displayedGroups.length === 0 || scannerStore.displayedCards.length === 0}
    <div class="text-center py-16 px-4 bg-base-200/50 rounded-2xl border border-dashed border-base-300">
      <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-base-300 flex items-center justify-center text-base-content/40">
        <span class="w-8 h-8">{@html questionCircleIconSvg}</span>
      </div>
      <h3 class="text-base font-semibold text-base-content">No cards scanned yet</h3>
      <p class="text-xs text-base-content/60 mt-1">Tap the scan button to start adding cards to your deck.</p>
    </div>
  {:else}
    {#each scannerStore.displayedGroups as group, i}
      {#if group.cards.length > 0}
        <section class="space-y-3">
          {#if scannerStore.groupByType}
            <div class="flex items-center justify-between border-b border-base-300 pb-1.5 sm:pb-2">
              <div class="flex items-center gap-1.5 sm:gap-2">
                <h2 class="text-sm sm:text-base md:text-lg font-bold text-base-content tracking-wide uppercase">
                  {group.title}
                </h2>
                <span class="badge badge-xs sm:badge-sm badge-neutral font-mono">
                  {group.cards.reduce((sum, c) => sum + c.count, 0)}
                </span>
              </div>
            </div>
          {/if}

          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-4">
            {#each group.cards as card (card.id)}
              <ScannerCardItem {card} />
            {/each}
          </div>
        </section>
      {/if}
    {/each}
  {/if}
</div>