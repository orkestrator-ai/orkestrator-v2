import path from "node:path";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { parseCoordinatorLiveArguments } from "./dev/coordinator-live.js";
import { COORDINATOR_LIVE_ROOT_ENV, runCoordinatorLive } from "./dev/coordinator-live-runner.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:coordinator [--credential-source <platform>]… [--scenario <scenario>]…`
 *
 * One disposable `dev:test --fixture` profile per platform, authorized for
 * that platform's host credential alone, runs the live coordinator spec and is
 * stopped and reset afterwards. A platform without a usable credential is
 * reported as skipped by the spec, never as passed. Real turns cost tokens, so
 * nothing else runs this: not `mise run test`, not CI, not review.
 *
 * The suite runs in an IPC-owned supervisor, like the isolated browser task:
 * a profile holds a host credential and its turn spends real tokens, so even
 * an owner killed outright must leave it stopped and reset.
 */

installFatalRejectionGuard({ label: "[coordinator-live]" });

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
// Validated before anything starts, so a typo fails without a profile.
const { platforms, scenarios } = parseCoordinatorLiveArguments(args);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    const override = process.env[COORDINATOR_LIVE_ROOT_ENV];
    const { exitCode, summaryFile } = await runCoordinatorLive({
      platforms,
      scenarios,
      signal: owner.signal,
      log: (line) => console.log(line),
      ...(override ? { root: path.resolve(override) } : {}),
    });
    console.log(`Summary: ${summaryFile}`);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Live coordinator suite failed");
    process.exitCode = 1;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
