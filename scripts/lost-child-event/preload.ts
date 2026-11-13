/**
 * A `bun test` preload for the strict probe (to-do 6900). It exposes the probe
 * as `globalThis.__lostChildProbe`, so a scratch capture can register each
 * child (`track`) and say what it did to it (`mark`); numbers the tests; and
 * holds the process for up to 30 s after the last test, so a late event is
 * still seen. With `LOST_CHILD_PROBE_SCHEDULE` set it also records every
 * `fs.promises.writeFile` and `fs.writeFileSync` call, so `reduction.ts
 * replay` can make the same file changes between the same commands (the
 * fixture's README edits, which its commits and reverts depend on).
 *
 *   LOST_CHILD_PROBE_OUT=/abs/out.jsonl bun test --preload ../../tests/setup-node.ts \
 *     --preload <repo>/scripts/lost-child-event/preload.ts <test file>
 *
 * The capture calls, in a scratch copy only (never on a pushed branch):
 *
 *   const probe = globalThis.__lostChildProbe;
 *   const before = probe?.openFds();
 *   const child = spawn(command, args, { ...options, stdio: "pipe" });
 *   probe?.track(child, [command, ...args], before, options.cwd, options.env);
 */
import { afterAll, beforeEach } from "bun:test";
import fs from "node:fs";
import { holdUntilClosed, mark, openFds, probeState, recordWrite, track } from "./probe";

(globalThis as { __lostChildProbe?: unknown }).__lostChildProbe = { mark, openFds, track };

if (process.env.LOST_CHILD_PROBE_SCHEDULE) {
  // Patched on the shared objects before any test module loads, so
  // `import { promises as fs } from "node:fs"` sees the wrapper.
  const writeFile = fs.promises.writeFile;
  fs.promises.writeFile = ((file: unknown, data: unknown, ...rest: unknown[]) => {
    recordWrite(file, data);
    return (writeFile as (...args: unknown[]) => Promise<void>)(file, data, ...rest);
  }) as typeof fs.promises.writeFile;
  const writeFileSync = fs.writeFileSync;
  fs.writeFileSync = ((file: unknown, data: unknown, ...rest: unknown[]) => {
    recordWrite(file, data);
    return (writeFileSync as (...args: unknown[]) => void)(file, data, ...rest);
  }) as typeof fs.writeFileSync;
}

beforeEach(() => {
  probeState.test += 1;
});

afterAll(async () => {
  await holdUntilClosed(30_000);
}, 40_000);
