import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "./shell.js";
import { readDefaultBranchSetupCommands } from "./setup-approval.js";
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
test("reads committed default config, preferring remote tracking over local and worktree edits", async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-setup-git-"));
  const git = (...args: string[]) => runCommand("git", args, { cwd: root });
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  const config = path.join(root, "orkestrator-ai.json");
  await writeFile(config, JSON.stringify({ setupLocal: "echo remote" }));
  await git("add", ".");
  await git("commit", "-m", "remote");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await writeFile(config, JSON.stringify({ setupLocal: "echo local" }));
  await git("add", ".");
  await git("commit", "-m", "local");
  await writeFile(config, JSON.stringify({ setupLocal: "echo uncommitted" }));
  expect(await readDefaultBranchSetupCommands(root, "main")).toEqual(["echo remote"]);
  await git("update-ref", "-d", "refs/remotes/origin/main");
  expect(await readDefaultBranchSetupCommands(root, "main")).toEqual(["echo local"]);
}, 30000);
