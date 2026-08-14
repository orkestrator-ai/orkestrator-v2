import { defineConfig } from "@playwright/test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "browser");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "browser-gateway.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(outputRoot, "results.json") }],
  ],
  outputDir: path.join(outputRoot, "artifacts"),
  globalTeardown: path.join(import.meta.dirname, "global-teardown.ts"),
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
