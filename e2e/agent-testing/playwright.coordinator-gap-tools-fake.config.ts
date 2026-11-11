import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

process.once("exit", enterPrivateTestTmpdir());

/**
 * The coordinator gap-tools fake-model suite
 * (`mise run test:agent:coordinator:gap-tools-fake`, to-do 1021 (retired) tasks 1 and
 * 4). Separate from the coordinator config so it runs only on the two
 * profiles set up for it (the command node is `ORKESTRATOR_AGENT_TEST_PROFILE`,
 * the leaf `ORKESTRATOR_AGENT_TEST_GAP_TOOLS_LEAF_PROFILE`): Pi only, no
 * credentials, a loopback fake model.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-gap-tools-desk";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "coordinator-gap-tools-fake",
);

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: ["coordinator-gap-tools-fake.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 1_500_000,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(outputRoot, "results.json") }],
    [
      path.join(import.meta.dirname, "artifact-sanitizing-reporter.ts"),
      { suite: "coordinator-gap-tools-fake" },
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
