import { afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createOwnedTempDir, sweepStaleTempDirs } from "./temp-sweep";

const GIT_CONFIG_DIRECTORY_PREFIX = "orkestrator-test-git-config-";
const STALE_AFTER_MS = 60 * 60 * 1_000;

// Remove directories left by test processes that exited without cleaning up.
// Names from before the PID was embedded are removed on age alone: that format
// is no longer created, and no test process runs for an hour.
sweepStaleTempDirs({
  prefix: GIT_CONFIG_DIRECTORY_PREFIX,
  maxAgeMs: STALE_AFTER_MS,
  legacyMaxAgeMs: STALE_AFTER_MS,
});

// Tests must never read from or write to the developer's global Git config.
// A test that needs `git config --global` must override this with a path inside
// its own temporary directory. A real temporary file is required here: Git
// treats /dev/null as a read-only suppression hint but falls back to the normal
// global path when asked to write.
const gitConfigDirectory = createOwnedTempDir(GIT_CONFIG_DIRECTORY_PREFIX);
process.env.GIT_CONFIG_GLOBAL = join(gitConfigDirectory, "config");

// `bun test` does not deliver `exit` to preload handlers, and under
// `--parallel` it evaluates the preload again for every file in the same
// worker. A preload-level `afterAll` runs once after the tests that
// evaluation served, so it is the handler that actually cleans up; the `exit`
// handler covers any other runner.
function removeGitConfigDirectory(): void {
  rmSync(gitConfigDirectory, { recursive: true, force: true });
}
afterAll(removeGitConfigDirectory);
process.once("exit", removeGitConfigDirectory);
