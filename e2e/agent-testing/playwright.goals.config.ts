import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

process.once("exit", enterPrivateTestTmpdir());

/**
 * The live goal suite (`mise run test:agent:goals`). Separate from the browser
 * agent config so no other suite ever loads it: every case runs real model turns.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-goals";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "goals");

export default defineConfig({
  testDir: import.meta.dirname,
  // The restart spec stops its profile, so it only runs on one started by hand.
  testMatch: [
    process.env.ORKESTRATOR_AGENT_TEST_GOAL_ONLY === "restart"
      ? "goals-restart-live.spec.ts"
      : "goals-live.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 900_000,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(outputRoot, "results.json") }],
    [path.join(import.meta.dirname, "artifact-sanitizing-reporter.ts"), { suite: "goals" }],
  ],
  outputDir: path.join(outputRoot, "artifacts"),
  globalSetup: path.join(import.meta.dirname, "bridge-builds-setup.ts"),
  globalTeardown: path.join(import.meta.dirname, "goals-live-teardown.ts"),
  use: {
    browserName: "chromium",
    trace: { mode: "retain-on-failure", snapshots: false, screenshots: false, sources: false },
    screenshot: "only-on-failure",
  },
});
