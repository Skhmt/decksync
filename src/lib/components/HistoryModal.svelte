<script lang="ts">
  import { onMount } from 'svelte';
  import type { DeckVerificationLog } from '../types';
  import { getAllVerificationLogs, deleteVerificationLog, clearAllLogs } from '../storage/db';
  import { deckStore } from '../state/deck.svelte';
  import { checkIconSvg, clipboardCheckIconSvg } from '../icons';

  let { isOpen, onClose }: { isOpen: boolean; onClose: () => void } = $props();

  let logs = $state<DeckVerificationLog[]>([]);
  let selectedLog = $state<DeckVerificationLog | null>(null);
  let isLoadingLogs = $state(false);
  let copyFeedback = $state('');

  async function loadLogs() {
    isLoadingLogs = true;
    try {
      logs = await getAllVerificationLogs();
      if (logs.length > 0 && !selectedLog) {
        selectedLog = logs[0];
      }
    } finally {
      isLoadingLogs = false;
    }
  }

  $effect(() => {
    if (isOpen) {
      loadLogs();
    }
  });

  async function handleDelete(id: string) {
    await deleteVerificationLog(id);
    logs = logs.filter(l => l.id !== id);
    if (selectedLog?.id === id) {
      selectedLog = logs[0] || null;
    }
  }

  async function handleClearAll() {
    if (confirm('Are you sure you want to delete all verification logs?')) {
      await clearAllLogs();
      logs = [];
      selectedLog = null;
    }
  }

  async function handleRestoreLog(log: DeckVerificationLog) {
    deckStore.format = log.format;
    await deckStore.loadFromText(log.rawPayload, log.deckName);

    if (log.checkedStatus) {
      for (const card of deckStore.cards) {
        // New logs key checked status by section|name (so mainboard/sideboard
        // duplicates don't collide); fall back to bare name for older logs.
        const saved =
          log.checkedStatus[`${card.section}|${card.name}`] ?? log.checkedStatus[card.name];
        if (typeof saved === 'number') {
          // Never restore a negative count
          card.verifiedCount = Math.max(0, saved);
        }
      }
    }
    onClose();
  }

  function handleCopyReport(log: DeckVerificationLog) {
    const dateStr = new Date(log.timestamp).toLocaleString();
    let report = `DeckSync Verification Report\n`;
    report += `Deck: ${log.deckName} (${log.format.toUpperCase()})\n`;
    report += `Timestamp: ${dateStr}\n`;
    report += `Status: ${log.totalVerified}/${log.totalExpected} cards verified\n`;

    if (log.missingCards && log.missingCards.length > 0) {
      report += `\nMissing Cards (${log.missingCards.reduce((s, c) => s + c.count, 0)}):\n`;
      for (const m of log.missingCards) {
        report += `- ${m.count}x ${m.name}\n`;
      }
    } else {
      report += `\nAll cards verified! No missing cards.\n`;
    }

    if (log.extraCards && log.extraCards.length > 0) {
      report += `\nExtra Cards:\n`;
      for (const e of log.extraCards) {
        report += `- ${e.count}x ${e.name}\n`;
      }
    }

    navigator.clipboard.writeText(report);
    copyFeedback = 'Report copied to clipboard!';
    setTimeout(() => { copyFeedback = ''; }, 2500);
  }
</script>

{#if isOpen}
  <div class="modal modal-open z-50 p-2 sm:p-4">
    <div class="modal-box max-w-4xl bg-base-100 border border-base-300 shadow-2xl p-4 sm:p-6 w-full max-h-[92dvh] flex flex-col">
      <!-- Modal Header -->
      <div class="flex items-center justify-between pb-3 border-b border-base-300">
        <div>
          <h3 class="font-bold text-base sm:text-lg text-base-content">Verification History Logs</h3>
          <p class="text-[11px] sm:text-xs text-base-content/60 mt-0.5">
            IndexedDB local records of deck checks, missing cards, and verification results
          </p>
        </div>
        <button
          onclick={onClose}
          class="btn btn-sm btn-circle btn-ghost"
          aria-label="Close modal"
        >
          ✕
        </button>
      </div>

      {#if copyFeedback}
        <div class="alert alert-success text-xs py-2 mt-3 shadow-xs">
          <span>{copyFeedback}</span>
        </div>
      {/if}

      {#if isLoadingLogs}
        <div class="py-12 flex justify-center items-center">
          <span class="loading loading-spinner loading-md text-primary"></span>
        </div>
      {:else if logs.length === 0}
        <div class="text-center py-16 px-4 bg-base-200/50 rounded-2xl border border-dashed border-base-300 mt-4">
          <p class="text-sm font-semibold text-base-content">No verification logs saved yet</p>
          <p class="text-xs text-base-content/60 mt-1">
            Click "Save Log" in the header to record a snapshot of your physical card checklist.
          </p>
        </div>
      {:else}
        <!-- Two Column Layout: Log list on left, detail on right -->
        <div class="grid grid-cols-1 md:grid-cols-12 gap-3 sm:gap-4 mt-3 sm:mt-4 overflow-y-auto">
          <!-- Left: Logs List (5 cols) -->
          <div class="md:col-span-5 space-y-2 max-h-44 sm:max-h-56 md:max-h-96 overflow-y-auto pr-1">
            {#each logs as log (log.id)}
              {@const isSelected = selectedLog?.id === log.id}
              {@const isComplete = log.totalVerified >= log.totalExpected && log.totalExpected > 0}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div
                role="button"
                tabindex="0"
                onclick={() => selectedLog = log}
                class="p-3 rounded-xl border text-left cursor-pointer transition-all {isSelected ? 'bg-primary/10 border-primary shadow-xs' : 'bg-base-200/60 border-base-300 hover:bg-base-200'}"
              >
                <div class="flex items-center justify-between">
                  <h4 class="font-bold text-xs truncate max-w-[180px] text-base-content">
                    {log.deckName}
                  </h4>
                  <span class="badge badge-xs {isComplete ? 'badge-success' : 'badge-warning'}">
                    {log.totalVerified}/{log.totalExpected}
                  </span>
                </div>
                <div class="flex items-center justify-between text-[11px] text-base-content/60 mt-1">
                  <span>{log.format.toUpperCase()}</span>
                  <span>{new Date(log.timestamp).toLocaleDateString()}</span>
                </div>
              </div>
            {/each}
          </div>

          <!-- Right: Selected Log Detail (7 cols) -->
          {#if selectedLog}
            <div class="md:col-span-7 bg-base-200/40 p-4 rounded-xl border border-base-300 flex flex-col justify-between">
              <div class="space-y-4">
                <div>
                  <div class="flex items-center justify-between">
                    <h4 class="font-bold text-base text-base-content">{selectedLog.deckName}</h4>
                    <span class="badge badge-sm badge-neutral">{selectedLog.format.toUpperCase()}</span>
                  </div>
                  <p class="text-xs text-base-content/60 mt-0.5">
                    Verified on {new Date(selectedLog.timestamp).toLocaleString()}
                  </p>
                </div>

                <!-- Stats -->
                <div class="grid grid-cols-2 gap-2 text-center">
                  <div class="bg-base-100 p-2.5 rounded-lg border border-base-300">
                    <div class="text-xs text-base-content/60">Verified Cards</div>
                    <div class="text-base font-bold text-success">
                      {selectedLog.totalVerified} / {selectedLog.totalExpected}
                    </div>
                  </div>
                  <div class="bg-base-100 p-2.5 rounded-lg border border-base-300">
                    <div class="text-xs text-base-content/60">Missing Count</div>
                    <div class="text-base font-bold {selectedLog.missingCards.length > 0 ? 'text-error' : 'text-success'}">
                      {selectedLog.missingCards.reduce((s, c) => s + c.count, 0)}
                    </div>
                  </div>
                </div>

                <!-- Missing Cards List -->
                <div>
                  <h5 class="text-xs font-bold uppercase tracking-wider text-base-content/70 mb-1">
                    Missing Cards ({selectedLog.missingCards.length})
                  </h5>
                  {#if selectedLog.missingCards.length === 0}
                    <div class="text-xs text-success flex items-center gap-1 bg-success/10 p-2 rounded-lg">
                      <span class="w-4 h-4 shrink-0">{@html checkIconSvg}</span>
                      All cards in deck verified! None missing.
                    </div>
                  {:else}
                    <div class="max-h-36 overflow-y-auto space-y-1 bg-base-100 p-2 rounded-lg border border-base-300">
                      {#each selectedLog.missingCards as missing}
                        <div class="text-xs flex items-center justify-between text-error/90 font-medium">
                          <span>{missing.name}</span>
                          <span class="badge badge-xs badge-error">{missing.count} missing</span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>

                <!-- Extra Cards List if any -->
                {#if selectedLog.extraCards && selectedLog.extraCards.length > 0}
                  <div>
                    <h5 class="text-xs font-bold uppercase tracking-wider text-base-content/70 mb-1">
                      Extra Cards ({selectedLog.extraCards.length})
                    </h5>
                    <div class="max-h-24 overflow-y-auto space-y-1 bg-base-100 p-2 rounded-lg border border-base-300">
                      {#each selectedLog.extraCards as extra}
                        <div class="text-xs flex items-center justify-between text-warning font-medium">
                          <span>{extra.name}</span>
                          <span class="badge badge-xs badge-warning">+{extra.count}</span>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>

              <!-- Action buttons for selected log -->
              <div class="pt-4 border-t border-base-300 flex flex-wrap items-center justify-between gap-2 mt-4">
                <button
                  onclick={() => handleDelete(selectedLog!.id)}
                  class="btn btn-xs btn-outline btn-error"
                >
                  Delete Log
                </button>

                <div class="flex items-center gap-2">
                  <button
                    onclick={() => handleCopyReport(selectedLog!)}
                    class="btn btn-xs btn-outline gap-1"
                  >
                    <span class="w-3.5 h-3.5 shrink-0">{@html clipboardCheckIconSvg}</span>
                    Copy Report
                  </button>
                  <button
                    onclick={() => handleRestoreLog(selectedLog!)}
                    class="btn btn-xs btn-primary gap-1"
                  >
                    Restore Session
                  </button>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Modal Footer -->
      <div class="modal-action mt-6 pt-3 border-t border-base-300 flex justify-between items-center">
        {#if logs.length > 0}
          <button onclick={handleClearAll} class="btn btn-xs btn-ghost text-error">
            Clear All History
          </button>
        {:else}
          <div></div>
        {/if}

        <button onclick={onClose} class="btn btn-sm btn-ghost">
          Close
        </button>
      </div>
    </div>
  </div>
{/if}

