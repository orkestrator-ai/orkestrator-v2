import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

// Workers inherit a private TMPDIR, as in the browser and Electron configs.
process.once("exit", enterPrivateTestTmpdir());

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runId =
  process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ??
  process.env.ORKESTRATOR_AGENT_TEST_PROFILE ??
  "diagnostics-across-nodes";
const outputRoot = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "diagnostics-across-nodes",
);

/**
 * Diagnostics export from a leaf node over two running `dev:test` profiles,
 * the second attached to the first (to-do 6141 task 4). Opt-in and not part
 * of the smoke suite. See `diagnostics-across-nodes-live.spec.ts` for the
 * commands.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  fullyParallel: false,
  workers: 1,
  timeout: 10 * 60_000,
  reporter: [["line"], ["json", { outputFile: path.join(outputRoot, "results.json") }]],
  outputDir: path.join(outputRoot, "artifacts"),
  use: {
    trace: "off",
    screenshot: "only-on-failure",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
  },
  testMatch: ["diagnostics-across-nodes-live.spec.ts"],
});
