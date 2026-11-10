import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
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
 */

installFatalRejectionGuard({ label: "[auto-pipeline-live]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0)
  throw new Error(`test:agent:auto-pipeline takes no arguments (got ${args[0]})`);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const profile = `qa-auto-pipeline-${randomUUID().slice(0, 8)}`;
    console.log(`[auto-pipeline-live] profile ${profile}`);
    const code = await runIsolatedBrowser({
      profile,
      profileArgs: ["--no-agent-credentials", "--agent-platforms", "pi"],
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
      suite: {
        label: "Auto-pipeline fake-model flow",
        config: "e2e/agent-testing/playwright.auto-pipeline.config.ts",
        env: { ORKESTRATOR_AGENT_TEST_AUTO_PIPELINE: "1" },
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
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
