<script lang="ts">
  import { scannerStore } from "../state/scanner.svelte";
  import ScannerCardItem from "./ScannerCardItem.svelte";
  import ScannerCardListRow from "./ScannerCardListRow.svelte";
  import { questionCircleIconSvg, sortAZIconSvg, gridIconSvg, listIconSvg } from "../icons";
</script>

<div class="space-y-6 pb-16">
  <!-- Toolbar: sort + view toggles (mirrors the Deck Sync FilterBar) -->
  <div class="flex items-center justify-between gap-2 sm:gap-3 -mb-1">
    <span class="text-xs text-base-content/60">
      {scannerStore.displayedCards.length} card{scannerStore.displayedCards.length === 1 ? "" : "s"}
    </span>
    <div class="flex items-center gap-1.5 sm:gap-2">
      <!-- Group By Type vs Flat Alphabetical Toggle -->
      <button
        onclick={() => scannerStore.groupByType = !scannerStore.groupByType}
        class="btn btn-sm {scannerStore.groupByType ? 'btn-neutral' : 'btn-outline'} gap-1 px-2 sm:px-3 shrink-0"
        title={scannerStore.groupByType ? 'Grouped by card type, then alphabetical' : 'Flat alphabetical list (ignoring type)'}
      >
        <span class="w-3.5 h-3.5 shrink-0">{@html sortAZIconSvg}</span>
        <span class="hidden sm:inline">{scannerStore.groupByType ? 'By Type' : 'Flat A-Z'}</span>
      </button>

      <!-- View Switcher (Grid vs List) -->
      <div class="join bg-base-100 rounded-lg border border-base-300 shrink-0">
        <button
          onclick={() => scannerStore.viewMode = 'grid'}
          class="join-item btn btn-sm px-2.5 {scannerStore.viewMode === 'grid' ? 'btn-neutral' : 'btn-ghost'}"
          title="Visual card grid view"
          aria-label="Grid view"
        >
          <span class="w-4 h-4 shrink-0">{@html gridIconSvg}</span>
        </button>
        <button
          onclick={() => scannerStore.viewMode = 'list'}
          class="join-item btn btn-sm px-2.5 {scannerStore.viewMode === 'list' ? 'btn-neutral' : 'btn-ghost'}"
          title="Text-based list view"
          aria-label="List view"
        >
          <span class="w-4 h-4 shrink-0">{@html listIconSvg}</span>
        </button>
      </div>
    </div>
  </div>
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

          {#if scannerStore.viewMode === 'grid'}
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-4">
            {#each group.cards as card (card.id)}
              <ScannerCardItem {card} />
            {/each}
          </div>
          {:else}
            <div class="bg-base-100 rounded-xl border border-base-300 overflow-hidden divide-y divide-base-200 shadow-xs">
              {#each group.cards as card (card.id)}
                <ScannerCardListRow {card} />
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    {/each}
  {/if}
</div>