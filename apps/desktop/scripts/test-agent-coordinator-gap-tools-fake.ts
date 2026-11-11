import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:coordinator:gap-tools-fake`
 *
 * The live coordinator suite's `gap-tools` scenario on a loopback fake model
 * (to-do 1021 (retired) tasks 1 and 4): two disposable `dev:test --fixture` profiles on
 * this host, the main one the command node and the companion its leaf, both
 * with no agent credentials and only Pi enabled. The spec points both
 * profiles' Pi at `coordinator-gap-tools-fake-model.ts`, runs the scenario
 * against a worker on the command node, then attaches the leaf over its real
 * gateway and runs it again with `nodeId` against a worker on the leaf. It
 * runs `coordinator-gap-tools-fake.spec.ts`, then both profiles are stopped
 * and reset. Nothing logs in and nothing is billed; it is still not part of
 * `mise run test`, because it boots two whole profiles.
 */

installFatalRejectionGuard({ label: "[coordinator-gap-tools-fake]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0)
  throw new Error(`test:agent:coordinator:gap-tools-fake takes no arguments (got ${args[0]})`);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const run = randomUUID().slice(0, 8);
    const profile = `qa-gap-tools-desk-${run}`;
    const leaf = `qa-gap-tools-leaf-${run}`;
    console.log(`[coordinator-gap-tools-fake] profiles ${profile} (command node), ${leaf} (leaf)`);
    const code = await runIsolatedBrowser({
      profile,
      companionProfiles: [leaf],
      profileArgs: ["--no-agent-credentials", "--agent-platforms", "pi"],
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
      suite: {
        label: "Coordinator gap tools on this node and a connected node (fake model)",
        config: "e2e/agent-testing/playwright.coordinator-gap-tools-fake.config.ts",
        env: {
          ORKESTRATOR_AGENT_TEST_COORDINATOR_GAP_TOOLS_FAKE: "1",
          ORKESTRATOR_AGENT_TEST_GAP_TOOLS_LEAF_PROFILE: leaf,
        },
      },
      signal: owner.signal,
      // A first run may download the pinned Pi toolchain.
      startupTimeoutMs: 300_000,
      testTimeoutMs: 3_300_000,
    });
    console.log(`[coordinator-gap-tools-fake] exit ${code}`);
    process.exitCode = code;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
