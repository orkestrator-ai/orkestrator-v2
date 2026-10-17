import { defineConfig } from "@playwright/test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "browser");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: [
    "browser-gateway.spec.ts",
    "agent-accounts.spec.ts",
    "design-canvas.spec.ts",
    "native-draft-attachments.spec.ts",
    "web-annotations-gateway.spec.ts",
    "cli-ui.spec.ts",
    "container-settings.spec.ts",
    "container-rebuild-cycle.spec.ts",
    "container-approval-stop.spec.ts",
    "terminal-input-resume.spec.ts",
    "terminal-mobile-panes.spec.ts",
    "opencode-live.spec.ts",
    "close-retention-live.spec.ts",
    "slash-command-inactive.spec.ts",
    "multi-review-live.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [["line"], ["json", { outputFile: path.join(outputRoot, "results.json") }]],
  outputDir: path.join(outputRoot, "artifacts"),
  globalTeardown: path.join(import.meta.dirname, "global-teardown.ts"),
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
