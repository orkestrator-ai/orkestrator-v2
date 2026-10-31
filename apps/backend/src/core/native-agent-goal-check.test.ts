import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Environment } from "./models.js";
import { goalWorkspaceFingerprint } from "./native-agent-goal-check.js";

const environment = (worktreePath: string) =>
  ({ environmentType: "local", worktreePath }) as unknown as Environment;

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "orkestrator-goal-fingerprint-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("goalWorkspaceFingerprint", () => {
  test("a directory that is not a checkout cannot say", async () => {
    await withDir(async (dir) => {
      expect(await goalWorkspaceFingerprint(environment(dir))).toBeUndefined();
    });
  });

  test("changes with a new file, an edit and a commit, and not otherwise", async () => {
    await withDir(async (dir) => {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
      git("init", "-q");
      await writeFile(path.join(dir, "a.txt"), "one\n");
      git("add", "a.txt");
      git("commit", "-q", "-m", "first");
      const clean = await goalWorkspaceFingerprint(environment(dir));
      expect(clean).toBeString();
      expect(await goalWorkspaceFingerprint(environment(dir))).toBe(clean);
      await writeFile(path.join(dir, "b.txt"), "new\n");
      const untracked = await goalWorkspaceFingerprint(environment(dir));
      expect(untracked).not.toBe(clean);
      await writeFile(path.join(dir, "a.txt"), "two\n");
      const edited = await goalWorkspaceFingerprint(environment(dir));
      expect(edited).not.toBe(untracked);
      git("add", "-A");
      git("commit", "-q", "-m", "second");
      expect(await goalWorkspaceFingerprint(environment(dir))).not.toBe(edited);
    });
  });
});
