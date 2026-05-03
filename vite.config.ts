import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Use `./` so GitHub Pages works for both user sites and project pages without extra config. */
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: null,
      includeAssets: [
        "favicon.ico",
        "favicon.svg",
        "favicon.png",
        "pwa-192.png",
        "pwa-512.png",
      ],
      manifest: {
        id: "./",
        name: "Hit or Script",
        short_name: "Hit or Script",
        description:
          "Guess real Eurovision clips vs AI / fan showcases — listen, then tap Hit or Script.",
        start_url: "./",
        scope: "./",
        display: "standalone",
        orientation: "natural",
        background_color: "#111225",
        theme_color: "#111225",
        lang: "en",
        categories: ["games", "entertainment"],
        icons: [
          {
            src: "pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "google-fonts-stylesheets",
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern:
              /^https:\/\/(i\.ytimg\.com|lh3\.googleusercontent\.com)\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "remote-images",
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 14 },
            },
          },
        ],
      },
    }),
  ],
});
