import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:suborks`
 *
 * `/subork` on a disposable `dev:test --fixture` profile with no agent
 * credentials and only Pi and OpenCode enabled (4340 (retired) tasks 1 and 4).
 * The specs point the profile's own Pi and OpenCode at
 * `suborks-fake-model.ts` on loopback. It runs `suborks-live.spec.ts` (each
 * provider asks itself and the other) and then `suborks-restart-live.spec.ts`
 * (an OpenCode caller's call to Pi and OpenCode across a killed backend, which restarts
 * the profile), then stops and resets the profile. Nothing logs in and nothing is billed; it is still
 * not part of `mise run test`, because it boots a whole profile.
 */

installFatalRejectionGuard({ label: "[suborks]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0) throw new Error(`test:agent:suborks takes no arguments (got ${args[0]})`);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const profile = `qa-suborks-${randomUUID().slice(0, 8)}`;
    console.log(`[suborks] profile ${profile}`);
    const code = await runIsolatedBrowser({
      profile,
      profileArgs: ["--no-agent-credentials", "--agent-platforms", "pi,opencode"],
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
      suite: {
        label: "/subork on Pi and OpenCode, and across a backend restart (scripted model)",
        config: "e2e/agent-testing/playwright.suborks.config.ts",
        env: {
          ORKESTRATOR_AGENT_TEST_SUBORKS: "1",
          ORKESTRATOR_AGENT_TEST_SUBORKS_FAKE: "1",
        },
      },
      // The restart spec stops and starts the profile itself.
      suiteRestartsProfiles: true,
      signal: owner.signal,
      // A first run may download the pinned Pi and OpenCode toolchains.
      startupTimeoutMs: 600_000,
      testTimeoutMs: 2_700_000,
    });
    console.log(`[suborks] exit ${code}`);
    process.exitCode = code;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
