import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { autoPipelineLogLevel, parseAutoPipelineArguments } from "./dev/auto-pipeline-arguments.js";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:auto-pipeline`
 *
 * The Auto-pipeline launch flow end to end (to-do 7547 task 4): one disposable
 * `dev:test --fixture` profile with no agent credentials and only Pi enabled,
 * whose Pi is pointed at a loopback fake model by the spec. It runs
 * `auto-pipeline-live.spec.ts`, then the profile is stopped and reset. Nothing
 * logs in and nothing is billed; it is still not part of `mise run test`,
 * because it boots a whole profile and takes minutes.
 *
 * `--reviewers <1-4>` sets the review panel size (default 1; two or more run
 * the review fan-out, whose reads are what is counted). The
 * backend's `build-pipeline` area logs at debug, so the spec can count each
 * review pass's prompt-context reads (`review.prompt-reads`, to-do 7566 (retired)) from
 * the profile's log; it records them under `output/agent-testing/<profile>/`.
 */

installFatalRejectionGuard({ label: "[auto-pipeline-live]" });

const { supervised, reviewers } = parseAutoPipelineArguments(
  process.argv.slice(2),
  SUPERVISED_FLAG,
);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const profile = `qa-auto-pipeline-${randomUUID().slice(0, 8)}`;
    console.log(`[auto-pipeline-live] profile ${profile}`);
    const code = await runIsolatedBrowser({
      profile,
      profileArgs: ["--no-agent-credentials", "--no-host-seed", "--agent-platforms", "pi"],
      env: {
        ...process.env,
        ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
        // Counts only: the review fan-out's per-pass prompt reads.
        ORKESTRATOR_LOG_LEVEL: autoPipelineLogLevel(process.env.ORKESTRATOR_LOG_LEVEL),
      },
      suite: {
        label: "Auto-pipeline fake-model flow",
        config: "e2e/agent-testing/playwright.auto-pipeline.config.ts",
        env: {
          ORKESTRATOR_AGENT_TEST_AUTO_PIPELINE: "1",
          ORKESTRATOR_AGENT_TEST_AUTO_PIPELINE_REVIEWERS: reviewers,
        },
      },
      signal: owner.signal,
      // A first run may download the pinned Pi toolchain.
      startupTimeoutMs: 300_000,
      testTimeoutMs: 1_500_000,
    });
    console.log(`[auto-pipeline-live] exit ${code}`);
    process.exitCode = code;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, ["--reviewers", reviewers]);
}
