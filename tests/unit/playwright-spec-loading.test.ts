import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Playwright loads every spec under Node before it runs any. A spec that
 * imports Bun-only code (backend storage needs `bun:sqlite`) aborts the whole
 * suite with "Received protocol 'bun:'", and no default CI job runs these
 * suites to notice. Listing loads every file without a browser or a profile,
 * so it catches that here. Specs that need the backend reach it through a Bun
 * child process instead (`e2e/design-service-host.ts`,
 * `e2e/agent-testing/backend-store.ts`).
 */

const root = path.resolve(import.meta.dir, "..", "..");

// Bun's parallel workers set `JEST_WORKER_ID`, and Playwright refuses to load
// specs inside what looks like a Jest run.
const { JEST_WORKER_ID: _jest, BUN_TEST_WORKER_ID: _worker, ...childEnv } = process.env;

describe("Playwright suites", () => {
  test.each([
    "e2e/playwright.config.ts",
    "e2e/public-site/playwright.config.ts",
    "e2e/preview/playwright.preview.config.ts",
    "e2e/agent-testing/playwright.browser.config.ts",
    "e2e/agent-testing/playwright.claude-warm.config.ts",
    "e2e/agent-testing/playwright.paused-interactions.config.ts",
    "e2e/agent-testing/playwright.electron.config.ts",
  ])(
    "%s loads every spec under Node",
    (config) => {
      const run = spawnSync("bunx", ["playwright", "test", "--config", config, "--list"], {
        cwd: root,
        env: childEnv,
        encoding: "utf8",
        timeout: 60_000,
      });
      const errors = `${run.stdout}\n${run.stderr}`
        .split("\n")
        .filter((line) => line.startsWith("Error"));
      expect(errors).toEqual([]);
      expect(run.status).toBe(0);
    },
    90_000,
  );
});
