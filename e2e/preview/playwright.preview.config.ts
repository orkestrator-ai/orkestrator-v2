import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

// Workers inherit a private TMPDIR, so the browser profiles of a worker that is
// killed land where a later run can remove them (0248, 0830). Workers load this
// file too and reuse the runner's directory.
//
// The preview stack the spec starts is its child and moves with it.
process.once("exit", enterPrivateTestTmpdir());

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

/**
 * Real-browser checks of private preview origins. The spec starts its own
 * isolated backend preview stack (`apps/backend/src/preview-browser-harness.ts`)
 * with a throwaway CA and a browser-local proxy resolving test hosts to loopback;
 * no system DNS, trust store, or user data is touched.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.spec.ts",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    // Playwright WebKit is engine coverage, not qualification of shipping Safari/iOS.
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "line",
  outputDir: path.join(repositoryRoot, "output/playwright/preview-results"),
  use: { trace: "retain-on-failure" },
});
