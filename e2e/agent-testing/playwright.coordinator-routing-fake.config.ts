import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

process.once("exit", enterPrivateTestTmpdir());

/**
 * The coordinator routing fake-model suite
 * (`mise run test:agent:coordinator:routing-fake`, to-do 7545 task 4).
 * Separate from the coordinator config so it runs only on a profile set up
 * for it: Pi only, no credentials, a loopback fake model.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-coordinator-routing-fake";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "coordinator-routing-fake",
);

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: ["coordinator-routing-fake.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 1_200_000,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(outputRoot, "results.json") }],
    [
      path.join(import.meta.dirname, "artifact-sanitizing-reporter.ts"),
      { suite: "coordinator-routing-fake" },
    ],
  ],
  outputDir: path.join(outputRoot, "artifacts"),
  globalSetup: path.join(import.meta.dirname, "bridge-builds-setup.ts"),
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: { mode: "retain-on-failure", snapshots: false, screenshots: false, sources: false },
    screenshot: "only-on-failure",
  },
});
