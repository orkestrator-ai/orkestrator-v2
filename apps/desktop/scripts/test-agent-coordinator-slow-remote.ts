import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:coordinator-slow-remote`
 *
 * Coordinator checkout sync against a slow remote (to-do 4720): one disposable
 * `dev:test --fixture` profile with no agent credentials and only Pi enabled,
 * whose Pi is pointed at a loopback fake model by the spec. It runs
 * `coordinator-slow-remote-live.spec.ts`, which adds two disposable projects
 * whose origins are local bare repositories behind delayed SSH shims, then the
 * profile is stopped and reset. Nothing logs in, nothing is billed and nothing
 * reaches the network; it is still not part of `mise run test`, because it
 * boots a whole profile and waits out the backend's 60 s fetch cooldown.
 */

installFatalRejectionGuard({ label: "[coordinator-slow-remote]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0)
  throw new Error(`test:agent:coordinator-slow-remote takes no arguments (got ${args[0]})`);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const profile = `qa-slow-remote-${randomUUID().slice(0, 8)}`;
    console.log(`[coordinator-slow-remote] profile ${profile}`);
    const code = await runIsolatedBrowser({
      profile,
      profileArgs: ["--no-agent-credentials", "--agent-platforms", "pi"],
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
      suite: {
        label: "Coordinator slow-remote fast-forward",
        config: "e2e/agent-testing/playwright.coordinator-slow-remote.config.ts",
        env: { ORKESTRATOR_AGENT_TEST_COORDINATOR_SLOW_REMOTE: "1" },
      },
      signal: owner.signal,
      // A first run may download the pinned Pi toolchain.
      startupTimeoutMs: 300_000,
      testTimeoutMs: 1_200_000,
    });
    console.log(`[coordinator-slow-remote] exit ${code}`);
    process.exitCode = code;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
