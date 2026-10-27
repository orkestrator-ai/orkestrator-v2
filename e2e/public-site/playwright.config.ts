import { defineConfig } from "@playwright/test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const port = Number.parseInt(process.env.ORKESTRATOR_PUBLIC_E2E_PORT ?? "4423", 10);
const baseURL = `http://127.0.0.1:${port}`;

// Build outside apps/web-public/dist: the aggregate suite's Turbo build writes
// that directory, and review validation runs the two concurrently.
const distDirectory = path.join(repositoryRoot, "output/playwright/public-site-dist");

// Serve the built public entrypoint, including its real lazy-loaded chunks and
// SPA fallback. The pre-connection flow does not require a backend or credentials.
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.spec.ts",
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  reporter: "line",
  outputDir: path.join(repositoryRoot, "output/playwright/public-site"),
  webServer: {
    command: `bun check && bunx vite build --outDir "${distDirectory}" --emptyOutDir && bunx vite preview --outDir "${distDirectory}" --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: path.join(repositoryRoot, "apps/web-public"),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: { baseURL, browserName: "chromium", trace: "retain-on-failure" },
  projects: [
    { name: "public-mobile", use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
    { name: "public-desktop", use: { viewport: { width: 1280, height: 900 } } },
  ],
});
