import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:coordinator:restart-fake`
 *
 * A coordinator restarting a build pipeline step a usage limit stopped, on
 * this node and on a connected node (to-do 4680 (retired) task 2): two disposable
 * `dev:test --fixture` profiles on this host, the main one the command node
 * and the companion its leaf, both with no agent credentials and only Pi
 * enabled. The spec points both profiles' Pi at
 * `coordinator-restart-fake-model.ts` on loopback, whose build workers are
 * refused with a usage limit, and attaches the leaf over its real gateway. It
 * runs `coordinator-restart-fake.spec.ts`, then both profiles are stopped and
 * reset. Nothing logs in and nothing is billed; it is still not part of
 * `mise run test`, because it boots two whole profiles.
 */

installFatalRejectionGuard({ label: "[coordinator-restart-fake]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0)
  throw new Error(`test:agent:coordinator:restart-fake takes no arguments (got ${args[0]})`);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const run = randomUUID().slice(0, 8);
    const profile = `qa-restart-desk-${run}`;
    const leaf = `qa-restart-leaf-${run}`;
    console.log(`[coordinator-restart-fake] profiles ${profile} (command node), ${leaf} (leaf)`);
    const code = await runIsolatedBrowser({
      profile,
      companionProfiles: [leaf],
      profileArgs: ["--no-agent-credentials", "--agent-platforms", "pi"],
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
      suite: {
        label: "Coordinator pipeline step restart here and on a leaf (fake model)",
        config: "e2e/agent-testing/playwright.coordinator-restart-fake.config.ts",
        env: {
          ORKESTRATOR_AGENT_TEST_COORDINATOR_RESTART_FAKE: "1",
          ORKESTRATOR_AGENT_TEST_RESTART_LEAF_PROFILE: leaf,
        },
      },
      signal: owner.signal,
      // A first run may download the pinned Pi toolchain.
      startupTimeoutMs: 300_000,
      testTimeoutMs: 2_700_000,
    });
    console.log(`[coordinator-restart-fake] exit ${code}`);
    process.exitCode = code;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
