import { afterEach, describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const {
  ASYNC_TEST_BUDGET_MS,
  createCommandRegistry,
  createContext,
  createEnvironment,
  createGitWorktreeWithOrigin,
  createTempDir,
  currentGitCommit,
  fs,
  gitOutput,
  path,
  runGit,
} = await createCommandFixtures();

import type { Environment } from "./command-fixtures";
import {
  environmentForkHooks,
  resolveEnvironmentForkBase,
} from "../../../apps/backend/src/core/commands-environment-fork";

const originalIsContainerRunning = environmentForkHooks.isContainerRunning;
const originalReadContainerHeadCommit = environmentForkHooks.readContainerHeadCommit;

afterEach(() => {
  environmentForkHooks.isContainerRunning = originalIsContainerRunning;
  environmentForkHooks.readContainerHeadCommit = originalReadContainerHeadCommit;
});

function stubRunningContainer(commit: string | undefined, running = true): void {
  environmentForkHooks.isContainerRunning = async () => running;
  environmentForkHooks.readContainerHeadCommit = async () => commit;
}

async function cloneFromRemote(remote: string): Promise<string> {
  const parent = await createTempDir("ork-fork-clone-");
  await runGit(parent, ["clone", remote, "workspace"]);
  const workspace = path.join(parent, "workspace");
  await runGit(workspace, ["config", "user.name", "Test User"]);
  await runGit(workspace, ["config", "user.email", "test@example.com"]);
  return workspace;
}

async function projectFor(
  remote: string,
  localPath: string | null,
): Promise<{
  id: string;
  name: string;
  gitUrl: string;
  localPath: string | null;
  addedAt: string;
  order: number;
}> {
  return {
    id: "project-1",
    name: "Project",
    gitUrl: remote,
    localPath,
    addedAt: new Date(0).toISOString(),
    order: 0,
  };
}

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
      project: await projectFor(remote, worktree),
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

  test("does not copy uncommitted work onto the fork baseline", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "committed\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "committed"]);
    const sourceHead = await currentGitCommit(worktree);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "dirty working tree\n");
    await fs.writeFile(path.join(worktree, "untracked.txt"), "uncommitted\n");

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "local",
      worktreePath: worktree,
      status: "running",
    });
    const { context } = createContext(source, {
      project: await projectFor(remote, worktree),
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "local" },
      context,
    )) as Environment;

    expect(forked.delegationBaseCommit).toBe(sourceHead);
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
      project: await projectFor(remote, worktree),
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
      project: await projectFor(remote, worktree),
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

  test("copies source configuration onto a same-type container fork", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "published work\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "published work"]);
    await runGit(worktree, ["push", "-u", "origin", "feature/source"]);

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
      status: "running",
      networkAccessMode: "full",
      portMappings: [{ hostPort: 4173, containerPort: 5173, protocol: "tcp" }],
      allowedDomains: ["example.test"],
      buildPipelineId: "pipeline-source",
      entryPort: 4173,
      agentSettings: { defaultAgent: "codex" },
    });
    stubRunningContainer(await currentGitCommit(worktree));
    const { context } = createContext(source, {
      project: await projectFor(remote, worktree),
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "containerized" },
      context,
    )) as Environment;

    expect(forked.networkAccessMode).toBe("full");
    expect(forked.portMappings).toEqual([{ hostPort: 4173, containerPort: 5173, protocol: "tcp" }]);
    expect(forked.allowedDomains).toEqual(["example.test"]);
    expect(forked.buildPipelineId).toBe("pipeline-source");
    expect(forked.entryPort).toBe(4173);
    expect(forked.agentSettings).toEqual({ defaultAgent: "codex" });
  });

  test("does not give a local-to-container fork implicit full network access", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "published work\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "published work"]);
    await runGit(worktree, ["push", "-u", "origin", "feature/source"]);

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "local",
      worktreePath: worktree,
      status: "running",
      networkAccessMode: "full",
    });
    const { context } = createContext(source, {
      project: await projectFor(remote, worktree),
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "containerized" },
      context,
    )) as Environment;

    expect(forked.networkAccessMode).toBe("restricted");
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
      project: await projectFor(remote, worktree),
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
      project: await projectFor(remote, worktree),
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "local" },
      context,
    )) as Environment;

    expect(forked.name).toBe("feature-env-fork-1");
    expect(forked.delegationBaseCommit).toBe(sourceHead);
  });

  test("rejects a container fork from a remote-only project when the commit is unpublished", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const container = await cloneFromRemote(remote);
    await runGit(container, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(container, "tracked.txt"), "container only\n");
    await runGit(container, ["add", "tracked.txt"]);
    await runGit(container, ["commit", "-m", "container only"]);
    const unpublished = await currentGitCommit(container);

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
      status: "running",
    });
    stubRunningContainer(unpublished);
    const { context } = createContext(source, {
      project: await projectFor(remote, null),
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

  test("forks a container from a remote-only project when the commit is on the remote", async () => {
    const { remote } = await createGitWorktreeWithOrigin();
    const container = await cloneFromRemote(remote);
    await runGit(container, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(container, "tracked.txt"), "published from container\n");
    await runGit(container, ["add", "tracked.txt"]);
    await runGit(container, ["commit", "-m", "published from container"]);
    await runGit(container, ["push", "-u", "origin", "feature/source"]);
    const published = await currentGitCommit(container);

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
      status: "running",
    });
    stubRunningContainer(published);
    const { context } = createContext(source, {
      project: await projectFor(remote, null),
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "containerized" },
      context,
    )) as Environment;

    expect(forked.environmentType).toBe("containerized");
    expect(forked.delegationBaseCommit).toBe(published);
    expect(forked.delegationBaseBranch).toBe("feature/source");
  });

  test("forks a container after a remote query when the host checkout has not fetched", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const container = await cloneFromRemote(remote);
    await runGit(container, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(container, "tracked.txt"), "published from container\n");
    await runGit(container, ["add", "tracked.txt"]);
    await runGit(container, ["commit", "-m", "published from container"]);
    await runGit(container, ["push", "-u", "origin", "feature/source"]);
    const published = await currentGitCommit(container);
    const hostRemotes = await gitOutput(worktree, [
      "for-each-ref",
      `--contains=${published}`,
      "--format=%(refname)",
      "refs/remotes",
    ]).catch(() => "");
    expect(hostRemotes).toBe("");

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
      status: "running",
    });
    stubRunningContainer(published);
    const { context } = createContext(source, {
      project: await projectFor(remote, worktree),
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "containerized" },
      context,
    )) as Environment;

    expect(forked.delegationBaseCommit).toBe(published);
    expect(forked.environmentType).toBe("containerized");
  });

  test("rejects an unpublished container HEAD before creating an environment", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const container = await cloneFromRemote(remote);
    await runGit(container, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(container, "tracked.txt"), "still local\n");
    await runGit(container, ["add", "tracked.txt"]);
    await runGit(container, ["commit", "-m", "still local"]);
    const unpublished = await currentGitCommit(container);

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
      status: "running",
    });
    stubRunningContainer(unpublished);
    const { context } = createContext(source, {
      project: await projectFor(remote, worktree),
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

  test("surfaces a remote query failure as could-not-verify instead of unpublished", async () => {
    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
      createdFromCommit: "a".repeat(40),
      status: "running",
    });
    stubRunningContainer("a".repeat(40));
    const { context } = createContext(source, {
      project: {
        id: "project-1",
        name: "Project",
        gitUrl: "https://invalid.invalid/missing.git",
        localPath: null,
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
    ).rejects.toThrow("Could not verify that the current commit is published to a remote");
    await expect(context.storage.getEnvironmentsByProject("project-1")).resolves.toEqual([source]);
  });

  test("rejects a local fork when the project checkout does not have the commit", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "source only\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "source only"]);
    const host = await cloneFromRemote(remote);

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "local",
      worktreePath: worktree,
      status: "running",
    });
    const { context } = createContext(source, {
      project: await projectFor(remote, host),
    });
    const commands = createCommandRegistry();

    await expect(
      commands.get("fork_environment")?.(
        { environmentId: source.id, environmentType: "local" },
        context,
      ),
    ).rejects.toThrow("not available in the project checkout");
    await expect(context.storage.getEnvironmentsByProject("project-1")).resolves.toEqual([source]);
  });

  test("fetches a published commit into a stale host checkout before a local fork", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const container = await cloneFromRemote(remote);
    await runGit(container, ["checkout", "-b", "feature/source"]);
    await fs.writeFile(path.join(container, "tracked.txt"), "published from container\n");
    await runGit(container, ["add", "tracked.txt"]);
    await runGit(container, ["commit", "-m", "published from container"]);
    await runGit(container, ["push", "-u", "origin", "feature/source"]);
    const published = await currentGitCommit(container);
    await expect(gitOutput(worktree, ["cat-file", "-t", published])).rejects.toThrow();

    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
      status: "running",
    });
    stubRunningContainer(published);
    const { context } = createContext(source, {
      project: await projectFor(remote, worktree),
    });
    const commands = createCommandRegistry();

    const forked = (await commands.get("fork_environment")?.(
      { environmentId: source.id, environmentType: "local" },
      context,
    )) as Environment;

    expect(forked.environmentType).toBe("local");
    expect(forked.delegationBaseCommit).toBe(published);
  });

  test("reads HEAD from a running container source", async () => {
    const commit = "b".repeat(40);
    stubRunningContainer(commit);
    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
    });

    await expect(resolveEnvironmentForkBase(source, { localPath: null })).resolves.toEqual({
      branch: "feature/source",
      commit,
    });
  });

  test("requires a running container before forking its current work", async () => {
    stubRunningContainer(undefined, false);
    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
    });

    await expect(resolveEnvironmentForkBase(source, { localPath: null })).rejects.toThrow(
      "Start this environment before forking",
    );
  });

  test("rejects a container source whose HEAD cannot be read", async () => {
    stubRunningContainer(undefined, true);
    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/source",
      environmentType: "containerized",
      containerId: "ctr-source",
      worktreePath: undefined,
    });

    await expect(resolveEnvironmentForkBase(source, { localPath: null })).rejects.toThrow(
      "Could not read HEAD from environment env-source",
    );
  });

  test(
    "falls back to the project checkout when a local worktree has vanished",
    async () => {
      const { worktree, remote } = await createGitWorktreeWithOrigin();
      const vanished = path.join(await createTempDir("ork-fork-vanished-"), "missing");
      const source = createEnvironment({
        id: "env-source",
        name: "feature-env",
        branch: "main",
        environmentType: "local",
        worktreePath: vanished,
      });

      // Resolve the expected value before starting the subject. If the generic
      // outer test deadline fires while both Git subprocesses contend for CPU,
      // fixture cleanup can remove the repository from under the still-running
      // subject and turn the timeout into an unhandled rejection.
      const expectedCommit = await currentGitCommit(worktree);
      await expect(resolveEnvironmentForkBase(source, { localPath: worktree })).resolves.toEqual({
        branch: "main",
        commit: expectedCommit,
      });
      expect(remote).toBeTruthy();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("uses a recorded commit when the checkout and branch are unavailable", async () => {
    const recorded = "c".repeat(40);
    const vanished = path.join(await createTempDir("ork-fork-vanished-"), "missing");
    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/gone",
      environmentType: "local",
      worktreePath: vanished,
      createdFromCommit: recorded,
    });

    await expect(resolveEnvironmentForkBase(source, { localPath: null })).resolves.toEqual({
      branch: "feature/gone",
      commit: recorded,
    });
  });

  test("uses delegationBaseCommit when createdFromCommit is absent", async () => {
    const recorded = "d".repeat(40);
    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/gone",
      environmentType: "local",
      worktreePath: undefined,
      delegationBaseCommit: recorded,
    });

    await expect(resolveEnvironmentForkBase(source, { localPath: null })).resolves.toEqual({
      branch: "feature/gone",
      commit: recorded,
    });
  });

  test("throws when the current commit cannot be determined", async () => {
    const source = createEnvironment({
      id: "env-source",
      name: "feature-env",
      branch: "feature/gone",
      environmentType: "local",
      worktreePath: undefined,
      createdFromCommit: "not-a-commit",
    });

    await expect(resolveEnvironmentForkBase(source, { localPath: null })).rejects.toThrow(
      "Cannot determine this environment's current commit",
    );
  });
});
