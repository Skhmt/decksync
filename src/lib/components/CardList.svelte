<script lang="ts">
  import { deckStore } from "../state/deck.svelte";
  import type { DeckCardItem } from "../types";
  import { boltIconSvg, cameraIconSvg, checkIconSvg, questionCircleIconSvg, warningIconSvg } from "../icons";

  function handleRowClick(card: DeckCardItem) {
    deckStore.toggleCard(card.id);
  }

  function handleCheckboxClick(e: MouseEvent, card: DeckCardItem) {
    e.stopPropagation();
    if (card.verifiedCount >= card.targetCount || card.verifiedCount > 0) {
      deckStore.unverifyCard(card.id);
    } else {
      deckStore.toggleCard(card.id);
    }
  }

  function handleIncrement(e: MouseEvent, card: DeckCardItem) {
    e.stopPropagation();
    deckStore.incrementCard(card.id);
  }

  function handleDecrement(e: MouseEvent, card: DeckCardItem) {
    e.stopPropagation();
    deckStore.decrementCard(card.id);
  }
</script>

<div class="space-y-6 pb-16">
  {#if deckStore.displayedGroups.length === 0 || deckStore.displayedCards.length === 0}
    <div
      class="text-center py-16 px-4 bg-base-200/50 rounded-2xl border border-dashed border-base-300"
    >
      <div
        class="w-16 h-16 mx-auto mb-4 rounded-full bg-base-300 flex items-center justify-center text-base-content/40"
      >
        <span class="w-8 h-8">{@html questionCircleIconSvg}</span>
      </div>
      <h3 class="text-base font-semibold text-base-content">
        No cards match your filter
      </h3>
      <p class="text-xs text-base-content/60 mt-1">
        Try changing the filter mode or clearing your search term.
      </p>
    </div>
  {:else}
    {#each deckStore.displayedGroups as group, i}
      {#if group.cards.length > 0}
        <section id="category-{i}" class="space-y-2">
          {#if deckStore.groupByType}
            <div
              class="flex items-center justify-between border-b border-base-300 pb-1.5 px-1 sm:px-2"
            >
              <div class="flex items-center gap-1.5 sm:gap-2">
                <h2
                  class="text-xs sm:text-sm font-bold text-base-content tracking-wide uppercase"
                >
                  {group.title}
                </h2>
                <span class="badge badge-xs badge-neutral font-mono">
                  {group.cards.reduce((sum, c) => sum + c.targetCount, 0)}
                </span>
              </div>
              <span class="text-[11px] sm:text-xs text-base-content/60">
                {group.cards.reduce((sum, c) => sum + c.verifiedCount, 0)} / {group.cards.reduce(
                  (sum, c) => sum + c.targetCount,
                  0,
                )}
              </span>
            </div>
          {/if}

          <!-- List container -->
          <div
            class="bg-base-100 rounded-xl border border-base-300 overflow-hidden divide-y divide-base-200 shadow-xs"
          >
            {#each group.cards as card (card.id)}
              {@const hasTooMany = card.verifiedCount > card.targetCount}
              {@const isVerified = card.verifiedCount >= card.targetCount && !hasTooMany}
              {@const isPartiallyVerified =
                card.verifiedCount > 0 && card.verifiedCount < card.targetCount}
              {@const isBanned =
                card.scryfall?.legalities?.[deckStore.format] === "banned"}
              {@const isNotLegal =
                card.scryfall?.legalities?.[deckStore.format] === "not_legal"}
              {@const copyLimit = deckStore.getCopyLimit(card)}
              {@const isOverLimit =
                copyLimit !== null && card.targetCount > copyLimit}
              {@const hasLegalityIssue =
                isBanned || isNotLegal || isOverLimit}

              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div
                role="button"
                tabindex="0"
                onclick={() => handleRowClick(card)}
                class="flex items-center justify-between px-2.5 sm:px-3 py-2 sm:py-2.5 min-h-[48px] transition-colors cursor-pointer select-none active:bg-base-300/40 {hasLegalityIssue
                  ? 'bg-error/10 border-l-4 border-error'
                  : hasTooMany
                    ? 'bg-warning/15 border-l-4 border-warning hover:bg-warning/20'
                    : isVerified
                      ? 'bg-base-200/40 opacity-50 grayscale'
                      : isPartiallyVerified
                        ? 'bg-warning/5 hover:bg-warning/10'
                        : 'hover:bg-base-200/70'}"
              >
                <!-- Left: Checkbox & Name & Badges -->
                <div class="flex items-center gap-2.5 sm:gap-3 min-w-0 pr-2">
                  <!-- Checkbox -->
                  <button
                    onclick={(e) => handleCheckboxClick(e, card)}
                    class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border transition-all active:scale-90 {hasTooMany
                      ? 'bg-warning text-neutral-900 border-warning'
                      : isVerified
                        ? 'bg-success text-success-content border-success'
                        : isPartiallyVerified
                          ? 'bg-warning text-warning-content border-warning'
                          : 'border-base-content/30 hover:border-base-content'}"
                    title={hasTooMany
                      ? `Too many cards (${card.verifiedCount}/${card.targetCount}) - click to clear`
                      : isVerified
                        ? "Un-verify card (set to 0)"
                        : "Verify card"}
                    aria-label="Verify checkbox"
                  >
                    {#if hasTooMany}
                      <span class="w-4 h-4">{@html warningIconSvg}</span>
                    {:else if isVerified}
                      <span class="w-4 h-4">{@html checkIconSvg}</span>
                    {:else if isPartiallyVerified}
                      <span class="text-[10px] font-bold"
                        >{card.verifiedCount}</span
                      >
                    {/if}
                  </button>

                  <!-- Card info -->
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span
                        class="font-medium text-xs sm:text-sm text-base-content truncate {isVerified
                          ? 'line-through text-base-content/60'
                          : ''}"
                      >
                        {card.name}
                      </span>
                      {#if hasTooMany}
                        <span
                          class="badge badge-warning badge-xs font-bold ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)] uppercase text-neutral-900"
                          title={`Too many copies (${card.verifiedCount} of ${card.targetCount})`}
                        >
                          +{card.verifiedCount - card.targetCount} Extra
                        </span>
                      {/if}
                      {#if isBanned}
                        <span
                          class="badge badge-error badge-xs font-bold ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)] uppercase"
                          >Banned</span
                        >
                      {/if}
                      {#if isNotLegal}
                        <span
                          class="badge badge-error badge-xs font-bold ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)] uppercase"
                          title={`Card is not legal in ${deckStore.format}`}
                          >Not Legal</span
                        >
                      {/if}
                      {#if isOverLimit}
                        <span
                          class="badge badge-error badge-xs font-bold ring-1 ring-black/40 shadow-[0_1px_2px_rgba(0,0,0,0.55),0_3px_8px_rgba(0,0,0,0.35)] uppercase"
                          title={`${deckStore.format} allows max ${copyLimit} copies of this card`}
                          >Max {copyLimit}</span
                        >
                      {/if}
                      {#if deckStore.isCommander && card.scryfall?.game_changer}
                        <span
                          class="badge badge-warning badge-xs font-bold gap-1"
                        >
                          <span class="w-3 h-3 shrink-0 text-neutral-900">{@html boltIconSvg}</span>
                          GC
                        </span>
                      {/if}
                      {#if (card.scanCount ?? 0) > 1}
                        <span
                          class="badge badge-warning badge-xs font-bold gap-1"
                          title={`Captured ${card.scanCount} times via camera`}
                        >
                          <span class="w-3 h-3 shrink-0 text-neutral-900">{@html cameraIconSvg}</span>
                          ×{card.scanCount}
                        </span>
                      {/if}
                    </div>
                    <div
                      class="text-[11px] sm:text-xs text-base-content/50 truncate flex items-center gap-1.5 sm:gap-2"
                    >
                      <span class="truncate max-w-[130px] sm:max-w-none">{card.scryfall?.type_line || "Card"}</span>
                      {#if card.scryfall?.mana_cost}
                        <span class="font-mono text-[10px] sm:text-[11px] shrink-0"
                          >{card.scryfall.mana_cost}</span
                        >
                      {/if}
                    </div>
                  </div>
                </div>

                <!-- Right: Counter controls -->
                <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
                  {#if card.targetCount > 1 || hasTooMany}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                      class="flex items-center gap-0.5 sm:gap-1 bg-base-200 rounded-lg p-0.5 border border-base-300"
                      onclick={(e) => e.stopPropagation()}
                    >
                      <button
                        onclick={(e) => handleDecrement(e, card)}
                        disabled={card.verifiedCount <= 0}
                        class="btn btn-ghost btn-square w-7 h-7 min-h-0 text-sm disabled:opacity-20 active:scale-90"
                        title="Decrement count"
                        aria-label="Decrement count"
                      >
                        -
                      </button>
                      <span
                        class="font-bold text-xs px-1 sm:px-1.5 min-w-[2rem] sm:min-w-[2.5rem] text-center {hasTooMany
                          ? 'text-warning font-extrabold'
                          : isVerified
                            ? 'text-success'
                            : isPartiallyVerified
                              ? 'text-warning'
                              : 'text-base-content'}"
                      >
                        {card.verifiedCount}/{card.targetCount}
                      </span>
                      <button
                        onclick={(e) => handleIncrement(e, card)}
                        class="btn btn-ghost btn-square w-7 h-7 min-h-0 text-sm active:scale-90"
                        title="Increment count"
                        aria-label="Increment count"
                      >
                        +
                      </button>
                    </div>
                  {:else}
                    <div
                      class="px-2 py-1 rounded text-xs font-mono font-medium {isVerified
                        ? 'bg-success/20 text-success'
                        : 'bg-base-200 text-base-content/60'}"
                    >
                      {card.verifiedCount} / 1
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/each}
  {/if}
</div>
