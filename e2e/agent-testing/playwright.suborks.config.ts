import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

process.once("exit", enterPrivateTestTmpdir());

/**
 * The subork qualification suite (`mise run test:agent:suborks`, 4340
 * (retired) tasks 1 and 4): `suborks-live.spec.ts` (every provider as caller and target)
 * and then `suborks-restart-live.spec.ts` (a call across a killed backend).
 * Files run in name order on one worker, so the spec that restarts the
 * profile runs last. Separate from the browser agent config so no other suite
 * loads it: both specs skip unless `ORKESTRATOR_AGENT_TEST_SUBORKS=1`.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-suborks";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "suborks");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: ["suborks-live.spec.ts", "suborks-restart-live.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 1_800_000,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(outputRoot, "results.json") }],
    [path.join(import.meta.dirname, "artifact-sanitizing-reporter.ts"), { suite: "suborks" }],
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
