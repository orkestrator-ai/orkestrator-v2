import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as shell from "./shell.js";
import {
  diffBaseGitForEnvironment,
  listDiffBaseBranches,
  resolveDiffBaseOverride,
} from "./diff-base-override.js";
import { createEnvironment } from "./storage.js";
import { createPublicApiHarness, headCommit } from "./public-api/test-support.js";
import { environmentBaselineCommit } from "@orkestrator/protocol/diff-stats";
import { discardedRuntimeSetupUpdates } from "./commands-environment.js";

// Exercise real Git, storage, command registration, scan targeting and file restoration.
test("saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base", async () => {
  const h = await createPublicApiHarness();
  try {
    const { projectPath, originPath } = await h.createRepository("comparison");
    const initial = await headCommit(projectPath);
    const file = path.join(projectPath, "README.md");
    const git = (args: string[]) => shell.runCommand("git", ["-C", projectPath, ...args]);
    await fs.writeFile(file, "unpushed base\n");
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Unpushed base",
    ]);
    const unpushed = await headCommit(projectPath);
    const environment = await h.storage.addEnvironment({
      ...createEnvironment("project", { environmentType: "local" }),
      worktreePath: projectPath,
      createdFromCommit: initial,
      status: "running",
    });
    const command = (name: string, args: Record<string, unknown>) =>
      h.commands.get(name)!(args, h.context);
    const read = (worktreePath: string, comparisonRef: string) =>
      h.context.runtime.diffStats.service.readFileList({
        lookup: { worktreePath },
        comparisonRef,
        includeUncommitted: true,
        refresh: true,
      });
    await command("set_environment_diff_base", {
      environmentId: environment.id,
      ref: "refs/heads/main",
      commit: unpushed,
    });
    expect((await h.storage.getEnvironment(environment.id))?.diffBaseOverride?.commit).toBe(
      unpushed,
    );
    await read(projectPath, unpushed);
    expect(
      h.context.runtime.diffStats.service
        .revisionedWorktreeSnapshot()
        .entries.find((e) => e.environmentId === environment.id)?.comparisonRef,
    ).toBe(unpushed);
    await fs.writeFile(file, "dirty\n");
    await command("revert_local_file", {
      environmentId: environment.id,
      filePath: "README.md",
      targetBranch: unpushed,
    });
    expect(await fs.readFile(file, "utf8")).toBe("unpushed base\n");
    await command("set_environment_diff_base", {
      environmentId: environment.id,
      ref: null,
      commit: null,
    });
    await read(projectPath, initial);
    expect(
      h.context.runtime.diffStats.service
        .revisionedWorktreeSnapshot()
        .entries.find((e) => e.environmentId === environment.id)?.comparisonRef,
    ).toBe(initial);
    await command("revert_local_file", {
      environmentId: environment.id,
      filePath: "README.md",
      targetBranch: initial,
    });
    expect(await fs.readFile(file, "utf8")).toBe("# comparison\n");
    await command("set_environment_diff_base", {
      environmentId: environment.id,
      ref: "refs/heads/main",
      commit: unpushed,
    });
    const replacement = path.join(h.root, "replacement");
    await shell.runCommand("git", ["clone", originPath, replacement]);
    const freshGit = diffBaseGitForEnvironment({
      environmentType: "local",
      worktreePath: replacement,
      containerId: null,
      status: "running",
    });
    await expect(freshGit(["cat-file", "-e", unpushed])).rejects.toThrow();
    const replaced = await h.storage.updateEnvironment(environment.id, {
      ...discardedRuntimeSetupUpdates(),
      worktreePath: replacement,
    });
    expect(replaced.diffBaseOverride).toBeNull();
    expect(environmentBaselineCommit(replaced)).toBeUndefined();
    await h.context.runtime.diffStats.sync(h.context);
    await read(replacement, "main");
    await fs.writeFile(path.join(replacement, "README.md"), "dirty again\n");
    await command("revert_local_file", {
      environmentId: environment.id,
      filePath: "README.md",
      targetBranch: "main",
    });
    expect(await fs.readFile(path.join(replacement, "README.md"), "utf8")).toBe("# comparison\n");
    expect(await listDiffBaseBranches(freshGit)).toContainEqual({
      ref: "refs/heads/main",
      name: "main",
      kind: "local",
    });
    await expect(
      resolveDiffBaseOverride(freshGit, { ref: "refs/heads/main", commit: unpushed }),
    ).rejects.toThrow("not in this environment's checkout");
    const missingGit = diffBaseGitForEnvironment({
      ...replaced,
      worktreePath: path.join(h.root, "missing"),
    });
    await expect(listDiffBaseBranches(missingGit)).rejects.toThrow();
    expect(() => diffBaseGitForEnvironment({ ...replaced, worktreePath: undefined })).toThrow(
      "no checkout",
    );
  } finally {
    await h.cleanup();
  }
}, 30_000);

test("container Git quotes arguments, selects /workspace and rejects stopped runtimes", async () => {
  const environment = {
    environmentType: "containerized" as const,
    worktreePath: undefined,
    containerId: "container",
    status: "running" as const,
  };
  const run = spyOn(shell, "runCommand").mockResolvedValue({ stdout: "result", stderr: "" });
  try {
    expect(
      await diffBaseGitForEnvironment(environment)(["log", "refs/heads/it's-main", "$(touch bad)"]),
    ).toBe("result");
    expect(run).toHaveBeenCalledWith(
      "docker",
      [
        "exec",
        "container",
        "bash",
        "-lc",
        `cd /workspace && git 'log' 'refs/heads/it'"'"'s-main' '$(touch bad)'`,
      ],
      { timeoutMs: 30_000, redactValues: undefined, signal: undefined },
    );
    expect(() => diffBaseGitForEnvironment({ ...environment, status: "stopped" })).toThrow(
      "Start the environment",
    );
    expect(() => diffBaseGitForEnvironment({ ...environment, containerId: null })).toThrow(
      "Start the environment",
    );
  } finally {
    run.mockRestore();
  }
});
