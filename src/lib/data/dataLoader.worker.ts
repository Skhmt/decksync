/**
 * Web Worker that fetches and parses the local card data assets off the main
 * thread. Runs in its own context so JSON parsing (card-data.json) and the
 * ~12 MB hash-index walk/pack (card-hashes.bin) never block the UI. The typed
 * arrays from the hash index are transferred (not copied) back to the page.
 */

import { buildCardDatabase, parseHashIndex } from './builders';

// `self` is typed as a DOM Window per tsconfig (no webworker lib) — narrow it to
// the small surface this worker actually uses so postMessage's transfer list
// typechecks.
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

const BASE = import.meta.env.BASE_URL;

interface LoadRequest {
  id: number;
  type: string;
}

scope.addEventListener('message', (event: MessageEvent) => {
  const { id, type } = event.data as LoadRequest;
  void handle(id, type);
});

async function handle(id: number, type: string): Promise<void> {
  try {
    if (type === 'card-data') {
      const response = await fetch(`${BASE}card-data.json`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as { names?: string[]; printings?: Record<string, string> };
      // Set/Map cross the boundary via structured clone (supported for both).
      scope.postMessage({ id, ok: true, ...buildCardDatabase(json) });
    } else if (type === 'card-hashes') {
      const response = await fetch(`${BASE}card-hashes.bin`, { headers: { Accept: 'application/octet-stream' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buf = await response.arrayBuffer();
      const index = parseHashIndex(buf);
      // Transfer the big typed-array buffers zero-copy to the main thread.
      const transfers: ArrayBuffer[] = [];
      for (const cls of Object.values(index.packed)) {
        transfers.push(cls.hi.buffer as ArrayBuffer, cls.lo.buffer as ArrayBuffer, cls.owner.buffer as ArrayBuffer);
      }
      scope.postMessage(
        { id, ok: true, ready: index.ready, entries: index.entries, region: index.region, threshold: index.threshold, packed: index.packed },
        transfers
      );
    } else {
      throw new Error(`unknown load type: ${type}`);
    }
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}