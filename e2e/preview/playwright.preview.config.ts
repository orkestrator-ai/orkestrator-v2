import { defineConfig } from "@playwright/test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

/**
 * Real-browser checks of private preview origins. The spec starts its own
 * isolated backend preview stack (`apps/backend/src/preview-browser-harness.ts`)
 * with a throwaway CA and resolves `*.preview.test` to loopback inside Chromium
 * only; no system DNS, trust store, or user data is touched.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "line",
  outputDir: path.join(repositoryRoot, "output/playwright/preview-results"),
  use: { trace: "retain-on-failure" },
});
