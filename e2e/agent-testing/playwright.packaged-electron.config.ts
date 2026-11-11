import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

// See playwright.electron.config.ts: workers inherit a private TMPDIR.
process.once("exit", enterPrivateTestTmpdir());

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? "electron-packaged";
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "electron-packaged");

/**
 * Electron specs for the shipping binary security smoke and inspect-enabled
 * packaged-test design journey, rather than the dev bundle and Vite. Kept
 * apart from playwright.electron.config.ts because they need that build first.
 * The native-shortcut spec skips unless `ORKESTRATOR_NATIVE_SHORTCUT_INPUT=1`,
 * which belongs only on a disposable X display (it sends real key presses).
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: [
    "design-canvas-packaged-electron.spec.ts",
    "log-controls-packaged-electron.spec.ts",
    "packaged-native-shortcuts-electron.spec.ts",
    "packaged-security-electron.spec.ts",
    "watcher-packaged-electron.spec.ts",
  ],
  workers: 1,
  timeout: 120_000,
  reporter: [["line"], ["json", { outputFile: path.join(outputRoot, "results.json") }]],
  outputDir: path.join(outputRoot, "artifacts"),
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
