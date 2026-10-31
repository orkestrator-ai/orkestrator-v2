import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveProjectGitRoot } from "./project-git-root.js";
import * as shell from "./shell.js";
import { CommandFailedError, runCommand } from "./shell.js";
import type { StorageService } from "./storage.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-git-root-"));
  roots.push(root);
  return root;
}

function storageWith(localPath: string | null): StorageService {
  return {
    getProject: async () => ({ id: "project-1", localPath }),
  } as unknown as StorageService;
}

afterEach(async () => {
  mock.restore();
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("resolveProjectGitRoot", () => {
  test("resolves a repository root", async () => {
    const root = await tempRoot();
    await runCommand("git", ["init", "-q", root], { timeoutMs: 10_000 });
    expect(await resolveProjectGitRoot(storageWith(root), "project-1")).toBe(await realpath(root));
  });

  test("names the path and machine when the checkout does not exist", async () => {
    const missing = path.join(await tempRoot(), "orkestrator-v2");
    const failure = resolveProjectGitRoot(storageWith(missing), "project-1");
    await expect(failure).rejects.toThrow(
      `The project's local checkout does not exist: ${missing} on ${os.hostname()}. `,
    );
    await expect(failure).rejects.toThrow("remove and re-add the project to clone it again");
  });

  // Root bypasses directory permissions, so the checkout stays readable there.
  test.skipIf(process.getuid?.() === 0)(
    "reports a checkout it has no permission to open",
    async () => {
      const root = await tempRoot();
      const checkout = path.join(root, "orkestrator-v2");
      await chmod(root, 0o000);
      await expect(resolveProjectGitRoot(storageWith(checkout), "project-1")).rejects.toThrow(
        `Orkestrator does not have permission to open the project's local checkout: ${checkout} on ${os.hostname()}`,
      );
    },
  );

  test("names the checkout when the folder is not a repository", async () => {
    const root = await tempRoot();
    await expect(resolveProjectGitRoot(storageWith(root), "project-1")).rejects.toThrow(
      `The project's local checkout is not a Git repository: ${root} on ${os.hostname()}`,
    );
  });

  test("explains a checkout path inside a repository", async () => {
    const root = await realpath(await tempRoot());
    await runCommand("git", ["init", "-q", root], { timeoutMs: 10_000 });
    const nested = path.join(root, "nested");
    await mkdir(nested);
    const failure = resolveProjectGitRoot(storageWith(nested), "project-1");
    await expect(failure).rejects.toThrow(
      `a folder inside a Git repository, not its root: ${nested} on ${os.hostname()}`,
    );
    await expect(failure).rejects.toThrow(`The repository root is ${root}.`);
  });

  test.each([
    [
      new CommandFailedError("spawn git ENOENT", { executableMissing: true }),
      "Git is not installed or available on PATH",
    ],
    [
      new CommandFailedError("", { timedOut: true }),
      "Git timed out reading the project's local checkout",
    ],
    [
      new CommandFailedError("fatal: detected dubious ownership in repository", { exitCode: 128 }),
      "Change the folder's owner, or add it to Git's safe.directory setting.",
    ],
    [
      new CommandFailedError("fatal: cannot read config", { exitCode: 128 }),
      "Could not read the project's local checkout",
    ],
  ])("classifies Git runner failure %s", async (failure, expected) => {
    const root = await tempRoot();
    const runner = spyOn(shell, "runCommand").mockRejectedValueOnce(failure);
    const error = await resolveProjectGitRoot(storageWith(root), "project-1").catch(
      (error: Error) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).toContain(os.hostname());
    if (!failure.executableMissing) expect((error as Error).message).toContain(root);
    expect(runner).toHaveBeenCalledWith("git", ["rev-parse", "--show-toplevel"], {
      cwd: await realpath(root),
      timeoutMs: 10_000,
    });
  });

  test("classifies a root removed after Git reports its toplevel", async () => {
    const root = await tempRoot();
    spyOn(shell, "runCommand").mockImplementationOnce(async () => {
      await rm(root, { recursive: true });
      return { stdout: root + "\n", stderr: "" };
    });
    await expect(resolveProjectGitRoot(storageWith(root), "project-1")).rejects.toThrow(
      `The project's local checkout does not exist: ${root} on ${os.hostname()}`,
    );
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "classifies a permission failure from Git after realpath succeeds",
    async () => {
      const root = await tempRoot();
      await runCommand("git", ["init", "-q", root]);
      const run = shell.runCommand;
      const canonicalRoot = await realpath(root);
      const runner = spyOn(shell, "runCommand").mockImplementationOnce(async (...args) => {
        // Revoke access after the resolver's first realpath, before spawning Git.
        expect(args[2]?.cwd).toBe(canonicalRoot);
        await chmod(root, 0o000);
        return run(...args);
      });
      await expect(resolveProjectGitRoot(storageWith(root), "project-1")).rejects.toThrow(
        `Orkestrator does not have permission to open the project's local checkout: ${root} on ${os.hostname()}`,
      );
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  test("still reports a project without a checkout", async () => {
    await expect(resolveProjectGitRoot(storageWith(null), "project-1")).rejects.toThrow(
      "This project has no local checkout configured",
    );
  });
});
