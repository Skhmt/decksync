import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from "@tailwindcss/vite"
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/decksync/',
  // base: '.',
  plugins: [
    svelte(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.png'],
      manifest: {
        name: 'DeckSync - MTG Deck Verification',
        short_name: 'DeckSync',
        description: 'Lightweight checklist tool for Magic: The Gathering physical deck verification',
        theme_color: '#1e1b4b',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait-primary',
        icons: [
          {
            src: 'icon.png',
            sizes: '1024x1024',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        // Precache only the app shell (built JS/CSS/HTML + icons). The large,
        // growing assets — Tesseract OCR cores/traineddata and the local card
        // database + pHash index — are runtime-cached below instead of being
        // precached. Keeping them out of the precache manifest means it never
        // has to grow with those files, so Workbox's per-file size cap stops
        // being a constraint even as the OCR assets get bigger.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['tess/**', 'opencv/**', 'card-data.json', 'card-hashes.bin'],
        // The largest precached file is now an app bundle (not a Tesseract asset),
        // so the default 2 MiB cap would usually suffice; this headroom only
        // guards against an unusually large chunk being silently dropped.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          // Tesseract worker + wasm cores + traineddata. Fetched/importScripts'd
          // by the OCR worker on first use; cache-first so OCR works offline after
          // the first scan. Long-lived — these only change when tesseract.js is
          // upgraded (the self-contained *.wasm.js loaders embed their own binary,
          // so no separate external .wasm files are ever requested).
          {
            urlPattern: /\/tess\/.+$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tess-assets',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          // OpenCV.js (card localization + perspective warp). Loaded lazily at scan
          // time by src/lib/ocr/cardWarp.ts; cache-first so it works offline after
          // the first scan. A single self-contained file, like the Tesseract cores.
          {
            urlPattern: /\/opencv\/.+$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opencv-assets',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          // Local card database + pHash index. Served from the app origin and
          // regenerated on build; stale-while-revalidate keeps them available
          // offline while refreshing in the background when online (so newly
          // added cards are picked up without a hard cache clear).
          {
            urlPattern: /\/(card-data\.json|card-hashes\.bin)$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'card-data',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /^https:\/\/api\.scryfall\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'scryfall-api-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 7 // 7 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            urlPattern: /^https:\/\/cards\.scryfall\.io\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'scryfall-images-cache',
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      }
    }),
  ],
})
