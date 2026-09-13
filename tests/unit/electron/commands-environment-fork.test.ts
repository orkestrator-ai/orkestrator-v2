import { describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const {
  createCommandRegistry,
  createContext,
  createEnvironment,
  createGitWorktreeWithOrigin,
  createTempDir,
  currentGitCommit,
  fs,
  path,
  runGit,
} = await createCommandFixtures();

import type { Environment } from "./command-fixtures";

describe("fork_environment", () => {
  test("rejects a missing source environment", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();

    await expect(
      commands.get("fork_environment")?.(
        { environmentId: "missing", environmentType: "local" },
        context,
      ),
    ).rejects.toThrow("Environment not found: missing");
  });

  test("rejects a local fork when the project has no checkout", async () => {
    const source = createEnvironment({
      id: "env-source",
      name: "source",
      environmentType: "local",
      worktreePath: undefined,
      createdFromCommit: "a".repeat(40),
    });
    const { context } = createContext(source);
    const commands = createCommandRegistry();

    await expect(
      commands.get("fork_environment")?.(
        { environmentId: source.id, environmentType: "local" },
        context,
      ),
    ).rejects.toThrow("Project has no local path - cannot create a local worktree");
  });

  test("forks from the source worktree HEAD instead of origin/main", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "environment work\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "environment work"]);
    const sourceHead = await currentGitCommit(worktree);
    const originMain = await runGit(worktree, ["rev-parse", "origin/main"]);
    expect(sourceHead).not.toBe(originMain);

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "local",
      worktreePath: worktree,
      status: "running",
    });
    const { context } = createContext(source, {
      project: {
        id: "project-1",
        name: "Project",
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "local" },
      context,
    )) as Environment;

    expect(forked.name).toBe("feature-env-fork");
    expect(forked.environmentType).toBe("local");
    expect(forked.delegationBaseBranch).toBe("feature/source");
    expect(forked.delegationBaseCommit).toBe(sourceHead);
    expect(forked.id).not.toBe(source.id);
    expect((await context.storage.getEnvironment(forked.id))?.delegationBaseCommit).toBe(
      sourceHead,
    );
  });

  test("creates a container fork from the same source commit", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "published work\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "published work"]);
    await runGit(worktree, ["push", "-u", "origin", "feature/source"]);
    const sourceHead = await currentGitCommit(worktree);

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "local",
      worktreePath: worktree,
      status: "running",
    });
    const { context } = createContext(source, {
      project: {
        id: "project-1",
        name: "Project",
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "containerized" },
      context,
    )) as Environment;

    expect(forked.environmentType).toBe("containerized");
    expect(forked.delegationBaseCommit).toBe(sourceHead);
    expect(forked.delegationBaseBranch).toBe("feature/source");
  });

  test("refuses a container fork of unpublished local work", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "unpublished\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "unpublished"]);

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "local",
      worktreePath: worktree,
      status: "running",
    });
    const { context } = createContext(source, {
      project: {
        id: "project-1",
        name: "Project",
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();

    await expect(
      commands.get("fork_environment")?.(
        { environmentId: source.id, environmentType: "containerized" },
        context,
      ),
    ).rejects.toThrow("published to a remote");
    await expect(context.storage.getEnvironmentsByProject("project-1")).resolves.toEqual([source]);
  });

  test("starts a local fork from the source commit rather than origin/main", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "environment work\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "environment work"]);
    const sourceHead = await currentGitCommit(worktree);
    const worktrees = await createTempDir("ork-fork-worktrees-");

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "local",
      worktreePath: worktree,
      status: "running",
    });
    const { context } = createContext(source, {
      project: {
        id: "project-1",
        name: "Project",
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    context.worktreeDir = worktrees;
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "local" },
      context,
    )) as Environment;

    await commands.get("start_environment")?.({ environmentId: forked.id }, context);

    const started = await context.storage.getEnvironment(forked.id);
    expect(started?.worktreePath).toBeTruthy();
    expect(started?.createdFromCommit).toBe(sourceHead);
    expect(await currentGitCommit(started!.worktreePath!)).toBe(sourceHead);
    expect(await fs.readFile(path.join(started!.worktreePath!, "tracked.txt"), "utf8")).toBe(
      "environment work\n",
    );
  });

  test("suffixes a fork name when the default slug is already used", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const sourceHead = await currentGitCommit(worktree);
    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "main",
      environmentType: "local",
      worktreePath: worktree,
      status: "running",
    });
    const existing = createEnvironment({
      id: "env-existing-fork",
      name: "feature-env-fork",
      branch: "feature-env-fork",
      environmentType: "local",
    });
    const { context } = createContext([source, existing], {
      project: {
        id: "project-1",
        name: "Project",
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "local" },
      context,
    )) as Environment;

    expect(forked.name).toBe("feature-env-fork-1");
    expect(forked.delegationBaseCommit).toBe(sourceHead);
  });
});
