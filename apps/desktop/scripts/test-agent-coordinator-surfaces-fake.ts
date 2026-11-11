import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:coordinator:surfaces-fake`
 *
 * Two coordinator worker surfaces (coordinator.md, "Worker surfaces") on a
 * loopback fake model: one disposable `dev:test --fixture
 * --fixture-environments local,container` profile with no agent credentials
 * and only Pi enabled, whose Pi is pointed
 * at `coordinator-surfaces-fake-model.ts` by the spec. A Pi coordinator asks
 * for the checkout's uncommitted changes to go to the local and the container
 * worker, and the spec rejects and approves them in the browser client's
 * approval dialog; then it opens the container worker's preview, which must
 * bind to the container's own service. It runs
 * `coordinator-surfaces-fake.spec.ts`, then the profile is stopped and reset.
 * Nothing logs in and nothing is billed; it is still not part of
 * `mise run test`, because it boots a whole profile and a container (the
 * workspace's development image is built when it is missing).
 */

installFatalRejectionGuard({ label: "[coordinator-surfaces-fake]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0)
  throw new Error(`test:agent:coordinator:surfaces-fake takes no arguments (got ${args[0]})`);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const profile = `qa-coordinator-surfaces-fake-${randomUUID().slice(0, 8)}`;
    console.log(`[coordinator-surfaces-fake] profile ${profile}`);
    const code = await runIsolatedBrowser({
      profile,
      profileArgs: [
        "--no-agent-credentials",
        "--agent-platforms",
        "pi",
        "--fixture-environments",
        "local,container",
      ],
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
      suite: {
        label: "Coordinator worker surfaces fake-model case",
        config: "e2e/agent-testing/playwright.coordinator-surfaces-fake.config.ts",
        env: { ORKESTRATOR_AGENT_TEST_COORDINATOR_SURFACES_FAKE: "1" },
      },
      signal: owner.signal,
      // A first run may build the development image and download Pi.
      startupTimeoutMs: 1_800_000,
      testTimeoutMs: 1_500_000,
    });
    console.log(`[coordinator-surfaces-fake] exit ${code}`);
    process.exitCode = code;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
