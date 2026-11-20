import type { Worker as TesseractWorker } from 'tesseract.js';
import { extractCardName, parseSetAndCollector, type SetCodeParse } from './parse';

/**
 * On-device OCR for physical MTG cards, powered by tesseract.js.
 * All engine assets (worker script, wasm core, english traineddata) are bundled
 * in public/tess and served by the app itself — no third-party CDN, works offline
 * once the PWA is installed. Only the final card lookup touches Scryfall.
 */

const TESS_DIR = `${import.meta.env.BASE_URL}tess/`;

let workerPromise: Promise<TesseractWorker> | null = null;

/** Lazily creates (and caches) the shared tesseract worker. OEM 1 = LSTM only. */
export function initScanner(): Promise<TesseractWorker> {
  if (!workerPromise) {
    // Import tesseract.js on first use instead of at module load. It is a heavy
    // wasm dependency; an eager top-level import would put it in the initial
    // page-load graph so Vite pre-bundles it during dev's first request (~90 s).
    // Deferring the import keeps first paint instant — tesseract only loads when
    // a scan actually starts.
    workerPromise = import('tesseract.js')
      .then(({ createWorker }) =>
        createWorker('eng', 1, {
          workerPath: `${TESS_DIR}worker.min.js`,
          corePath: TESS_DIR,
          langPath: TESS_DIR
        })
      )
      .then(async (worker) => {
        // Printed card text is best segmented at ~300 DPI (camera photos carry no DPI metadata)
        await worker.setParameters({ user_defined_dpi: '300' });
        return worker;
      })
      .catch((err) => {
        // Reset so the next attempt can retry (e.g. transient load failure)
        workerPromise = null;
        throw err;
      });
  }
  return workerPromise;
}

/** A rectangle expressed as fractions of its parent area (frame or card zone). */
export interface FrameRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Width / height of a physical MTG card (2.5" x 3.5") — the guide's aspect ratio. */
export const CARD_ASPECT = 2.5 / 3.5;

/**
 * Fraction of each frame dimension kept free around the card zone (the dashed
 * framing guide). A larger value makes the guide smaller, so a card can be held
 * closer — within the phone camera's focus range (~8 in) — instead of filling
 * most of the view. MUST stay in sync with canonicalDst() in cardWarp.ts, which
 * places the warped card at this same margin inside OUT_W×OUT_H so the OCR and
 * pHash crops (fractions of cardZoneForFrame()) land on the actual card pixels.
 */
export const CARD_ZONE_MARGIN = 0.25;

/**
 * The on-screen "card zone": where the user lines up a physical card. It is
 * always a true MTG-card rectangle (CARD_ASPECT), centered in the camera frame
 * and scaled to fill as much of the frame as possible while leaving CARD_ZONE_MARGIN
 * free on every side. Matching a real card's shape means the dashed guide is
 * exactly card-shaped, and the OCR regions below (fractions of this zone) line up
 * with the card's name bar and set-code corner for any camera aspect ratio.
 */
export function cardZoneForFrame(frameAspect: number): FrameRect {
  const margin = CARD_ZONE_MARGIN; // fraction of each frame dimension kept free around the card
  const availW = 1 - 2 * margin;
  const availH = 1 - 2 * margin;
  // Fit a CARD_ASPECT (width/height) rectangle in *pixel* terms inside the
  // available area. Fractions are of the frame's width/height, so they relate
  // through the frame aspect: fw·frameW / (fh·frameH) = CARD_ASPECT
  //   =>  fw = (CARD_ASPECT / frameAspect) · fh.
  const fh = Math.min(availH, (availW * frameAspect) / CARD_ASPECT);
  const fw = (CARD_ASPECT / frameAspect) * fh;
  return { x0: (1 - fw) / 2, y0: (1 - fh) / 2, x1: (1 + fw) / 2, y1: (1 + fh) / 2 };
}



/**
 * Card layout regions as fractions of the card zone (cardZoneForFrame()). The
 * scanner crops these areas; CameraScanModal's framing guide mirrors them so
 * the user knows where to line the card up.
 */
export interface RegionSpec extends FrameRect {
  /** Height (px) the crop is scaled to before OCR — small text needs upscaling */
  targetHeight: number;
}

/** Top name bar of the card (used for older cards without a printed set code). */
export const NAME_REGION: RegionSpec = { x0: 0.02, y0: 0.03, x1: 0.98, y1: 0.12, targetHeight: 380 };

/** Alternate name-bar box for legacy frames whose name sits slightly lower and
 *  larger relative to the card (pre-1995 frame styles). Only tried as a fallback
 *  when the primary read fails — see recognizeNameRegion(). */
const NAME_REGION_LEGACY: RegionSpec = { x0: 0.02, y0: 0.04, x1: 0.98, y1: 0.16, targetHeight: 380 };

/** Bottom-left corner of modern cards: collector number line above the set-code line. */
export const SET_REGION: RegionSpec = { x0: 0.0, y0: 0.77, x1: 0.60, y1: 1.0, targetHeight: 300 };

// --- Canvas pooling ---------------------------------------------------------
// Continuous scanning allocates a capture-sized frame canvas (~1280×960 after
// the capture downscale, ~5 MB) three times every ~700 ms. Reusing a small round-robin pool instead of
// calling document.createElement on every frame avoids GC churn and thermal
// throttle on mobile. The scan loop is strictly sequential (one burst at a time),
// so a pool sized above the burst count is safe to reuse across attempts.
const FRAME_POOL_SIZE = 6; // comfortably > BURST_FRAMES (3)
const framePool: HTMLCanvasElement[] = [];
let framePoolIdx = 0;

function acquireFrameCanvas(): HTMLCanvasElement {
  if (framePool.length < FRAME_POOL_SIZE) {
    framePool.push(document.createElement('canvas'));
  }
  const canvas = framePool[framePoolIdx];
  framePoolIdx = (framePoolIdx + 1) % FRAME_POOL_SIZE;
  return canvas;
}

// Region crops are much smaller and are consumed by an awaited OCR call, so a
// small pool is safe to reuse across the sequential set/name reads.
const REGION_POOL_SIZE = 4;
const regionPool: HTMLCanvasElement[] = [];
let regionPoolIdx = 0;

function acquireRegionCanvas(): HTMLCanvasElement {
  if (regionPool.length < REGION_POOL_SIZE) {
    regionPool.push(document.createElement('canvas'));
  }
  const canvas = regionPool[regionPoolIdx];
  regionPoolIdx = (regionPoolIdx + 1) % REGION_POOL_SIZE;
  return canvas;
}

/** Max capture width (px). OCR + warp work fine at this size; full-resolution
 *  camera frames (~1920 px) just burn memory and readback bandwidth for no
 *  recognition gain. The aspect ratio is preserved, so all fraction-based region
 *  math (cardZoneForFrame etc.) is unaffected. */
const MAX_CAPTURE_WIDTH = 1280;

/** Grabs the current camera frame as a canvas, downscaled to at most MAX_CAPTURE_WIDTH wide. */
export function captureFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = acquireFrameCanvas();
  let w = video.videoWidth;
  let h = video.videoHeight;
  if (w > MAX_CAPTURE_WIDTH) {
    const scale = MAX_CAPTURE_WIDTH / w;
    w = MAX_CAPTURE_WIDTH;
    h = Math.max(1, Math.round(h * scale));
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, 0, 0, w, h);
  return canvas;
}

/**
 * Crops a region out of a full frame and prepares it for OCR:
 * upscaled to the target height, grayscale, contrast-stretched.
 * The region is expressed relative to cardZoneForFrame(), so it is mapped onto
 * full frame first.
 */
function preprocessRegion(frame: HTMLCanvasElement, region: RegionSpec): HTMLCanvasElement {
  // Follow the on-screen card zone — a true 5:7 card rectangle for this frame's
  // aspect (see cardZoneForFrame) — so the crop matches where the user lines the
  // card up against the dashed guide.
  const zone = cardZoneForFrame(frame.width / frame.height);
  const fx0 = zone.x0 + region.x0 * (zone.x1 - zone.x0);
  const fy0 = zone.y0 + region.y0 * (zone.y1 - zone.y0);
  const fx1 = zone.x0 + region.x1 * (zone.x1 - zone.x0);
  const fy1 = zone.y0 + region.y1 * (zone.y1 - zone.y0);

  const sx = frame.width * fx0;
  const sy = frame.height * fy0;
  const sw = frame.width * (fx1 - fx0);
  const sh = frame.height * (fy1 - fy0);

  const scale = region.targetHeight / Math.max(1, sh);
  const w = Math.max(8, Math.round(sw * scale));
  const h = region.targetHeight;

  const canvas = acquireRegionCanvas();
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, w, h);

  // Grayscale + percentile contrast stretch (robust to photo outliers — a single
  // highlight pixel would wreck a min/max stretch) to boost small printed text
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }

  // Illumination normalization: divide out a smooth background estimate so broad
  // lighting gradients and large specular glare patches stop dominating the crop.
  // The percentile stretch below then operates on reflectance-like values, which
  // is what keeps small printed text legible under uneven light or glare.
  const norm = normalizeIllumination(gray, w, h);

  // Clip the bottom/top 1% of the histogram, then stretch the rest to [20, 235]
  const hist = new Uint32Array(256);
  for (let p = 0; p < norm.length; p++) hist[norm[p]]++;
  const total = norm.length;
  let lo = 0;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * 0.01) {
      lo = v;
      break;
    }
  }
  let hi = 255;
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= total * 0.01) {
      hi = v;
      break;
    }
  }
  const range = Math.max(1, hi - lo);
  for (let p = 0, i = 0; p < norm.length; p++, i += 4) {
    let l = 20 + ((norm[p] - lo) / range) * 215;
    if (l < 20) l = 20;
    else if (l > 235) l = 235;
    d[i] = d[i + 1] = d[i + 2] = l;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Divides out a smooth illumination estimate from a grayscale buffer. The
 * background is estimated by block-averaging the luma onto a coarse grid, box
 * blurring it heavily, and bilinearly resampling back to full size — O(n) work
 * that runs in a few ms even for ~1 MP region crops. Pixels whose background
 * estimate is near black (out-of-card corners, deep shadows) are left untouched
 * so the division doesn't amplify noise there; bright backgrounds (glare) are
 * pulled down and dark ones (low light) lifted toward a mid baseline.
 */
function normalizeIllumination(
  gray: Uint8ClampedArray,
  w: number,
  h: number
): Uint8ClampedArray {
  const gw = 32;
  const gh = Math.max(4, Math.round((h / w) * gw));

  // 1. Block-average the luma onto the coarse grid (background estimate seed).
  const bg = new Float64Array(gw * gh);
  const counts = new Float64Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, ((y * gh) / h) | 0);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, ((x * gw) / w) | 0);
      const gi = gy * gw + gx;
      bg[gi] += gray[row + x];
      counts[gi]++;
    }
  }
  for (let i = 0; i < bg.length; i++) bg[i] = counts[i] > 0 ? bg[i] / counts[i] : 128;

  // 2. Heavy box blur (two separable passes) so each cell reflects its
  //    neighborhood — this is what makes the estimate smooth.
  const radius = Math.max(2, gw >> 2);
  boxBlurGrid(bg, gw, gh, radius);
  boxBlurGrid(bg, gw, gh, radius);

  // 3. Bilinear resample back to full size and divide (gain capped at ×3).
  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < h; y++) {
    const fy = ((y + 0.5) / h) * gh - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = ((x + 0.5) / w) * gw - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const b =
        (bg[y0 * gw + x0] * (1 - tx) + bg[y0 * gw + x1] * tx) * (1 - ty) +
        (bg[y1 * gw + x0] * (1 - tx) + bg[y1 * gw + x1] * tx) * ty;
      const p = y * w + x;
      // Skip near-black backgrounds: dividing there only amplifies noise.
      out[p] = b > 24 ? gray[p] * Math.min(3, 200 / b) : gray[p];
    }
  }
  return out;
}

/** In-place separable box blur on a gw×gh grid (horizontal + vertical pass),
 *  with edge clamping. `r` is the window radius in cells. */
function boxBlurGrid(g: Float64Array, gw: number, gh: number, r: number): void {
  const tmp = new Float64Array(gw * gh);
  const win = 2 * r + 1;
  for (let y = 0; y < gh; y++) {
    let acc = 0;
    const row = y * gw;
    for (let x = -r; x <= r; x++) acc += g[row + Math.max(0, Math.min(gw - 1, x))];
    for (let x = 0; x < gw; x++) {
      tmp[row + x] = acc / win;
      const addIdx = Math.min(gw - 1, x + r + 1);
      const subIdx = Math.max(0, x - r);
      acc += g[row + addIdx] - g[row + subIdx];
    }
  }
  for (let x = 0; x < gw; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.max(0, Math.min(gh - 1, y)) * gw + x];
    for (let y = 0; y < gh; y++) {
      g[y * gw + x] = acc / win;
      const addIdx = Math.min(gh - 1, y + r + 1);
      const subIdx = Math.max(0, y - r);
      acc += tmp[addIdx * gw + x] - tmp[subIdx * gw + x];
    }
  }
}

export interface RegionRead {
  /** Raw OCR text of the region */
  text: string;
  /** Tesseract mean text confidence for the region (0–100) */
  confidence: number;
}

async function recognizeRegion(frame: HTMLCanvasElement, region: RegionSpec): Promise<RegionRead> {
  const worker = await initScanner();
  const { data } = await worker.recognize(preprocessRegion(frame, region));
  return {
    text: (data.text ?? '').trim(),
    confidence: data.confidence ?? 0
  };
}

/** OCRs the bottom-left corner and parses "<SET CODE> <COLLECTOR NUMBER>" out of it. */
export async function recognizeSetRegion(frame: HTMLCanvasElement): Promise<RegionRead & { parsed: SetCodeParse | null }> {
  const read = await recognizeRegion(frame, SET_REGION);
  return { ...read, parsed: parseSetAndCollector(read.text) };
}

/** OCRs the top name bar and extracts a card-name candidate from it. When the
 *  primary box yields nothing (or very low confidence), retries with the legacy
 *  fallback box for older frame styles before giving up on this channel. */
export async function recognizeNameRegion(frame: HTMLCanvasElement): Promise<RegionRead & { name: string | undefined }> {
  const read = await recognizeRegion(frame, NAME_REGION);
  let name = extractCardName(read.text);
  if (!name || read.confidence < 40) {
    const alt = await recognizeRegion(frame, NAME_REGION_LEGACY);
    const altName = extractCardName(alt.text);
    if (altName && (!name || alt.confidence > read.confidence)) {
      return { text: alt.text, confidence: alt.confidence, name: altName };
    }
  }
  return { text: read.text, confidence: read.confidence, name };
}
