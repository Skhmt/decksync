import { CARD_ASPECT } from './cardScanner';

/**
 * On-device card localization + perspective correction via OpenCV.js.
 *
 * Finds the card's quadrilateral in a camera frame (edge/contour detection),
 * solves the homography to a true 5:7 rectangle, and warps the pixels into a
 * canonical canvas. Both downstream channels — pHash (hashScanner.ts) and OCR
 * (cardScanner.ts) — then run on that upright, de-skewed card instead of relying
 * on the user lining it up against the dashed guide.
 *
 * OpenCV.js is heavy (~13 MB self-contained wasm), so it is loaded lazily from
 * public/opencv/ (served by the app, cached offline by Workbox) exactly like the
 * Tesseract assets — never bundled into the initial page-load graph. If it can't
 * load, every call returns null and callers fall back to the manual-align path,
 * so this is strictly additive and can't regress existing behaviour.
 */

const OPENCV_DIR = `${import.meta.env.BASE_URL}opencv/`;

/** Canonical output: a true 5:7 card rectangle (width × height). */
export const OUT_W = 600;
export const OUT_H = Math.round(OUT_W / CARD_ASPECT); // === 840 (2.5/3.5)

// Detection runs on a downscaled frame so findContours stays fast.
const DETECT_MAX_DIM = 512;
// The card must cover at least this fraction of the frame area to count.
const MIN_AREA_FRAC = 0.12;
// Acceptable width/height range for the detected quad (tolerates tilt + perspective).
const ASPECT_MIN = 0.5;
const ASPECT_MAX = 0.95;
// approxPolyDP simplification relative to contour perimeter; Canny thresholds.
const APPROX_EPS = 0.02;
const CANNY_LOW = 60;
const CANNY_HIGH = 160;

/** The OpenCV.js API surface we use (resolved after init). Typed structurally — the
 *  package's .d.ts is not always in sync with the runtime build, and we load the
 *  library as a static asset rather than importing it. Constants are referenced by
 *  name so we stay insulated from their exact numeric values. */
interface OpenCvApi {
  Mat: new (...args: any[]) => any;
  Size: new (w: number, h: number) => any;
  MatVector: new () => any;
  matFromArray(rows: number, cols: number, type: number, data: any): any;
  findContours(image: any, hierarchy: any, contours: any, mode: number, method: number): void;
  contourArea(contour: any): number;
  arcLength(curve: any, closed: boolean, isMeasure: boolean): number;
  approxPolyDP(curve: any, epsilon: number, closed: boolean): any;
  minAreaRect(points: any): { points(): any };
  getPerspectiveTransform(src: any, dst: any): any;
  warpPerspective(src: any, dst: any, M: any, dsize: any, flags?: number, borderMode?: number): void;
  cvtColor(src: any, dst: any, code: number): void;
  GaussianBlur(src: any, dst: any, ksize: any, sigmaX: number): void;
  Canny(src: any, dst: any, t1: number, t2: number, apertureSize?: number): void;
  dilate(src: any, dst: any, kernel: any): void;
  CV_8UC1: number;
  CV_8UC4: number;
  CV_32FC2: number;
  COLOR_RGBA2GRAY: number;
  RETR_EXTERNAL: number;
  CHAIN_APPROX_SIMPLE: number;
  INTER_LINEAR: number;
  BORDER_CONSTANT: number;
}

let cvPromise: Promise<OpenCvApi> | null = null;

/** Lazily loads + initializes OpenCV.js and caches the resolved API. Mirrors
 *  initScanner()'s lazy pattern — the heavy library only loads on first use. */
export function initOpenCv(): Promise<OpenCvApi> {
  if (!cvPromise) {
    cvPromise = loadOpenCv().catch((err) => {
      cvPromise = null; // allow a retry after a transient failure (e.g. offline open)
      throw err;
    });
  }
  return cvPromise;
}

function loadOpenCv(): Promise<OpenCvApi> {
  const existing = (globalThis as any).cv;
  if (existing !== undefined) return resolveCv(existing);
  return new Promise<OpenCvApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${OPENCV_DIR}opencv.js`;
    script.async = true;
    script.onload = () => {
      const mod = (globalThis as any).cv;
      if (!mod) return reject(new Error('OpenCV.js loaded but global cv is missing'));
      resolveCv(mod).then(resolve, reject);
    };
    script.onerror = () => reject(new Error('Failed to load OpenCV.js from ' + OPENCV_DIR));
    document.head.appendChild(script);
  });
}

/** Resolves the API regardless of build shape: v5 exposes an async factory (call it),
 *  some builds expose the ready object directly, others via onRuntimeInitialized. */
async function resolveCv(mod: any): Promise<OpenCvApi> {
  let api = mod;
  if (typeof api === 'function') api = await api(); // v5 async module factory
  if (!api?.Mat && typeof api?.onRuntimeInitialized === 'function') {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('OpenCV init timed out')), 30000);
      api.onRuntimeInitialized = () => { clearTimeout(t); res(); };
    });
  }
  if (!api?.Mat) throw new Error('OpenCV failed to initialize (no Mat on resolved module)');
  return api as OpenCvApi;
}
/**
 * Detects the card in `frame` and returns a canonical 5:7 canvas with the card
 * upright and de-skewed, occupying the central 90% (so it lines up exactly with
 * cardZoneForFrame()'s zone for OCR + hashing). Returns null when no plausible
 * card quadrilateral is found or OpenCV is unavailable — callers fall back to the
 * manual-align path.
 */
export async function warpCardToCanonical(frame: HTMLCanvasElement): Promise<HTMLCanvasElement | null> {
  let cv: OpenCvApi;
  try {
    cv = await initOpenCv();
  } catch (err) {
    console.warn('OpenCV unavailable for card warp:', err);
    return null;
  }
  return warpWithCv(cv, frame);
}

/** The detect-and-warp pipeline. Synchronous given a ready OpenCV API object. */
function warpWithCv(cv: OpenCvApi, frame: HTMLCanvasElement): HTMLCanvasElement | null {
  const fullW = frame.width;
  const fullH = frame.height;
  if (fullW < 64 || fullH < 64) return null;

  const scale = DETECT_MAX_DIM / Math.max(fullW, fullH);
  const workW = Math.max(2, Math.round(fullW * scale));
  const workH = Math.max(2, Math.round(fullH * scale));

  // Every Mat we allocate is tracked and released in `finally` — the scan loop
  // runs continuously, so leaked wasm-heap buffers would accumulate.
  const toDelete: { delete?: () => void }[] = [];
  const track = <T>(m: T): T => { toDelete.push(m as any); return m; };

  try {
    // --- 1. Edge map on a downscaled copy (fast findContours). --------------
    const gray = track(new cv.Mat());
    cv.cvtColor(track(rgbaFromCanvas(cv, frameToWork(frame, workW, workH))), gray, cv.COLOR_RGBA2GRAY);
    const blurred = track(new cv.Mat());
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    const edges = track(new cv.Mat());
    cv.Canny(blurred, edges, CANNY_LOW, CANNY_HIGH);
    const kernel = track(new cv.Mat(3, 3, cv.CV_8UC1, new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1])));
    const closedEdges = track(new cv.Mat());
    cv.dilate(edges, closedEdges, kernel);

    // findContours mutates its input — pass the edge map we're done with.
    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(closedEdges, hierarchy, contours, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // --- 2. Largest contour that covers enough of the frame. ----------------
    let bestIdx = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      cnt.delete(); // MatVector.get() returns a copy — release it
      if (area > bestArea) { bestArea = area; bestIdx = i; }
    }
    if (bestIdx < 0 || bestArea < MIN_AREA_FRAC * workW * workH) return null;
    const best = track(contours.get(bestIdx));

    // --- 3. Reduce the contour to a quadrilateral. --------------------------
    const approx = track(cv.approxPolyDP(best, APPROX_EPS * cv.arcLength(best, true, true), true));
    let corners: { x: number; y: number }[] | null =
      approx.rows === 4 ? readPoints2f(approx) : readPoints2f(cv.minAreaRect(best).points());
    if (!corners || corners.length !== 4) return null;

    // --- 4. Order (TL, TR, BR, BL) and validate the shape. ------------------
    const ordered = orderQuad(corners);
    const aspect = quadAspect(ordered);
    if (!aspect || aspect < ASPECT_MIN || aspect > ASPECT_MAX) return null;

    // --- 5. Full-res source points + canonical destination. -----------------
    const srcPts = ordered.map((p) => ({ x: (p.x * fullW) / workW, y: (p.y * fullH) / workH }));
    const M = track(cv.getPerspectiveTransform(toPointMat(cv, srcPts), toPointMat(cv, canonicalDst())));

    // --- 6. Warp the full-resolution frame into the canonical canvas. -------
    const outMat = track(new cv.Mat(OUT_H, OUT_W, cv.CV_8UC4));
    cv.warpPerspective(track(rgbaFromCanvas(cv, frame)), outMat, M, new cv.Size(OUT_W, OUT_H), cv.INTER_LINEAR, cv.BORDER_CONSTANT);

    const out = document.createElement('canvas');
    out.width = OUT_W;
    out.height = OUT_H;
    putMatToCanvas(outMat, out);
    return out;
  } catch (err) {
    console.warn('Card warp failed:', err);
    return null;
  } finally {
    for (const m of toDelete) { try { m?.delete?.(); } catch { /* ignore */ } }
  }
}

/** The four canonical destination corners — the central 90% of OUT_W×OUT_H, so the
 *  warped card sits exactly where cardZoneForFrame(OUT_W/OUT_H) expects it. */
function canonicalDst(): { x: number; y: number }[] {
  const m = 0.05;
  return [
    { x: m * OUT_W, y: m * OUT_H },
    { x: (1 - m) * OUT_W, y: m * OUT_H },
    { x: (1 - m) * OUT_W, y: (1 - m) * OUT_H },
    { x: m * OUT_W, y: (1 - m) * OUT_H }
  ];
}

/** Orders four unordered corners as [TL, TR, BR, BL] via the sum/diff heuristic. */
function orderQuad(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

/** Effective width/height ratio from the ordered quad's edge lengths. */
function quadAspect(q: { x: number; y: number }[]): number | null {
  const [tl, tr, br, bl] = q;
  const w = (dist(tl, tr) + dist(bl, br)) / 2;
  const h = (dist(tl, bl) + dist(tr, br)) / 2;
  if (w <= 0 || h <= 0) return null;
  return w / h;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Reads an OpenCV point-set Mat (MatOfPoint2f or CV_32SC2 contour) into plain points. */
function readPoints2f(m: any): { x: number; y: number }[] | null {
  const rows = m?.rows;
  if (!rows || rows <= 0) return null;
  const arr = m.data32F ?? m.data32S;
  if (!arr || arr.length < rows * 2) return null;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < rows; i++) pts.push({ x: arr[i * 2], y: arr[i * 2 + 1] });
  return pts;
}

/** Builds an Nx1 CV_32FC2 point Mat from plain points (for getPerspectiveTransform). */
function toPointMat(cv: OpenCvApi, pts: { x: number; y: number }[]): any {
  const data = new Float32Array(pts.length * 2);
  pts.forEach((p, i) => { data[i * 2] = p.x; data[i * 2 + 1] = p.y; });
  return cv.matFromArray(pts.length, 1, cv.CV_32FC2, data);
}

/** Draws a frame down to workW×workH. */
function frameToWork(frame: HTMLCanvasElement, workW: number, workH: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = workW;
  c.height = workH;
  c.getContext('2d')!.drawImage(frame, 0, 0, workW, workH);
  return c;
}

/** Wraps a canvas's RGBA pixels in an OpenCV CV_8UC4 Mat. */
function rgbaFromCanvas(cv: OpenCvApi, canvas: HTMLCanvasElement): any {
  const img = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  const u8 = new Uint8Array(img.data.length);
  u8.set(img.data);
  return new cv.Mat(canvas.height, canvas.width, cv.CV_8UC4, u8);
}

/** Writes a CV_8UC4 Mat's pixels back into a canvas. */
function putMatToCanvas(mat: any, canvas: HTMLCanvasElement): void {
  const w = canvas.width;
  const h = canvas.height;
  const px = new Uint8ClampedArray(w * h * 4);
  px.set(mat.data.subarray(0, w * h * 4));
  canvas.getContext('2d')!.putImageData(new ImageData(px, w, h), 0, 0);
}
