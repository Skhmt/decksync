<script lang="ts">
  import { onMount } from 'svelte';
  import { deckStore } from '../state/deck.svelte';

  let { stickyTop = 130 }: { stickyTop?: number } = $props();

  // Only useful when cards are grouped by type into multiple sections
  let visible = $derived(
    deckStore.cards.length > 0 &&
      deckStore.groupByType &&
      deckStore.displayedGroups.length >= 2,
  );

  let activeIndex = $state(-1);

  function groupSectionId(index: number): string {
    return `category-${index}`;
  }

  function scrollToGroup(index: number) {
    const el = document.getElementById(groupSectionId(index));
    if (!el) return;
    // Land the section top just below the sticky header + filter bar
    const top = el.getBoundingClientRect().top + window.scrollY - stickyTop;
    window.scrollTo({ top, behavior: 'smooth' });
  }

  let ticking = false;

  function updateActive() {
    ticking = false;
    if (!visible) {
      activeIndex = -1;
      return;
    }
    const groups = deckStore.displayedGroups;
    // A section is "active" once its top has scrolled past the sticky bars
    const threshold = stickyTop + 24;
    let current = 0;
    for (let i = 0; i < groups.length; i++) {
      const el = document.getElementById(groupSectionId(i));
      if (el && el.getBoundingClientRect().top <= threshold) {
        current = i;
      }
    }
    // Snap to the last group when scrolled all the way to the bottom
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      current = groups.length - 1;
    }
    activeIndex = current;
  }

  function handleScroll() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(updateActive);
    }
  }

  onMount(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    updateActive();
    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  });

  // Keep the active highlight in sync when the visible groups change (filter/search)
  $effect(() => {
    if (visible) updateActive();
  });
</script>

{#if visible}
  <aside
    class="hidden xl:block w-36 2xl:w-44 shrink-0 sticky"
    style="top: {stickyTop}px;"
    aria-label="Card categories"
  >
    <nav class="rounded-xl border border-base-300 bg-base-200/90 backdrop-blur-md shadow-sm p-1.5">
      <h2 class="text-[10px] font-bold uppercase tracking-wider text-base-content/50 px-2 pt-1 pb-1.5">
        Categories
      </h2>
      <ul class="space-y-0.5 max-h-[70vh] overflow-y-auto">
        {#each deckStore.displayedGroups as group, i}
          {@const target = group.cards.reduce((sum, c) => sum + (c.targetCount ?? 0), 0)}
          {@const found = group.cards.reduce((sum, c) => sum + (c.verifiedCount ?? 0), 0)}
          {@const verified = group.cards.reduce(
            (sum, c) => sum + Math.min(c.verifiedCount ?? 0, c.targetCount ?? 0),
            0,
          )}
          {@const hasExtra = group.cards.some(c => (c.verifiedCount ?? 0) > (c.targetCount ?? 0))}
          {@const isDone = target > 0 && verified >= target}
          {@const isPartial = !isDone && verified > 0}
          <li>
            <button
              onclick={() => scrollToGroup(i)}
              class="w-full text-left px-2 py-1.5 rounded-lg transition-colors {activeIndex === i
                ? 'bg-primary/15'
                : 'hover:bg-base-300/70'}"
              title={`Jump to ${group.title} (${found}/${target} found)`}
            >
              <span class="flex items-center justify-between gap-2">
                <span
                  class="text-xs font-medium truncate {activeIndex === i ? 'text-primary' : 'text-base-content'}"
                >
                  {group.title}
                </span>
                <span
                  class="text-[10px] font-mono shrink-0 {hasExtra
                    ? 'text-warning font-bold'
                    : isDone
                      ? 'text-success'
                      : isPartial
                        ? 'text-warning'
                        : 'text-base-content/50'}"
                >
                  {found}/{target}
                </span>
              </span>
              <span class="block h-1 mt-1 rounded-full bg-base-300 overflow-hidden">
                <span
                  class="block h-full rounded-full transition-all duration-300 {hasExtra
                    ? 'bg-warning'
                    : isDone
                      ? 'bg-success'
                      : isPartial
                        ? 'bg-warning'
                        : 'bg-primary'}"
                  style="width: {target > 0 ? Math.min(100, (found / target) * 100) : 0}%"
                ></span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  </aside>
{/if}
