import { defineConfig } from "@playwright/test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? "electron-smoke";
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "electron");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: [
    "application-menu-electron.spec.ts",
    "electron-main.spec.ts",
    "electron-cleanup.spec.ts",
    "web-annotations-electron.spec.ts",
    "terminal-input-resume-electron.spec.ts",
    "service-preview-electron.spec.ts",
    "artifact-host-electron.spec.ts",
    "design-canvas-electron.spec.ts",
    "workspace-realm-electron.spec.ts",
  ],
  workers: 1,
  timeout: 120_000,
  reporter: [["line"], ["json", { outputFile: path.join(outputRoot, "results.json") }]],
  outputDir: path.join(outputRoot, "artifacts"),
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
