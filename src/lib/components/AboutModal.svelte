<script lang="ts">
  import { githubIconSvg } from '../icons';

  let { isOpen, onClose }: { isOpen: boolean; onClose: () => void } = $props();

  interface AppMeta {
    version: string;
    dataPullDate: string | null;
  }

  let meta = $state<AppMeta>({ version: '—', dataPullDate: null });
  let loaded = $state(false);

  async function loadMeta() {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}app-meta.json`);
      if (res.ok) {
        meta = await res.json();
      }
    } catch {
      // keep defaults on failure
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    if (isOpen && !loaded) {
      loadMeta();
    }
  });

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return 'Unknown';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal modal-open z-50 p-2 sm:p-4" onclick={onClose}>
    <div
      class="modal-box max-w-sm bg-base-100 border border-base-300 shadow-2xl p-4 sm:p-6 w-full flex flex-col"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Header -->
      <div class="flex items-center justify-between pb-3 border-b border-base-300">
        <div class="flex items-center gap-2">
          <img
            src={`${import.meta.env.BASE_URL}icon.png`}
            alt="DeckSync"
            class="w-8 h-8 rounded-lg shadow-sm object-contain"
          />
          <h3 class="font-bold text-lg text-base-content">About DeckSync</h3>
        </div>
        <button
          onclick={onClose}
          class="btn btn-sm btn-circle btn-ghost"
          aria-label="Close modal"
        >
          ✕
        </button>
      </div>

      <!-- Body -->
      <div class="mt-4 space-y-3">
        <div class="flex items-center justify-between text-sm">
          <span class="text-base-content/60">Version</span>
          <span class="font-semibold font-mono text-base-content">{meta.version}</span>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-base-content/60">Data Updated</span>
          <span class="font-semibold text-base-content">{formatDate(meta.dataPullDate)}</span>
        </div>
      </div>

      <!-- Footer -->
      <div class="modal-action mt-6 pt-3 border-t border-base-300 flex items-center justify-between">
        <a
          href="https://github.com/Skhmt/decksync"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-sm btn-ghost gap-2"
        >
          <span class="w-4 h-4">{@html githubIconSvg}</span>
          <span>GitHub</span>
        </a>
        <button onclick={onClose} class="btn btn-sm">Close</button>
      </div>
    </div>
  </div>
{/if}
