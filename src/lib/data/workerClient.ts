/**
 * Main-thread client for the data-loader Web Worker. Spawns a single shared
 * worker and multiplexes load requests to it by id, so card-data.json and
 * card-hashes.bin are fetched and parsed off the UI thread (the ~12 MB hash
 * index in particular would otherwise stall the main thread at startup).
 */

export type LoadType = 'card-data' | 'card-hashes';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    worker = new Worker(new URL('./dataLoader.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data as { id: number; ok: boolean; error?: string } & Record<string, unknown>;
      const request = pending.get(msg.id);
      if (!request) return;
      pending.delete(msg.id);
      if (msg.ok) request.resolve(msg);
      else request.reject(new Error(msg.error ?? 'data load failed'));
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      const message = event.message || 'data loader worker crashed';
      for (const [id, request] of pending) {
        request.reject(new Error(message));
        pending.delete(id);
      }
    });
  }
  return worker;
}

/** True when Web Workers are available (always true in this app's target browsers). */
export function workersSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Asks the loader worker to fetch + parse one data asset and resolves with the
 * worker's reply payload. Rejects on load failure or if workers are unavailable
 * (callers then fall back to a main-thread load).
 */
export function requestLoad<T>(type: LoadType): Promise<T> {
  const instance = getWorker();
  if (!instance) return Promise.reject(new Error('Web Workers are not available'));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    instance.postMessage({ id, type });
  });
}