import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:coordinator:routing-fake`
 *
 * The live coordinator suite's routing `build` case on a loopback fake model
 * (to-do 7545 task 4): one disposable `dev:test --fixture` profile with no
 * agent credentials and only Pi enabled, whose Pi is pointed at
 * `coordinator-routing-fake-model.ts` by the spec. A Pi coordinator turns the
 * request into a ticket and a build, the harness cancels the build as the
 * user's Cancel does, and the coordinator's wake must be a `cancelled` notice
 * that restarts nothing. It runs `coordinator-routing-fake.spec.ts`, then the
 * profile is stopped and reset. Nothing logs in and nothing is billed; it is
 * still not part of `mise run test`, because it boots a whole profile.
 */

installFatalRejectionGuard({ label: "[coordinator-routing-fake]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0)
  throw new Error(`test:agent:coordinator:routing-fake takes no arguments (got ${args[0]})`);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const profile = `qa-coordinator-routing-fake-${randomUUID().slice(0, 8)}`;
    console.log(`[coordinator-routing-fake] profile ${profile}`);
    const code = await runIsolatedBrowser({
      profile,
      profileArgs: ["--no-agent-credentials", "--agent-platforms", "pi"],
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
      suite: {
        label: "Coordinator routing fake-model build case",
        config: "e2e/agent-testing/playwright.coordinator-routing-fake.config.ts",
        env: { ORKESTRATOR_AGENT_TEST_COORDINATOR_ROUTING_FAKE: "1" },
      },
      signal: owner.signal,
      // A first run may download the pinned Pi toolchain.
      startupTimeoutMs: 300_000,
      testTimeoutMs: 1_500_000,
    });
    console.log(`[coordinator-routing-fake] exit ${code}`);
    process.exitCode = code;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
