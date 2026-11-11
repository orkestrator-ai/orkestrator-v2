import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:coordinator:notice-live`
 *
 * The coordinator notice hierarchy between two disposable `dev:test
 * --fixture` profiles on this host, on fixture Claude accounts (to-do 7542
 * tasks 2 to 4): the main profile is the command node, the companion its
 * leaf, both with no agent credentials and only Claude and Pi enabled. It
 * first starts `coordinator-notice-fake-model.ts` on loopback and starts both
 * profiles with `ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN` naming it, so their
 * plan usage reads never leave the machine. It runs
 * `coordinator-notice-live.spec.ts`, which stops and starts both profiles
 * once, then both profiles are stopped and reset and the provider is stopped.
 * Nothing logs in and nothing is billed; it is still not part of
 * `mise run test`, because it boots two whole profiles.
 */

installFatalRejectionGuard({ label: "[coordinator-notice-live]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
if (args.length > 0)
  throw new Error(`test:agent:coordinator:notice-live takes no arguments (got ${args[0]})`);

/** The loopback provider, started before either profile so both read usage from it. */
async function startProvider(): Promise<{ origin: string; stop(): Promise<void> }> {
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../../../e2e/agent-testing/coordinator-notice-fake-model.ts"),
    ],
    { stdout: "pipe", stderr: "inherit", stdin: "ignore" },
  );
  const lines = createInterface({ input: child.stdout as unknown as NodeJS.ReadableStream });
  const origin = await Promise.race([
    new Promise<string>((resolve) => lines.once("line", resolve)),
    child.exited.then((code) => {
      throw new Error(`the loopback provider exited (${code}) before it listened`);
    }),
  ]);
  lines.close();
  return {
    origin,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    },
  };
}

if (supervised) {
  const owner = ownerAbortSignal();
  const provider = await startProvider();
  try {
    const run = randomUUID().slice(0, 8);
    const profile = `qa-notice-desk-${run}`;
    const leaf = `qa-notice-leaf-${run}`;
    console.log(`[coordinator-notice-live] profiles ${profile} (command node), ${leaf} (leaf)`);
    const code = await runIsolatedBrowser({
      profile,
      companionProfiles: [leaf],
      suiteRestartsProfiles: true,
      profileArgs: ["--no-agent-credentials", "--agent-platforms", "claude,pi"],
      env: {
        ...process.env,
        ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
        ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN: provider.origin,
      },
      suite: {
        label: "Coordinator notice hierarchy between two profiles (fixture accounts)",
        config: "e2e/agent-testing/playwright.coordinator-notice-live.config.ts",
        env: {
          ORKESTRATOR_AGENT_TEST_COORDINATOR_NOTICE_LIVE: "1",
          ORKESTRATOR_AGENT_TEST_NOTICE_LEAF_PROFILE: leaf,
          ORKESTRATOR_AGENT_TEST_NOTICE_FAKE_ORIGIN: provider.origin,
        },
      },
      signal: owner.signal,
      // A first run may download the pinned Claude and Pi toolchains.
      startupTimeoutMs: 300_000,
      testTimeoutMs: 2_700_000,
    });
    console.log(`[coordinator-notice-live] exit ${code}`);
    process.exitCode = code;
  } finally {
    await provider.stop();
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
