import { defineConfig } from "@playwright/test";
import path from "node:path";

/**
 * The live coordinator suite (`mise run test:agent:coordinator`). Separate from
 * the browser agent config so no other suite ever loads it, and with its own
 * timeout: one case is one real coordinator turn.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "coordinator");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: ["coordinator-live.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 900_000,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(outputRoot, "results.json") }],
    [path.join(import.meta.dirname, "artifact-sanitizing-reporter.ts"), { suite: "coordinator" }],
  ],
  outputDir: path.join(outputRoot, "artifacts"),
  globalSetup: path.join(import.meta.dirname, "bridge-builds-setup.ts"),
  globalTeardown: path.join(import.meta.dirname, "coordinator-live-teardown.ts"),
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
