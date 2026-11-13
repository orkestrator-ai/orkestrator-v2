/**
 * A `bun test` preload for the strict probe (to-do 6900). It exposes the probe
 * as `globalThis.__lostChildProbe`, so a scratch capture can register each
 * child (`track`) and say what it did to it (`mark`); numbers the tests; and
 * holds the process for up to 30 s after the last test, so a late event is
 * still seen.
 *
 *   LOST_CHILD_PROBE_OUT=/abs/out.jsonl bun test --preload ../../tests/setup-node.ts \
 *     --preload <repo>/scripts/lost-child-event/preload.ts <test file>
 *
 * The capture calls, in a scratch copy only (never on a pushed branch):
 *
 *   const probe = globalThis.__lostChildProbe;
 *   const before = probe?.openFds();
 *   const child = spawn(command, args, { ...options, stdio: "pipe" });
 *   probe?.track(child, [command, ...args], before, options.cwd);
 */
import { afterAll, beforeEach } from "bun:test";
import { holdUntilClosed, mark, openFds, probeState, track } from "./probe";

(globalThis as { __lostChildProbe?: unknown }).__lostChildProbe = { mark, openFds, track };

beforeEach(() => {
  probeState.test += 1;
});

afterAll(async () => {
  await holdUntilClosed(30_000);
}, 40_000);
