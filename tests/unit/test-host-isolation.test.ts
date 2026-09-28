import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { getWorktreeBaseDir } from "../../apps/backend/src/core/commands-environment";
import { APP_SLUG } from "../../apps/backend/src/core/constants";

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// A test that forgets `worktreeDir` must still land in a temporary directory:
// an earlier one left real worktrees in the user's workspaces root.
describe("test preload host isolation", () => {
  test("keeps the worktree fallback out of the user's real workspaces root", () => {
    const fallback = getWorktreeBaseDir();

    expect(isInside(fallback, path.join(os.homedir(), APP_SLUG))).toBe(false);
    expect(path.basename(fallback)).toMatch(
      new RegExp(`^orkestrator-test-worktrees-${process.pid}-`),
    );
    expect(getWorktreeBaseDir({})).toBe(fallback);
  });

  test("names the Git config directory after this process", () => {
    expect(path.basename(path.dirname(process.env.GIT_CONFIG_GLOBAL ?? ""))).toMatch(
      new RegExp(`^orkestrator-test-git-config-${process.pid}-`),
    );
  });
});
