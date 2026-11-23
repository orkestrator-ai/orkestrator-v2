import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

/**
 * The component suite's fixture page (`e2e/fixture`), which the suite builds
 * once per run and serves statically (`e2e/playwright.config.ts`). Served
 * unbundled by a dev server, every page load fetched about 1,900 modules and
 * took about 2 s, half the suite's time (docs/development/testing-guide.md,
 * "The fixture server").
 *
 * The build keeps the dev server's semantics, which is what the specs assert:
 *
 * - React's development build (the suite sets `NODE_ENV=development`).
 * - No `rendererSecurityPlugin`: like the dev server, no production
 *   Content-Security-Policy and the design and static HTML frames keep their
 *   `srcdoc` bootstrap. `e2e/public-site` tests the production policy.
 * - Tailwind's CSS unoptimized and nothing minified, so computed styles and
 *   stylesheet text read as they do from the dev server.
 *
 * `base` is absolute, unlike the packaged app's `./`, because fixture routes
 * are nested paths that the preview server answers with `index.html`.
 */
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss({ optimize: false })],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  clearScreen: false,
  logLevel: "warn",
  build: {
    minify: false,
    cssMinify: false,
    reportCompressedSize: false,
    // The fixture is one page importing every fixture; size is not a concern.
    chunkSizeWarningLimit: 100_000,
  },
});
