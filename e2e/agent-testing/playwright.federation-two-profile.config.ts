import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

process.once("exit", enterPrivateTestTmpdir());

/**
 * The two-profile federation suite (`mise run test:agent:federation:two-profile`;
 * to-dos 2190 (retired) task 3 and 5840 (retired) tasks 1–2). Separate from
 * the browser config so it runs only on the two profiles set up for it: the
 * command node is `ORKESTRATOR_AGENT_TEST_PROFILE`, the leaf
 * `ORKESTRATOR_AGENT_TEST_FEDERATION_LEAF_PROFILE`; Pi only, no credentials,
 * a loopback fake model.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-federation-command";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "federation-two-profile",
);

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: ["federation-two-profile.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 1_200_000,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(outputRoot, "results.json") }],
    [
      path.join(import.meta.dirname, "artifact-sanitizing-reporter.ts"),
      { suite: "federation-two-profile" },
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
