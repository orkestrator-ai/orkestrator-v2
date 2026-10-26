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
