# DeckSync

Maybe you're a judge and want to validate someone's deck? Maybe you're someone who tinkers with their deck a lot and it has over time become *desynchronized* with your online deck list? DeckSync lets you easily check if a cardboard stack matches a digital deck list.

It's a static single page application that can be installed as a progressive web app. Built in Svelte/DaisyUI/Vite.

*This is **NOT** a deck builder.*

## To-do

- Add a modal where you can tap a card and quickly get oracle text (maybe? feels like scope creep)

## Development

Install deps: `npm i`

Build: `npm run build`

Dev server: `npm run dev`

Both `dev` and `build` automatically run the pre-build steps first (`predev` / `prebuild`). All generated artifacts are gitignored.

### Card data pre-build step

`dev` and `build` first run `scripts/prepare-data.js`, which downloads MTGJSON v5
card data (cached in `scripts/.cache/` for 7 days) and generates
`public/card-data.json`: a list of all card names plus a
`set:collector number → Scryfall id` index. The app loads it on launch so the
card scanner can validate OCR readings locally — unknown set/number pairs and
garbage names are rejected without any Scryfall API call, and known printings
resolve via the local IndexedDB cache (zero API calls after the first scan).

- Force a data refresh: `DECKSYNC_FORCE_DATA=1 npm run prepare:data`
- The generated file and download cache are gitignored; the script fails soft
  (keeps the previous data) when offline.

## Scripts

All build, index-maintenance, benchmarking and diagnostic tooling lives in `scripts/`.
The three `prepare:*` scripts run automatically before `dev` / `build`; everything else
is run manually.

### Pre-build (auto-run before `dev` / `build`)

| Script | npm script | What it does |
| --- | --- | --- |
| `prepare-data.js` | `npm run prepare:data` | Downloads MTGJSON v5 card data and generates `public/card-data.json` — a local index of all normalized card names plus a `set:collector number → Scryfall id` map. Lets the scanner validate OCR readings locally and resolve known printings with zero API calls after the first scan. Fails soft when offline (keeps the previous data). |
| `prepare-opencv.js` | `npm run prepare:opencv` | Copies the self-contained OpenCV.js build from `node_modules/@techstark/opencv-js` into `public/opencv/` so it is served from the app's own origin and cached for offline use. It is loaded lazily at scan time, never bundled into the initial page load. Fails soft if the package isn't installed yet. |
| `prepare-hashes.js` | `npm run prepare:hashes` | Builds `public/card-hashes.bin`, a compact binary index of 64-bit perceptual hashes (pHash) of card artwork — the network-free identification channel that runs in parallel with OCR. Downloads each face image from Scryfall, hashes the central art region once per camera-aspect class and per stored variant (tilt angle × fill scale), and drops reprints that share artwork. Append-only and resumable: progress lives in side-car ledgers under `scripts/.cache/`, so cancelling (Ctrl+C) loses nothing — re-run to resume exactly where it stopped. |

`prepare-hashes.js` target list (in priority order):
- `DECKSYNC_HASH_CARDS="Card A, Card B"` — index exactly these names;
- otherwise a small built-in test list covering old-style, modern, full-art and multi-faced printings;
- `DECKSYNC_HASH_ALL=1` — index every unique card name from the cached MTGJSON download (the full production build).

### Hash-index maintenance (manual)

| Script | npm script | What it does |
| --- | --- | --- |
| `rebuild-hashes-offline.js` | `npm run rebuild:hashes` | Regenerates `card-hashes.bin` **offline** from the locally cached face images (`scripts/.cache/hashes/`) using the true 5:7 card-zone geometry, with no network calls. Re-hashes only faces recorded as "accepted" so coverage is unchanged — only the hash values change to match the current crop. Writes to a `.tmp` file first and backs up the previous index to `card-hashes.bin.bak` before promoting. Supports `--dry-run`, `--limit=N` and `--concurrency=N`. |
| `topup-hashes.js` | — (run directly) | Re-downloads face images that are missing from `scripts/.cache/hashes/` so the pHash-vs-OCR benchmark can simulate a photo for every indexed card. One Scryfall API call per id, paced to 1 req/s, resumable via a side ledger (`topup-progress.jsonl`). Env: `DECKSYNC_TOPUP_LIMIT`, `DECKSYNC_TOPUP_NAMES`. |

### Shared library

| Script | What it does |
| --- | --- |
| `hash-index-bin.js` | The shared binary codec for the pHash index (`card-hashes.bin`, format "DCH1"). Provides `writeHeader` / `appendBinRecord` (used by the build scripts) and `readBinIndex` (decodes hashes back to hex strings so the string-based bench/diagnostic logic is unchanged), plus `readBinPacked` (reads straight into packed SoA arrays — the same shape the app builds at load). A torn trailing record from an interrupted build is tolerated so a cancelled run can resume. |

### Benchmarks, tests & diagnostics (manual)

| Script | What it does |
| --- | --- |
| `test-hash-vs-ocr.js` | End-to-end pHash vs OCR benchmark. Simulates photographed cards (tilt, size, JPEG compression) with the exact geometry the app uses, then measures both identification channels — **hash**: per-frame crop/hash/match time, accuracy and distance distribution; **OCR**: tesseract on the set/collector corner + name bar with local validation against `card-data.json` — plus a storage-cost comparison. Env: `DECKSYNC_BENCH_SAMPLE`, `DECKSYNC_BENCH_CARDS`, `DECKSYNC_BENCH_OCR=0`. |
| `bench-hamming.js` | Benchmarks string-based vs packed-int Hamming distance against the real index (one query hash compared to every stored variant per frame). First verifies the packed version matches the production string implementation exactly, then reports time/frame and speedup. Env: `DECKSYNC_BENCH_FRAMES`, `DECKSYNC_BENCH_CLASS`. |
| `verify-packed.js` | Verifies the packed-int (SoA) hash path is correct: a stored slot's own hash must come back at distance 0, and a full packed scan must agree with an independent string reference scan. Also reports per-frame scan timing. Exits non-zero on any failure. |
| `diagnose-hash-distances.js` | Simulates the runtime hash pipeline at various fill levels (0.70–1.10) and rotations (±3°) to measure how close pHash distances are to the acceptance threshold, with a per-card distance histogram. Use: `node scripts/diagnose-hash-distances.js --limit=10`. |
| `test-content-gate.js` | Unit test for the hash-scanner content gate — the luma-range check that rejects blank tables, empty frames and low-contrast crops before they reach pHash matching. Runs four synthetic cases (blank / empty / out-of-focus vs real card art) and exits non-zero on any mismatch. |

### Scratch / throwaway scripts

These dot-prefixed files at the repo root are one-off experiments, not part of the build:
- `.analyze-tess.mjs` — verifies the base64 wasm blob embedded in `tesseract-core-lstm.wasm.js` is byte-identical to the external `.wasm` file (SHA-256 comparison).
- `.proto-tmp.mjs` — early pHash prototype exploring tilt/fill/cross-card distance behaviour before the current pipeline was settled.

