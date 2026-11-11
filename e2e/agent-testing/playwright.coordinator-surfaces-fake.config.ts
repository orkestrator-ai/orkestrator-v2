import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

process.once("exit", enterPrivateTestTmpdir());

/**
 * The coordinator worker-surfaces fake-model suite
 * (`mise run test:agent:coordinator:surfaces-fake`).
 * Separate from the coordinator config so it runs only on a profile set up
 * for it: Pi only, no credentials, a loopback fake model, and the local and
 * container fixture environments.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-coordinator-surfaces-fake";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "coordinator-surfaces-fake",
);

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: ["coordinator-surfaces-fake.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 1_200_000,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(outputRoot, "results.json") }],
    [
      path.join(import.meta.dirname, "artifact-sanitizing-reporter.ts"),
      { suite: "coordinator-surfaces-fake" },
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
