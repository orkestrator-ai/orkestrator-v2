import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

// Workers inherit a private TMPDIR, as in the browser and Electron configs.
process.once("exit", enterPrivateTestTmpdir());

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runId =
  process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ??
  process.env.ORKESTRATOR_AGENT_TEST_PROFILE ??
  "scope-proof";
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "scope-proof");

/**
 * The Phase 2 exit proof (plan item 2013) against two running `dev:test`
 * profiles, the second attached to the first: `browser` drives the command
 * profile's gateway page, `electron` launches its own Electron and connects it
 * to the command profile. Both skip unless ORKESTRATOR_AGENT_TEST_PROFILE and
 * ORKESTRATOR_AGENT_TEST_LEAF_PROFILE name the two profiles. Not part of the
 * smoke suite: it needs a second profile.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  globalSetup: path.join(import.meta.dirname, "electron-display-setup.ts"),
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
  reporter: [["line"], ["json", { outputFile: path.join(outputRoot, "results.json") }]],
  outputDir: path.join(outputRoot, "artifacts"),
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "browser", testMatch: ["scope-proof.spec.ts"], use: { browserName: "chromium" } },
    { name: "electron", testMatch: ["scope-proof-electron.spec.ts"] },
  ],
});
