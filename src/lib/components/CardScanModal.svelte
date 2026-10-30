<script lang="ts">
  import { deckStore } from "../state/deck.svelte";
  import {
    getCardImageUrl,
    identifyScannedCard,
    lookupCardById,
    matchDeckCard,
  } from "../api/scryfall";
  import { isCardDataReady } from "../data/cardData";
  import { ensureCardHashes } from "../data/cardHashes";
  import {
    NAME_REGION,
    SET_REGION,
    cardZoneForFrame,
    captureFrame,
    initScanner,
    recognizeNameRegion,
    recognizeSetRegion,
  } from "../ocr/cardScanner";
  import { identifyByHash } from "../ocr/hashScanner";
  import { warpCardToCanonical, initOpenCv } from "../ocr/cardWarp";
  import type { DeckCardItem, ScryfallCard } from "../types";
  import {
    cameraIconSvg,
    checkIconSvg,
    warningIconSvg,
    xmarkIconSvg,
  } from "../icons";

  let { isOpen, onClose }: { isOpen: boolean; onClose: () => void } = $props();

  type Phase = "starting" | "live" | "camera_error";

  let phase = $state<Phase>("starting");
  let statusText = $state("Starting camera...");
  let cameraError = $state("");

  let videoEl: HTMLVideoElement | null = $state(null);
  // Reactive on purpose: the attach $effect below must re-run both when the
  // stream arrives (first open) and when the <video> element remounts (retry).
  let stream = $state<MediaStream | null>(null);
  let videoAspect = $state(4 / 3);

  // Continuous mode captures a short burst of frames back-to-back — voting across
  // the burst keeps hash hits reliable against a single noisy/blank frame.
  const BURST_FRAMES = 3;
  const BURST_INTERVAL_MS = 150;

  // Bumped on every scan and on close so in-flight async work bails out
  let scanToken = 0;

  // --- Continuous mode ------------------------------------------------------
  // Pacing between attempts — tesseract itself is the bottleneck, this is just
  // the idle gap before the next frame is grabbed.
  const CONTINUOUS_PACING_MS = 700;
  // A found card stays suppressed while it sits in frame: for at most this long,
  // or until a couple of attempts read nothing (i.e. the card moved away).
  const HIT_COOLDOWN_MS = 8000;
  const REARM_AFTER_MISSES = 2;

  // How a continuous hit was identified — surfaced as a note in the confirm modal.
  type DetectMethod = "hash" | "collector" | "name";

  // Continuous mode: a card was identified and is awaiting the user's decision.
  // The camera keeps running behind it — if a different card is found, this is
  // replaced automatically (the old modal goes away on its own).
  interface PendingHit {
    key: string;
    card: ScryfallCard;
    deckCard: DeckCardItem | null;
    method: DetectMethod;
  }
  let pendingHit = $state<PendingHit | null>(null);
  // True while a continuous attempt is OCR-ing / looking up (drives the status)
  let continuousBusy = $state(false);

  // --- Auto-action for the confirm prompt ----------------------------------
  // A found card resolves itself after this long: in-deck cards are added,
  // not-in-deck cards are dismissed — unless the user taps Add/Decline (or taps
  // outside) first. The bar under the prompt counts down to that moment.
  const AUTO_ACTION_MS = 5000;
  let autoProgress = $state(0); // 0..1, drives the countdown bar width
  let autoStartedAt = 0; // wall-clock start of the current countdown
  let autoRaf = 0; // active requestAnimationFrame id (0 = none)

  // Dedup bookkeeping (plain lets — internal, never rendered)
  let lastHitKey = "";
  let lastHitAt = 0;
  let missesSinceHit = 0;

  // The on-screen card zone — always a true MTG-card (5:7) rectangle, recomputed
  // from the camera aspect so the dashed guide is exactly card-shaped. It mirrors
  // cardZoneForFrame() in cardScanner.ts (which the OCR crops use), so the overlays
  // line up exactly with what the scanner reads.
  const cardZone = $derived(cardZoneForFrame(videoAspect));
  // Map card-zone-relative region fractions onto full-frame fractions for the guide.
  const zoneX = (r: number) => cardZone.x0 + r * (cardZone.x1 - cardZone.x0);
  const zoneY = (r: number) => cardZone.y0 + r * (cardZone.y1 - cardZone.y0);
  const zoneW = (r: number) => r * (cardZone.x1 - cardZone.x0);
  const zoneH = (r: number) => r * (cardZone.y1 - cardZone.y0);

  // --- Camera lifecycle -------------------------------------------------

  $effect(() => {
    if (!isOpen) return;

    cameraError = "";
    pendingHit = null;
    openCamera();

    // Warm up the OCR engine + OpenCV in the background so the first scan is snappy
    void initScanner().catch((err) =>
      console.warn("OCR engine failed to initialize:", err),
    );
    void initOpenCv().catch((err) =>
      console.warn("OpenCV failed to initialize:", err),
    );
    void ensureCardHashes(); // warm the pHash index so the first scan can use it

    return () => {
      scanToken++;
      stopStream();
      stopAutoAction();
      pendingHit = null;
    };
  });

  // Re-attach a running stream whenever the <video> element or the stream changes.
  // The video stays mounted while the modal is open, so after a Retry produces a
  // fresh stream this wires it up (and plays) without remounting the element.
  $effect(() => {
    const el = videoEl;
    const s = stream;
    if (el && s && el.srcObject !== s) {
      el.srcObject = s;
      void el.play().catch(() => {});
    }
  });

  // Continuous mode: while the camera is live, attempts run back-to-back —
  // capture one frame, OCR the set-code corner, and only if that doesn't
  // resolve, OCR the name bar, then look the card up on Scryfall. Tesseract
  // paces the loop; no two attempts ever overlap. Leaving the effect (close, or
  // phase change) bumps scanToken so an in-flight attempt
  // discards its result instead of firing a stale toast.
  $effect(() => {
    const active = isOpen && phase === "live";
    if (!active) return;

    continuousBusy = false;
    let cancelled = false;
    void (async () => {
      while (!cancelled) {
        await continuousAttempt();
        if (cancelled) return;
        await sleep(CONTINUOUS_PACING_MS);
      }
    })();

    return () => {
      cancelled = true;
      scanToken++;
      continuousBusy = false;
    };
  });

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** One continuous-mode attempt: a short burst of frames, lazy OCR (corner first, name bar only if needed). */
  async function continuousAttempt() {
    const token = scanToken;
    if (!videoEl || phase !== "live") return;
    continuousBusy = true;

    try {
      // A short burst instead of a single frame — one noisy or blank frame must
      // not be able to trigger an accidental hash hit on its own.
      const frames: HTMLCanvasElement[] = [];
      for (let i = 0; i < BURST_FRAMES; i++) {
        frames.push(captureFrame(videoEl));
        if (i < BURST_FRAMES - 1) await nextFrame();
      }

      // Localize + perspective-warp each frame to a canonical upright 5:7 card.
      // Both channels prefer the warped frames when OpenCV found the card in a
      // consensus of them; otherwise they fall back to the raw frames so the
      // existing manual-align path keeps working unchanged.
      const minVotes = Math.ceil(BURST_FRAMES / 2);
      const warped = await warpFrames(frames);
      const scanFrames = warped.length >= minVotes ? warped : frames;

      // Fastest channel first — pHash against the local index (offline, ~ms).
      // Require consensus: the same card must win at least half the burst frames,
      // so a single noisy/blank frame can't force an acceptance. Only when it
      // finds nothing do we spend tesseract time on OCR.
      const hashResult =
        scanFrames.length >= 2
          ? await hashChannel(scanFrames, token, minVotes)
          : { card: null };
      if (token !== scanToken) return;
      if (hashResult.card) {
        handleContinuousHit(hashResult.card, "hash");
        return;
      }

      // Fast path — bottom-left corner only (small crop, fast)
      const setRead = await recognizeSetRegion(scanFrames[0]);
      if (token !== scanToken) return;

      let card: ScryfallCard | null = null;
      let detectMethod: DetectMethod = "name";
      // The parsed corner is validated against the local printings map inside
      // identifyScannedCard — free, no API call for unknown pairs — so a parse
      // is worth passing through on every attempt. Without the database loaded,
      // keep the old tesseract-confidence gate (the network lookup isn't free).
      if (setRead.parsed && (isCardDataReady() || setRead.confidence >= 60)) {
        const byCollector = await identifyScannedCard({
          setCode: setRead.parsed.setCode,
          collectorNumber: setRead.parsed.collectorNumber,
        });
        if (token !== scanToken) return;
        if (byCollector) {
          card = byCollector;
          detectMethod = "collector";
        }
      }

      // Fallback — name bar (older cards without a printed set code, or a corner
      // read that didn't resolve to a printing). Set info is passed along so the
      // lookup can still do an in-set search.
      if (!card) {
        const nameRead = await recognizeNameRegion(scanFrames[0]);
        if (token !== scanToken) return;
        card = await identifyScannedCard({
          name: nameRead.name,
          setCode: setRead.parsed?.setCode,
          collectorNumber: setRead.parsed?.collectorNumber,
        });
      }

      if (token !== scanToken) return;
      if (card) {
        handleContinuousHit(card, detectMethod);
      } else {
        noteContinuousMiss();
      }
    } catch (err) {
      console.warn("Continuous scan attempt failed:", err);
      noteContinuousMiss();
    } finally {
      if (token === scanToken) continuousBusy = false;
    }
  }

  /** A couple of empty reads in a row means the card left the frame — re-arm the dedup. */
  function noteContinuousMiss() {
    if (lastHitKey) {
      missesSinceHit++;
      if (missesSinceHit >= REARM_AFTER_MISSES) lastHitKey = "";
    }
  }

  /** Human-readable note for how a continuous hit was detected. */
  function detectMethodLabel(method: DetectMethod): string {
    switch (method) {
      case "hash":
        return "Detected via image";
      case "collector":
        return "Detected via collector info";
      case "name":
        return "Detected via name";
    }
  }

  /** A card was identified in continuous mode: dedup, then pop the confirm modal. */
  function handleContinuousHit(card: ScryfallCard, method: DetectMethod) {
    const key = card.id || `${card.name}|${card.set ?? ""}`;
    const now = Date.now();
    if (key === lastHitKey && now - lastHitAt < HIT_COOLDOWN_MS) return;
    lastHitKey = key;
    lastHitAt = now;
    missesSinceHit = 0;

    // A confirmation is already up for this exact card — keep showing it
    if (pendingHit?.key === key) return;

    // A different card was found: replace the pending confirmation (if any),
    // which dismisses the previous modal automatically.
    const deckCard = matchDeckCard(deckStore.cards, card) ?? null;
    pendingHit = { key, card, deckCard, method };
    startAutoAction();
    buzz(80);
  }

  /** User confirmed the capture: mark one copy as found (undoable via toast). */
  function confirmPendingHit() {
    const hit = pendingHit;
    if (!hit?.deckCard) return;
    deckStore.recordCameraScan(hit.deckCard.id);
    dismissPendingHit(hit.key);
    buzz(120);
  }

  /** User declined: dismiss the modal without marking anything. */
  function declinePendingHit() {
    const hit = pendingHit;
    if (!hit) return;
    dismissPendingHit(hit.key);
    buzz([40, 60]);
  }

  function dismissPendingHit(key: string) {
    stopAutoAction();
    autoProgress = 0;
    pendingHit = null;
    // Restart the cooldown so a card we just decided on doesn't re-prompt immediately
    lastHitKey = key;
    lastHitAt = Date.now();
  }

  /** Begin the auto-action countdown for the current pending hit. */
  function startAutoAction() {
    stopAutoAction();
    autoStartedAt = Date.now();
    autoProgress = 0;
    const tick = () => {
      if (!pendingHit) return; // dismissed while waiting
      const p = Math.min(1, (Date.now() - autoStartedAt) / AUTO_ACTION_MS);
      autoProgress = p;
      if (p >= 1) {
        runAutoAction();
        return; // countdown complete — stop the loop
      }
      autoRaf = requestAnimationFrame(tick);
    };
    autoRaf = requestAnimationFrame(tick);
  }

  /** Stop any running countdown without acting. */
  function stopAutoAction() {
    if (autoRaf) {
      cancelAnimationFrame(autoRaf);
      autoRaf = 0;
    }
  }

  /** The action the countdown resolves to: add in-deck cards, dismiss the rest. */
  function runAutoAction() {
    const hit = pendingHit;
    if (!hit) return;
    if (hit.deckCard) confirmPendingHit();
    else declinePendingHit();
  }

  function buzz(pattern: number | number[]) {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      // Haptics unsupported — ignore
    }
  }

  async function openCamera() {
    const token = ++scanToken;
    phase = "starting";
    statusText = "Starting camera...";

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("unsupported");
      }
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
      });

      if (token !== scanToken) {
        // Modal was closed while the permission prompt was open
        s.getTracks().forEach((t) => t.stop());
        return;
      }

      stream = s; // the attach $effect wires it to the <video> element
      phase = "live";
    } catch (err) {
      if (token !== scanToken) return;
      cameraError = friendlyCameraError(err);
      phase = "camera_error";
    }
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (videoEl) videoEl.srcObject = null;
  }

  function friendlyCameraError(err: unknown): string {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "Camera access was denied. Allow camera permission for this site, then try again.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No camera was found on this device.";
    }
    if (name === "NotReadableError") {
      return "The camera is busy in another app. Close it and try again.";
    }
    if (name === "OverconstrainedError") {
      return "This camera does not support the requested settings. Try again or use a different device.";
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return "This browser does not support camera access.";
    }
    return "Could not start the camera. Please try again.";
  }

  // --- Capture -------------------------------------------------------------

  function nextFrame(): Promise<void> {
    return new Promise((r) => setTimeout(r, BURST_INTERVAL_MS));
  }

  // --- Scan pipeline ------------------------------------------------------

  /** Result of the image-hash identification channel. */
  interface ChannelResult {
    card: ScryfallCard | null;
  }

  /** Warps each frame to a canonical card; returns only the frames where OpenCV found one. */
  async function warpFrames(
    frames: HTMLCanvasElement[],
  ): Promise<HTMLCanvasElement[]> {
    const out: HTMLCanvasElement[] = [];
    for (const f of frames) {
      const w = await warpCardToCanonical(f);
      if (w) out.push(w);
    }
    return out;
  }

  /**
   * Hash channel — pHash of the art region matched against the local index.
   * Offline and fast (typically well under 100 ms); resolves a null card when
   * nothing matches closely enough so the OCR channel can take over. `minVotes`
   * requires the winning card to have matched at least that many of the input
   * frames before it's accepted (continuous mode passes half the burst to guard
   * against a single noisy/blank frame forcing an accidental hit).
   */
  async function hashChannel(
    frames: HTMLCanvasElement[],
    token: number,
    minVotes = 1,
  ): Promise<ChannelResult> {
    try {
      const match = await identifyByHash(
        frames,
        frames[0].width / frames[0].height,
      );
      if (!match || match.votes < minVotes) return { card: null };
      const card = await lookupCardById(match.entry.id);
      if (token !== scanToken) return { card: null };
      return { card };
    } catch (err) {
      console.warn("Hash identification failed:", err);
      return { card: null };
    }
  }

  function handleClose() {
    scanToken++;
    onClose();
  }

  function handleVideoMetadata() {
    if (videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      videoAspect = videoEl.videoWidth / videoEl.videoHeight;
    }
  }
</script>

{#if isOpen}
  <div class="fixed inset-0 z-50 bg-black flex flex-col">
    <!-- Top bar -->
    <div
      class="flex items-center justify-between px-2 sm:px-4 py-2.5 text-white/90 shrink-0"
    >
      <button
        onclick={handleClose}
        class="btn btn-circle btn-ghost btn-sm text-white/70 hover:text-white"
        aria-label="Close scanner"
      >
        ✕
      </button>
      <div class="flex items-center gap-2">
        <span class="w-4 h-4">{@html cameraIconSvg}</span>
        <h2 class="font-bold text-sm sm:text-base">Scan a Card</h2>
      </div>
      <span class="w-6"></span>
    </div>

    <!-- Camera view -->
    <div
      class="flex-1 min-h-0 flex items-center justify-center px-2 sm:px-4 pb-2"
    >
      <div
        class="relative max-w-full"
        style="aspect-ratio: {videoAspect}; height: 100%;"
      >
        <video
          bind:this={videoEl}
          autoplay
          playsinline
          muted
          onloadedmetadata={handleVideoMetadata}
          class="w-full h-full object-fill rounded-xl bg-black"
        ></video>

        <!-- Framing guide (mirrors the OCR crop regions) -->
        {#if phase === "live"}
          <div class="absolute inset-0 pointer-events-none">
            <div
              class="absolute rounded-lg border-2 border-dashed border-white/40"
              style="left: {cardZone.x0 * 100}%; top: {cardZone.y0 *
                100}%; width: {(cardZone.x1 - cardZone.x0) *
                100}%; height: {(cardZone.y1 - cardZone.y0) * 100}%;"
            ></div>
            <div
              class="absolute rounded-md border border-primary/70 bg-primary/10"
              style="left: {zoneX(NAME_REGION.x0) * 100}%; top: {zoneY(
                NAME_REGION.y0,
              ) * 100}%; width: {zoneW(NAME_REGION.x1 - NAME_REGION.x0) *
                100}%; height: {zoneH(NAME_REGION.y1 - NAME_REGION.y0) * 100}%;"
            >
              <span
                class="absolute left-1 top-0.5 text-[9px] font-medium text-white/70 bg-black/40 rounded px-1"
                >card name</span
              >
            </div>
            <div
              class="absolute rounded-md border border-primary/70 bg-primary/10"
              style="left: {zoneX(SET_REGION.x0) * 100}%; top: {zoneY(
                SET_REGION.y0,
              ) * 100}%; width: {zoneW(SET_REGION.x1 - SET_REGION.x0) *
                100}%; height: {zoneH(SET_REGION.y1 - SET_REGION.y0) * 100}%;"
            >
              <span
                class="absolute left-1 top-0.5 text-[9px] font-medium text-white/70 bg-black/40 rounded px-1"
                >set code & #</span
              >
            </div>
          </div>
        {/if}

        <!-- Continuous mode: confirm a found card (camera keeps running behind it) -->
        {#if pendingHit}
          <!-- Backdrop: tapping anywhere outside the prompt cancels / dismisses it -->
          <div
            class="absolute inset-0 z-10"
            role="presentation"
            onclick={declinePendingHit}
          ></div>

          <div
            class="absolute inset-x-0 bottom-2 z-20 flex justify-center px-2 pointer-events-none"
          >
            {#key pendingHit.key}
              <div
                role="dialog"
                aria-label="Confirm scanned card"
                class="animate-toast-in pointer-events-auto w-full max-w-sm bg-base-100 rounded-2xl border border-base-300 shadow-2xl p-3.5 sm:p-4"
              >
                <div class="flex gap-3 items-start">
                  <img
                    src={getCardImageUrl(pendingHit.card)}
                    alt={pendingHit.card.name}
                    class="w-14 h-auto rounded-md border border-base-300 shadow-sm shrink-0"
                  />
                  <div class="min-w-0 flex-1">
                    <h3 class="font-bold text-sm leading-snug">
                      {pendingHit.card.name}
                    </h3>
                    <p class="text-[11px] text-base-content/60 mt-0.5 truncate">
                      {pendingHit.card.type_line || "Card"}
                    </p>
                    <p class="text-[10px] text-base-content/40 mt-0.5">
                      {detectMethodLabel(pendingHit.method)}
                    </p>
                  </div>
                </div>

                {#if pendingHit.deckCard}
                  {#if pendingHit.deckCard.verifiedCount >= pendingHit.deckCard.targetCount}
                    <div
                      class="mt-2.5 flex items-center gap-2 text-xs bg-warning/15 border border-warning/40 text-warning rounded-lg px-2.5 py-1.5"
                    >
                      <span class="w-3.5 h-3.5 shrink-0 text-warning"
                        >{@html warningIconSvg}</span
                      >
                      In your deck — already found {pendingHit.deckCard
                        .verifiedCount} of {pendingHit.deckCard.targetCount} (adding
                      will exceed target)
                    </div>
                  {:else}
                    <div
                      class="mt-2.5 flex items-center gap-2 text-xs bg-success/10 border border-success/30 text-success rounded-lg px-2.5 py-1.5"
                    >
                      <span class="w-3.5 h-3.5 shrink-0"
                        >{@html checkIconSvg}</span
                      >
                      In your deck — {pendingHit.deckCard.verifiedCount} of {pendingHit
                        .deckCard.targetCount} found so far
                    </div>
                  {/if}
                {:else}
                  <div
                    class="mt-2.5 flex items-center gap-2 text-xs bg-warning/10 border border-warning/30 rounded-lg px-2.5 py-1.5"
                  >
                    <span class="w-3.5 h-3.5 shrink-0"
                      >{@html warningIconSvg}</span
                    >
                    Not in your deck — nothing to mark
                  </div>
                {/if}

                <div class="mt-3 flex gap-2">
                  {#if pendingHit.deckCard}
                    <button
                      onclick={confirmPendingHit}
                      title="Mark one copy as found"
                      class="btn btn-primary btn-sm flex-1 gap-1.5"
                    >
                      <span class="w-3.5 h-3.5 shrink-0"
                        >{@html checkIconSvg}</span
                      >
                      Add
                    </button>
                  {/if}
                  <button
                    onclick={declinePendingHit}
                    class="btn btn-outline btn-sm flex-1 gap-1.5"
                  >
                    <span class="w-3.5 h-3.5 shrink-0"
                      >{@html xmarkIconSvg}</span
                    >
                    Decline
                  </button>
                </div>

                <!-- Countdown: resolves the prompt automatically after a few seconds -->
                <div class="mt-3">
                  <p class="mb-1 text-[10px] text-base-content/50">
                    {pendingHit.deckCard
                      ? "Adding automatically…"
                      : "Dismissing automatically…"}
                  </p>
                  <div
                    class="h-1.5 w-full overflow-hidden rounded-full bg-base-200"
                  >
                    <div
                      class="h-full rounded-full {pendingHit.deckCard
                        ? 'bg-success'
                        : 'bg-warning'}"
                      style="width: {autoProgress * 100}%"
                    ></div>
                  </div>
                </div>
              </div>
            {/key}
          </div>
        {/if}

        <!-- Starting overlay -->
        {#if phase === "starting"}
          <div
            class="absolute inset-0 rounded-xl bg-black flex flex-col items-center justify-center gap-3"
          >
            <div
              class="w-10 h-10 rounded-full border-[3px] border-white/60 border-t-transparent animate-spin"
            ></div>
            <p class="text-sm text-white/70">{statusText}</p>
          </div>
        {/if}
      </div>
    </div>

    <!-- Bottom controls -->
    <div class="shrink-0 px-4 pt-2 pb-[max(env(safe-area-inset-bottom),12px)]">
      {#if phase === "live"}
        <div class="flex flex-col items-center gap-3">
          <!-- The scanner works on its own; this is just a live status -->
          <div class="h-24 flex items-center justify-center">
            <div
              class="flex flex-col items-center gap-2"
              title="Scanning automatically — no tap needed"
            >
              <span
                class="w-16 h-16 rounded-full border-4 border-success/70 bg-success/15 flex items-center justify-center"
              >
                <span class="w-3.5 h-3.5 rounded-full bg-success animate-pulse"
                ></span>
              </span>
              <span class="text-[10px] text-white/60"
                >{continuousBusy ? "Reading card…" : "Scanning"}</span
              >
            </div>
          </div>

          <p class="text-center text-[11px] text-white/40 leading-snug">
            Hold a card inside the frame — you'll get a prompt to add or decline
            it.
          </p>
        </div>
      {:else if phase === "camera_error"}
        <div
          class="flex flex-col items-center gap-3 text-white/80 py-4 px-6 text-center"
        >
          <p class="text-sm">{cameraError}</p>
          <div class="flex gap-2">
            <button onclick={openCamera} class="btn btn-primary btn-sm"
              >Retry</button
            >
            <button
              onclick={handleClose}
              class="btn btn-ghost btn-sm text-white/70">Close</button
            >
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
