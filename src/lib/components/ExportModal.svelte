<script lang="ts">
  import { scannerStore } from "../state/scanner.svelte";

  let { isOpen, onClose }: { isOpen: boolean; onClose: () => void } = $props();

  let copied = $state(false);
  // When on, append `(SET) number` for cards whose physical printing was detected
  // via image hash or collector-info OCR. Name-only lookups don't reveal the actual
  // printing in hand, so those cards stay plain regardless of this toggle.
  let includeCollectorInfo = $state(false);

  function getExportText(): string {
    return scannerStore.generateExportText(includeCollectorInfo);
  }

  function handleCopy() {
    navigator.clipboard.writeText(getExportText()).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 2000);
    });
  }

  function handleDownload() {
    const blob = new Blob([getExportText()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scannerStore.deckName.replace(/\s+/g, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- Backdrop -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" role="presentation" onclick={onClose}></div>

    <!-- Modal -->
    <div
      role="dialog"
      aria-label="Export deck"
      class="relative w-full max-w-md bg-base-100 rounded-2xl border border-base-300 shadow-2xl p-5 sm:p-6 space-y-4"
    >
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-bold text-base-content">Export Deck</h2>
        <button onclick={onClose} class="btn btn-circle btn-ghost btn-sm text-base-content/60">✕</button>
      </div>

      <!-- Stats -->
      <div class="flex gap-3 text-xs text-base-content/70">
        <span class="badge badge-neutral font-mono">{scannerStore.totalCards} cards</span>
        <span class="badge badge-neutral font-mono">{scannerStore.uniqueCardCount} unique</span>
      </div>

      <!-- Preview -->
      <div class="bg-base-200 rounded-xl p-3 max-h-48 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {getExportText()}
      </div>

      <!-- Collector info toggle -->
      <label class="flex items-start gap-2 text-xs text-base-content/70 cursor-pointer select-none">
        <input type="checkbox" bind:checked={includeCollectorInfo} class="checkbox checkbox-xs mt-0.5" />
        <span>
          Include set &amp; collector number where detected<br /><span class="font-mono">(e.g. War Room (SOC) 422)</span>
        </span>
      </label>

      <!-- Actions -->
      <div class="space-y-2">
        <button onclick={handleCopy} class="btn btn-primary btn-sm w-full gap-2">
          {copied ? "✓ Copied!" : "Copy to Clipboard"}
        </button>

        <button onclick={handleDownload} class="btn btn-outline btn-sm w-full">
          Download .txt
        </button>
      </div>

      <p class="text-[10px] text-base-content/50 text-center">
        Text format is compatible with Archidekt, Moxfield, MTGTop8, and most other deck sites.
      </p>
    </div>
  </div>
{/if}