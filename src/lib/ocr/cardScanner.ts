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
 * The on-screen "card zone": where the user lines up a physical card. It is
 * always a true MTG-card rectangle (CARD_ASPECT), centered in the camera frame
 * and scaled to fill as much of the frame as possible while leaving a small
 * margin. Matching a real card's shape means the dashed guide is exactly
 * card-shaped, and the OCR regions below (fractions of this zone) line up with
 * the card's name bar and set-code corner for any camera aspect ratio.
 */
export function cardZoneForFrame(frameAspect: number): FrameRect {
  const margin = 0.05; // fraction of each frame dimension kept free around the card
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
 * Fixed crop rectangle used by the pHash channel only (see hashScanner.ts). It
 * matches the geometry scripts/prepare-hashes.js used to build
 * public/card-hashes.bin, so the existing index still loads and matches without
 * being regenerated. The OCR regions and the framing guide instead use
 * cardZoneForFrame() — a true 5:7 card rectangle; regenerating the hash index
 * against that zone would align the two channels fully.
 */
export const CARD_ZONE: FrameRect = { x0: 0.18, y0: 0.10, x1: 0.82, y1: 0.90 };

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

/** Bottom-left corner of modern cards: collector number line above the set-code line. */
export const SET_REGION: RegionSpec = { x0: 0.0, y0: 0.77, x1: 0.60, y1: 1.0, targetHeight: 300 };

/** Grabs the current camera frame as a full-resolution canvas. */
export function captureFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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

  const canvas = document.createElement('canvas');
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

  // Clip the bottom/top 1% of the histogram, then stretch the rest to [20, 235]
  const hist = new Uint32Array(256);
  for (let p = 0; p < gray.length; p++) hist[gray[p]]++;
  const total = gray.length;
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
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    let l = 20 + ((gray[p] - lo) / range) * 215;
    if (l < 20) l = 20;
    else if (l > 235) l = 235;
    d[i] = d[i + 1] = d[i + 2] = l;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
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

/** OCRs the top name bar and extracts a card-name candidate from it. */
export async function recognizeNameRegion(frame: HTMLCanvasElement): Promise<RegionRead & { name: string | undefined }> {
  const read = await recognizeRegion(frame, NAME_REGION);
  return { ...read, name: extractCardName(read.text) };
}
