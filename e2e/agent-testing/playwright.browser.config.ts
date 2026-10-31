import { defineConfig } from "@playwright/test";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../../tests/private-tmpdir";

// Workers inherit a private TMPDIR, so the browser profiles of a worker that is
// killed land where a later run can remove them (0248, 0830). Workers load this
// file too and reuse the runner's directory.
//
// The profile under test was started outside this run and keeps the shared
// one; a spec that restarts it passes `outlivingProcessEnv()`. The Claude warm
// and paused-interactions configs import this one and so share it.
process.once("exit", enterPrivateTestTmpdir());

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const outputRoot = path.join(repositoryRoot, "output", "agent-testing", runId, "browser");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: [
    "browser-gateway.spec.ts",
    "agent-accounts.spec.ts",
    "permission-rules.spec.ts",
    "design-canvas.spec.ts",
    "graph-designer.spec.ts",
    "graph-designer-editing.spec.ts",
    "graph-run-view.spec.ts",
    "graph-designer-mock.spec.ts",
    "design-container-export.spec.ts",
    "design-live.spec.ts",
    "design-resume-clients-live.spec.ts",
    "native-draft-attachments.spec.ts",
    "web-annotations-gateway.spec.ts",
    "web-annotations-approval-live.spec.ts",
    "cli-ui.spec.ts",
    "container-settings.spec.ts",
    "grok-container-login.spec.ts",
    "container-rebuild-cycle.spec.ts",
    "container-root-terminal.spec.ts",
    "container-approval-stop.spec.ts",
    "container-claude-terminal-signal.spec.ts",
    "terminal-input-resume.spec.ts",
    "terminal-mobile-panes.spec.ts",
    "opencode-live.spec.ts",
    "close-retention-live.spec.ts",
    "codex-typed-prompts-live.spec.ts",
    "codex-refused-login-live.spec.ts",
    "bug-report-live.spec.ts",
    "slash-command-inactive.spec.ts",
    "slash-command-picker.spec.ts",
    "mcp-apply-inactive.spec.ts",
    "multi-review-live.spec.ts",
    "transcript-paging-live.spec.ts",
    "cold-restart-live.spec.ts",
    "claude-revision-tokens-live.spec.ts",
    "mcp-apply-live.spec.ts",
    "mcp-overlay-recovery.spec.ts",
    "mcp-ui-matrix.spec.ts",
    "rich-transcripts-live.spec.ts",
    "idle-observation-live.spec.ts",
    "client-outage.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(outputRoot, "results.json") }],
    [path.join(import.meta.dirname, "artifact-sanitizing-reporter.ts"), { suite: "browser" }],
  ],
  outputDir: path.join(outputRoot, "artifacts"),
  globalSetup: path.join(import.meta.dirname, "bridge-builds-setup.ts"),
  globalTeardown: path.join(import.meta.dirname, "global-teardown.ts"),
  use: {
    // `webkit` runs a spec in Safari's engine (the iOS wrapper's WKWebView).
    browserName: process.env.ORKESTRATOR_AGENT_TEST_BROWSER === "webkit" ? "webkit" : "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
