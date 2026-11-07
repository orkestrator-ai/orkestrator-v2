import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

// Workers inherit a private TMPDIR, as in the browser and Electron configs.
process.once("exit", enterPrivateTestTmpdir());

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runId =
  process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ??
  process.env.ORKESTRATOR_AGENT_TEST_PROFILE ??
  "multi-node";
const mode = process.env.ORKESTRATOR_AGENT_TEST_IN_TREE === "0" ? "realm" : "in-tree";
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "multi-node", mode);

/**
 * The multi-node window qualification (plan item 4006) against two running
 * `dev:test` profiles, the second attached to the first as a leaf, plus extra
 * standalone leaves the spec starts itself: `browser` drives the command
 * profile's gateway page, `electron` launches its own Electron and connects it
 * to the command profile as a remote command node. Both skip unless
 * ORKESTRATOR_AGENT_TEST_PROFILE and ORKESTRATOR_AGENT_TEST_LEAF_PROFILE name
 * the two profiles. Not part of the smoke suite: it needs a second profile.
 * ORKESTRATOR_AGENT_TEST_IN_TREE=0 runs the realm path's parity flows.
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
    { name: "browser", testMatch: ["multi-node-window.spec.ts"], use: { browserName: "chromium" } },
    { name: "electron", testMatch: ["multi-node-window.spec.ts"] },
  ],
});
