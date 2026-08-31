import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ReviewPackage } from "@orkestrator/protocol/review-workflow";
import {
  generateLoopedReviewPackage,
  waitForContainerReviewPackageWrite,
  writeEnvironmentReviewPackage,
} from "./commands-review.js";
import { StorageService } from "./storage.js";

const temporaryDirectories: string[] = [];

function packageFixture(): ReviewPackage {
  return {
    id: "package-1",
    round: 1,
    preparedAt: "2026-08-31T00:00:00.000Z",
    targetBranch: "main",
    baseRef: "0".repeat(40),
    headRef: "1".repeat(40),
    commit: null,
    completeDiff: "diff",
    changedFiles: [],
    validation: [],
    skippedFiles: [],
    uncommittedFiles: [],
    limitations: [],
  };
}

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof mock>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = mock(() => true);
  return child;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(await new Response(process.stderr).text());
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("generateLoopedReviewPackage", () => {
  test("fails closed when tracked or untracked changes remain outside the package", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-review-package-"));
    temporaryDirectories.push(root);
    const worktree = path.join(root, "worktree");
    await fs.mkdir(worktree);
    await git(worktree, "init", "--initial-branch=main");
    await git(worktree, "config", "user.email", "test@example.com");
    await git(worktree, "config", "user.name", "Test User");
    await fs.writeFile(path.join(worktree, "tracked.txt"), "committed\n");
    await git(worktree, "add", "tracked.txt");
    await git(worktree, "commit", "-m", "feat: base");
    await git(worktree, "update-ref", "refs/remotes/origin/main", "HEAD");
    await fs.writeFile(path.join(worktree, "tracked.txt"), "modified\n");
    await fs.writeFile(path.join(worktree, "untracked.txt"), "new\n");

    const storage = new StorageService(path.join(root, "data"));
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "review",
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: worktree,
      setupScriptsComplete: true,
    });

    await expect(
      generateLoopedReviewPackage(
        "env-1",
        "package-1",
        1,
        "main",
        [],
        [
          { path: "tracked.txt", reason: "Left behind." },
          { path: "untracked.txt", reason: "Left behind." },
        ],
        ["The worktree is not clean."],
        { storage } as never,
      ),
    ).rejects.toThrow("requires a clean worktree");
  });
});

describe("container review package publication", () => {
  test("wires docker publication, captures helper stderr, and settles on close", async () => {
    const child = fakeChild();
    let stdin = "";
    child.stdin.on("data", (chunk: Buffer) => (stdin += chunk.toString()));
    child.stdin.once("finish", () => queueMicrotask(() => child.emit("close", 0)));
    const spawned: unknown[][] = [];
    const runnerCalls: Array<{ command: string; args: string[] }> = [];
    const reference = await writeEnvironmentReviewPackage(
      {
        id: "env-1",
        environmentType: "container",
        containerId: "container-1",
      } as never,
      async (command, args) => {
        runnerCalls.push({ command, args });
        return "";
      },
      packageFixture(),
      {
        spawn: ((...args: unknown[]) => {
          spawned.push(args);
          return child;
        }) as never,
        timeoutMs: 1_000,
      },
    );

    expect(spawned[0]?.[0]).toBe("docker");
    expect(spawned[0]?.[1]).toEqual(
      expect.arrayContaining(["exec", "-i", "container-1", "overwrite"]),
    );
    expect(Buffer.from(stdin, "base64").byteLength).toBe(reference.bytes);
    expect(runnerCalls.some((call) => call.command === "git")).toBe(true);
    expect(runnerCalls.some((call) => call.command === "chmod")).toBe(false);

    const failed = fakeChild();
    const failure = waitForContainerReviewPackageWrite(failed as never, Buffer.from("x"), 1_000);
    failed.stderr.write("ENOSPC");
    failed.emit("close", 76);
    await expect(failure).rejects.toThrow("ENOSPC");
  });

  test("times out a wedged helper and refuses publication when Git exclusion fails", async () => {
    const child = fakeChild();
    await expect(
      waitForContainerReviewPackageWrite(child as never, Buffer.from("x"), 5),
    ).rejects.toThrow("timed out");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    const spawn = mock(() => fakeChild());
    await expect(
      writeEnvironmentReviewPackage(
        {
          id: "env-1",
          environmentType: "container",
          containerId: "container-1",
        } as never,
        async (command) => {
          if (command === "git") throw new Error("not ignored");
          return "";
        },
        packageFixture(),
        { spawn: spawn as never },
      ),
    ).rejects.toThrow("not Git-excluded");
    expect(spawn).not.toHaveBeenCalled();
  });
});
