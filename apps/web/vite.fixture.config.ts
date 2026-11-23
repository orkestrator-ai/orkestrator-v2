import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import {
  FIXTURE_IDENTITY_HEADER,
  FIXTURE_IDENTITY_PATH,
  FIXTURE_OUT_DIR_ENV,
  FIXTURE_PREVIEW_IDENTITY_ENV,
  fixtureDevIdentity,
} from "../../e2e/fixture-server-identity";

function fixtureServerIdentity(): Plugin {
  function identify(middlewares: Connect.Server, identity: string) {
    middlewares.use((request, response, next) => {
      if (request.url !== FIXTURE_IDENTITY_PATH) return next();
      response.setHeader(FIXTURE_IDENTITY_HEADER, identity);
      response.setHeader("Cache-Control", "no-store");
      response.writeHead(204).end();
    });
  }
  return {
    name: "orkestrator-fixture-server-identity",
    configureServer(server) {
      identify(server.middlewares, fixtureDevIdentity(server.config.root));
    },
    configurePreviewServer(server) {
      const identity = process.env[FIXTURE_PREVIEW_IDENTITY_ENV];
      if (identity) identify(server.middlewares, identity);
    },
  };
}

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
  plugins: [fixtureServerIdentity(), react(), tailwindcss({ optimize: false })],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  clearScreen: false,
  logLevel: "warn",
  build: {
    outDir: process.env[FIXTURE_OUT_DIR_ENV],
    minify: false,
    cssMinify: false,
    reportCompressedSize: false,
    // The fixture is one page importing every fixture; size is not a concern.
    chunkSizeWarningLimit: 100_000,
  },
});
