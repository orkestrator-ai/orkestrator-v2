import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

// Workers inherit a private TMPDIR, as in the browser and Electron configs.
process.once("exit", enterPrivateTestTmpdir());

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runId =
  process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ??
  process.env.ORKESTRATOR_AGENT_TEST_PROFILE ??
  "fleet-ticket-sync";
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "fleet-ticket-sync");

/**
 * Fleet ticket sync over two running `dev:test` profiles, the second attached
 * to the first as a leaf (to-do 3800 task 1). Opt-in and not part of the
 * smoke suite: it needs two fresh profiles and stops and restarts the leaf.
 * See `fleet-ticket-sync-live.spec.ts` for the commands.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  fullyParallel: false,
  workers: 1,
  timeout: 30 * 60_000,
  reporter: [["line"], ["json", { outputFile: path.join(outputRoot, "results.json") }]],
  outputDir: path.join(outputRoot, "artifacts"),
  use: { trace: "off", screenshot: "only-on-failure", browserName: "chromium" },
  testMatch: ["fleet-ticket-sync-live.spec.ts"],
});
