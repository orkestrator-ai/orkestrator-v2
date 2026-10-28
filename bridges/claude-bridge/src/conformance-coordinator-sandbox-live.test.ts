/**
 * Offline qualification of the coordinator's command sandbox on the pinned CLI.
 *
 * The SDK sandbox lets a command write its working directory by default, and a
 * coordinator's working directory is the user's checkout. Before the
 * coordinator sandbox denied it, `uniq in.txt out.txt` (a reading program the
 * hook admitted) wrote the checkout on a host reported as `enforced`.
 */
import { describe, test } from "bun:test";
import { qualifyCoordinatorSandbox } from "../test-fixtures/coordinator-sandbox-qualification.js";

const supported = process.platform === "darwin" || process.platform === "linux";
describe("Claude coordinator sandbox qualification", () => {
  for (const scenario of [
    "default-sandbox-writes",
    "coordinator-sandbox-refuses",
    "coordinator-sandbox-reads",
    "coordinator-hook-refuses",
    "unavailable-hook-reads",
    "unavailable-hook-refuses-quoted",
    "unavailable-hook-refuses-escaped",
    "unavailable-hook-refuses-glob",
    "unavailable-hook-refuses-abbreviation",
  ] as const) {
    (supported ? test : test.skip)(scenario, () => qualifyCoordinatorSandbox(scenario), 20_000);
  }
});

/**
 * A `readOnly` review turn in an ordinary bridge (Multi Review's reports) on a
 * host without bubblewrap or socat, staged by hiding both on `PATH` the way
 * the original evidence was gathered (todo 0190). The required case is the
 * behaviour before the fix, so it is pinned only on Linux, where it was seen.
 */
describe("Claude read-only turn without a working sandbox", () => {
  for (const scenario of [
    "read-only-unavailable-reads",
    "read-only-unavailable-hook-refuses",
  ] as const) {
    (supported ? test : test.skip)(scenario, () => qualifyCoordinatorSandbox(scenario), 20_000);
  }
  (process.platform === "linux" ? test : test.skip)(
    "read-only-required-refused",
    () => qualifyCoordinatorSandbox("read-only-required-refused"),
    20_000,
  );
});
