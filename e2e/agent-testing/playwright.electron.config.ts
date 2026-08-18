import { defineConfig } from "@playwright/test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? "electron-smoke";
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "electron");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "electron-main.spec.ts",
  workers: 1,
  timeout: 120_000,
  reporter: [["line"], ["json", { outputFile: path.join(outputRoot, "results.json") }]],
  outputDir: path.join(outputRoot, "artifacts"),
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
