import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:coordinator:node-mail-fake`
 *
 * Coordinator-to-coordinator node mail between two disposable `dev:test
 * --fixture` profiles on this host (to-do 2900): the main profile is the
 * command node, the companion its leaf, both with no agent credentials and
 * only Pi enabled. The spec attaches the leaf over its real gateway, points
 * both profiles' Pi at `coordinator-node-mail-fake-model.ts` on loopback, and
 * runs the round trip, the loop bound (unattended budget 3) and a main
 * replacement on the command node. It runs
 * `coordinator-node-mail-fake.spec.ts`, then both profiles are stopped and
 * reset. Nothing logs in and nothing is billed; it is still not part of
 * `mise run test`, because it boots two whole profiles.
 */

installFatalRejectionGuard({ label: "[coordinator-node-mail-fake]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0)
  throw new Error(`test:agent:coordinator:node-mail-fake takes no arguments (got ${args[0]})`);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const run = randomUUID().slice(0, 8);
    const profile = `qa-node-mail-desk-${run}`;
    const leaf = `qa-node-mail-leaf-${run}`;
    console.log(`[coordinator-node-mail-fake] profiles ${profile} (command node), ${leaf} (leaf)`);
    const code = await runIsolatedBrowser({
      profile,
      companionProfiles: [leaf],
      profileArgs: ["--no-agent-credentials", "--agent-platforms", "pi"],
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
      suite: {
        label: "Coordinator node mail between two profiles (fake model)",
        config: "e2e/agent-testing/playwright.coordinator-node-mail-fake.config.ts",
        env: {
          ORKESTRATOR_AGENT_TEST_COORDINATOR_NODE_MAIL_FAKE: "1",
          ORKESTRATOR_AGENT_TEST_NODE_MAIL_LEAF_PROFILE: leaf,
        },
      },
      signal: owner.signal,
      // A first run may download the pinned Pi toolchain.
      startupTimeoutMs: 300_000,
      testTimeoutMs: 1_800_000,
    });
    console.log(`[coordinator-node-mail-fake] exit ${code}`);
    process.exitCode = code;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
