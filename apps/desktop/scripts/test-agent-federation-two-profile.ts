import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:federation:two-profile`
 *
 * A command node and its leaf as two disposable `dev:test --fixture` profiles
 * on this host, driven in headless Chromium (to-dos 2190 (retired) task 3 and
 * 5840 (retired) tasks 1–2): the remote row's activity against the leaf's own
 * row, per-node relayed events with a busy leaf and an away tab, and the
 * older-peer relay on the wire. Both profiles run with no agent credentials,
 * `--no-host-seed` and only Pi enabled; the leaf's Pi turns go to
 * `federation-two-profile-fake-model.ts` on loopback. It runs
 * `federation-two-profile.spec.ts`, then both profiles are stopped and reset.
 * Nothing logs in and nothing is billed; it is still not part of
 * `mise run test`, because it boots two whole profiles.
 */

installFatalRejectionGuard({ label: "[federation-two-profile]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0)
  throw new Error(`test:agent:federation:two-profile takes no arguments (got ${args[0]})`);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const run = randomUUID().slice(0, 8);
    const profile = `qa-federation-command-${run}`;
    const leaf = `qa-federation-leaf-${run}`;
    console.log(`[federation-two-profile] profiles ${profile} (command node), ${leaf} (leaf)`);
    const code = await runIsolatedBrowser({
      profile,
      companionProfiles: [leaf],
      profileArgs: ["--no-agent-credentials", "--no-host-seed", "--agent-platforms", "pi"],
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
      suite: {
        label: "Federation between two profiles (remote activity, relayed events)",
        config: "e2e/agent-testing/playwright.federation-two-profile.config.ts",
        env: {
          ORKESTRATOR_AGENT_TEST_FEDERATION_TWO_PROFILE: "1",
          ORKESTRATOR_AGENT_TEST_FEDERATION_LEAF_PROFILE: leaf,
        },
      },
      signal: owner.signal,
      // A first run may download the pinned Pi toolchain.
      startupTimeoutMs: 300_000,
      testTimeoutMs: 1_800_000,
    });
    console.log(`[federation-two-profile] exit ${code}`);
    process.exitCode = code;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
