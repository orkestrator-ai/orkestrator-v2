import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never read from or write to the developer's global Git config.
// A test that needs `git config --global` must override this with a path inside
// its own temporary directory. A real temporary file is required here: Git
// treats /dev/null as a read-only suppression hint but falls back to the normal
// global path when asked to write.
const gitConfigDirectory = mkdtempSync(join(tmpdir(), "orkestrator-test-git-config-"));
process.env.GIT_CONFIG_GLOBAL = join(gitConfigDirectory, "config");

process.once("exit", () => {
  rmSync(gitConfigDirectory, { recursive: true, force: true });
});
