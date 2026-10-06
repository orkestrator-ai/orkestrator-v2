import {
  COORDINATOR_WORKSPACE_VERSION,
  COORDINATOR_EXECUTION_POLICY,
} from "@orkestrator/protocol/coordinator";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createNonInteractiveGitFixture } from "./git-noninteractive-test-support.js";
import { createLocalWorktree } from "./commands-environment.js";
import { assertForkCommitUsable } from "./commands-environment-fork.js";
import { gitFetchScheduler } from "./commands-runtime-state.js";
import { ProjectGitService } from "./project-git-service.js";
import { createProject, StorageService } from "./storage.js";
import { runCommand } from "./shell.js";
import { runRemoteGit } from "./git-noninteractive-env.js";

jest.setTimeout(30_000);
let fixture: Awaited<ReturnType<typeof createNonInteractiveGitFixture>>;
let saved: NodeJS.ProcessEnv;

beforeEach(async () => {
  fixture = await createNonInteractiveGitFixture();
  saved = { ...process.env };
  process.env.GIT_CONFIG_GLOBAL = fixture.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH;
  // Repo-scoped configuration proves callers resolve from their own cwd.
  await fixture.git(["config", "core.sshCommand", `${fixture.command} -o BatchMode=no`]);
  await fixture.git(["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
});

afterEach(async () => {
  gitFetchScheduler.forget(fixture.repo);
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND", "GIT_SSH"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await fixture.cleanup();
});

function expectBatch(log: string) {
  expect(log).toContain("0 -o BatchMode=yes -o BatchMode=no");
  expect(log).toContain("git-upload-pack");
}

describe("backend remote Git callers", () => {
  test("worktree creation fails promptly with the SSH authentication error", async () => {
    await expect(
      createLocalWorktree(
        fixture.repo,
        "project",
        "new-branch",
        "main",
        [],
        path.join(fixture.root, "worktrees"),
      ),
    ).rejects.toThrow("Permission denied (publickey)");
    expectBatch(await fixture.readLog());
    expect((await fixture.git(["worktree", "list", "--porcelain"])).stdout).not.toContain(
      "new-branch",
    );
  });

  test("scheduled fetch uses the worktree SSH config even without a mounted UI", async () => {
    await gitFetchScheduler.ensureFetched(fixture.repo, "main");
    expectBatch(await fixture.readLog());
    const firstLog = await fixture.readLog();
    // A failure still respects the scheduler TTL, avoiding repeated auth attempts.
    await gitFetchScheduler.ensureFetched(fixture.repo, "main");
    expect(await fixture.readLog()).toBe(firstLog);
  });

  test("project fetch and sync preserve actionable errors and restore idle state", async () => {
    const storage = new StorageService(path.join(fixture.root, "data"));
    await storage.init();
    const project = await storage.addProject(
      createProject("git@example.invalid:owner/repo.git", fixture.repo),
    );
    await fixture.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await fixture.git(["branch", "--set-upstream-to=origin/main", "main"]);
    await storage.mutateCoordinatorWorkspace(project.id, () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      id: "test-coordinator",
      projectId: project.id,
      executionPolicy: COORDINATOR_EXECUTION_POLICY,
      lifecycleState: "ready",
      conversations: [],
      selectedConversationId: null,
      repositoryContextRevision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const service = new ProjectGitService(storage);
    const result = await service.fetch(project.id, true);
    expect(result).toMatchObject({ operationState: "idle", remoteState: "stale" });
    expect(result.lastError?.message).toContain("Permission denied (publickey)");
    await expect(service.sync(project.id)).rejects.toThrow("Permission denied (publickey)");
    expect(service.isMutationActive(project.id)).toBe(false);
    const restored = await service.status(project.id);
    expect(restored.operationState).toBe("idle");
    expect(restored.lastError?.message).toContain("Permission denied (publickey)");
    expectBatch(await fixture.readLog());
    expect((await fixture.readLog()).split("git-upload-pack")).toHaveLength(3);
  });

  test("fork publication lookup uses the global SSH command without a checkout", async () => {
    await fixture.git([
      "config",
      "--global",
      "core.sshCommand",
      `${fixture.command} -o BatchMode=no`,
    ]);
    await expect(
      assertForkCommitUsable(
        { localPath: null, gitUrl: "git@example.invalid:owner/repo.git" },
        "a".repeat(40),
        "containerized",
      ),
    ).rejects.toThrow("Could not verify");
    expectBatch(await fixture.readLog());
  });

  test("fork fetch applies the environment to origin and remote URL fallback", async () => {
    await expect(
      assertForkCommitUsable(
        { localPath: fixture.repo, gitUrl: "git@example.invalid:owner/fallback.git" },
        "a".repeat(40),
        "local",
      ),
    ).rejects.toThrow("Fetch the project checkout");
    const log = await fixture.readLog();
    expectBatch(log);
    expect(log).toContain("owner/repo.git");
    expect(log).toContain("owner/fallback.git");
    expect(log.split("git-upload-pack")).toHaveLength(3);
  });

  test("project fetch and pull do not replace submodule SSH configuration", async () => {
    const subSource = path.join(fixture.root, "sub-source");
    await fs.mkdir(subSource);
    await fixture.git(["init", "-q", "-b", "main"], subSource);
    await fixture.git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-qm",
        "submodule",
      ],
      subSource,
    );
    await fixture.git(["-c", "protocol.file.allow=always", "submodule", "add", subSource, "sub"]);
    await fixture.git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--no-gpg-sign",
      "-qam",
      "add submodule",
    ]);
    const parentRemote = path.join(fixture.root, "parent.git");
    await fixture.git(["clone", "--bare", fixture.repo, parentRemote]);
    await fixture.git(["remote", "set-url", "origin", parentRemote]);
    await fixture.git(["fetch", "origin"]);
    await fixture.git(["branch", "--set-upstream-to=origin/main", "main"]);
    const sub = path.join(fixture.repo, "sub");
    const marker = path.join(fixture.root, "submodule-ssh.log");
    const wrapper = path.join(fixture.root, "submodule-ssh");
    await fs.writeFile(wrapper, `#!/bin/sh\necho own-deploy-key >> '${marker}'\nexit 255\n`);
    await fs.chmod(wrapper, 0o755);
    await fixture.git(["config", "core.sshCommand", wrapper], sub);
    await fixture.git(["remote", "set-url", "origin", "git@example.invalid:owner/sub.git"], sub);
    await fixture.git(["config", "fetch.recurseSubmodules", "true"]);
    await fixture.git(["config", "submodule.recurse", "true"]);
    await fixture.git(["config", "submodule.sub.fetchRecurseSubmodules", "true"]);

    await runRemoteGit("fetch", ["origin"], { cwd: fixture.repo });
    await runRemoteGit("pull", ["--ff-only", "origin", "main"], { cwd: fixture.repo });
    await expect(fs.access(marker)).rejects.toThrow();
    expect(await fixture.readLog()).toBe("");
    // Submodules remain independently fetchable using their own deploy key.
    await runCommand("git", ["fetch", "origin"], { cwd: sub, timeoutMs: 5_000 }).catch(
      () => undefined,
    );
    expect(await fs.readFile(marker, "utf8")).toContain("own-deploy-key");
  });
});
