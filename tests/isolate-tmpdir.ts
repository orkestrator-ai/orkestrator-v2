import { afterAll } from "bun:test";
import { enterPrivateTestTmpdir } from "./private-tmpdir";

// Runs after the other isolation preloads, so their directories stay in the
// shared temporary directory where their own sweeps look. See
// private-tmpdir.ts, and isolate-git-config.ts for why both handlers are
// needed. Under `--parallel` each evaluation of this preload gets its own
// directory, removed by its `afterAll`.
const leavePrivateTmpdir = enterPrivateTestTmpdir();
afterAll(leavePrivateTmpdir);
process.once("exit", leavePrivateTmpdir);
