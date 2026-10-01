import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService, createProject } from "./storage.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { startEnvironmentSetupOnce } from "./commands-environment.js";
import { projectHomeTesting } from "./project-home-environment.js";
import { runCommand } from "./shell.js";
import type { Environment } from "./models.js";
import { diffStatsService } from "./commands-runtime-state.js";
import {
  deleteMergedEnvironmentRemoteBranch,
  startEnvironmentOnce,
} from "./commands-environment.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { ProjectGitService } from "./project-git-service.js";
import { NativeAgentService } from "./native-agent-service.js";
import type { NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import {
  wakePrMonitorForCompletion,
  requestPrMonitorRefresh,
  projectHomePrTarget,
  detectEnvironmentPullRequest,
  prMonitorService,
} from "./commands-pr-monitor.js";

let root: string;
let checkout: string;
let storage: StorageService;
let context: CommandContext;
let projectId: string;
let commands: ReturnType<typeof createCommandRegistry>;

const ensure = async () => {
  const environment = (await commands.get("ensure_project_home_environment")!(
    { projectId },
    context,
  )) as Environment;
  // This suite drives Git directly; watcher behavior has its own integration suite.
  diffStatsService.untrack(environment.id);
  return environment;
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-project-home-"));
  checkout = path.join(root, "checkout");
  await mkdir(checkout);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
  ])
    await runCommand("git", args, { cwd: checkout });
  await writeFile(path.join(checkout, "README.md"), "fixture\n");
  await runCommand("git", ["add", "."], { cwd: checkout });
  await runCommand("git", ["commit", "-m", "fixture"], { cwd: checkout });
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  projectId = (await storage.addProject(createProject("remote", checkout))).id;
  context = {
    storage,
    emit: () => undefined,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    worktreeDir: path.join(root, "workspaces"),
  } as unknown as CommandContext;
  commands = createCommandRegistry();
});

afterEach(async () => {
  projectHomeTesting.reset();
  // Ensuring a home starts tracking it; stop before its checkout is removed.
  for (const id of diffStatsService.trackedIds()) diffStatsService.untrack(id);
  prMonitorService.sync([]);
  await rm(root, { recursive: true, force: true });
});

test("ensure creates one ready home in the project checkout and reuses it", async () => {
  const home = await ensure();

  expect(home).toMatchObject({
    projectId,
    projectHome: true,
    environmentType: "local",
    worktreePath: await realpath(checkout),
    branch: "main",
    status: "running",
    setupPhase: "ready",
  });
  expect((await ensure()).id).toBe(home.id);
  expect(await storage.getEnvironmentsByProject(projectId)).toHaveLength(1);
});

test("ensure follows a branch switched in the checkout", async () => {
  const home = await ensure();
  await runCommand("git", ["switch", "-c", "feature/root-work"], { cwd: checkout });

  const refreshed = await ensure();

  expect(refreshed.id).toBe(home.id);
  expect(refreshed.branch).toBe("feature/root-work");
});

test("ensure refuses a project without a checkout", async () => {
  const bare = await storage.addProject(createProject("remote-2"));
  await expect(
    commands.get("ensure_project_home_environment")!({ projectId: bare.id }, context),
  ).rejects.toThrow("no local checkout");
});

test("setup scripts never run against the project checkout", async () => {
  const home = await ensure();
  // Simulate a record whose setup state was reset (e.g. by a retry action).
  await storage.updateEnvironment(home.id, { setupScriptsComplete: false, setupPhase: "pending" });

  const result = await startEnvironmentSetupOnce((await storage.getEnvironment(home.id))!, context);

  expect(result.setupStarted).toBe(false);
  expect(result.environment).toMatchObject({ setupScriptsComplete: true, setupPhase: "ready" });
});

async function fakeGh(
  list: string = '[{"url":"https://github.com/org/repo/pull/1","state":"MERGED","headRefName":"main","baseRefName":"other","isCrossRepository":true}]',
): Promise<{ log: () => Promise<string>; restore: () => void }> {
  const bin = path.join(root, "bin");
  const log = path.join(root, "gh.log");
  await mkdir(bin);
  await writeFile(path.join(root, "list.json"), list);
  await writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh
printf '%s %s\\n' "$PWD" "$*" >> '${log}'
case "$*" in
  *list*) cat '${path.join(root, "list.json")}';;
  *headRefName*) printf '%s\\n' '{"url":"https://github.com/org/repo/pull/1","state":"OPEN","headRefName":"feature/A","baseRefName":"main","isCrossRepository":false}';;
  *isDraft*) printf '%s\\n' '{"isDraft":false}';;
  *PUT*) printf '%s\\n' '{"merged":true}';;
  *) printf '%s\\n' '{}';;
esac
`,
    { mode: 0o755 },
  );
  const original = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${original ?? ""}`;
  return {
    log: () => readFile(log, "utf8").catch(() => ""),
    restore: () => {
      process.env.PATH = original;
    },
  };
}

const invoke = (command: string, args: Record<string, unknown>) =>
  commands.get(command)!(args, context);

test("home reads require environment authorization and reject generic, traversal and symlink reads", async () => {
  const home = await ensure();
  await writeFile(path.join(root, "outside.txt"), "outside");
  await symlink(path.join(root, "outside.txt"), path.join(checkout, "escape.txt"));
  expect(
    await invoke("read_environment_file_base64", { environmentId: home.id, filePath: "README.md" }),
  ).toBe(Buffer.from("fixture\n").toString("base64"));
  await expect(
    invoke("read_file_base64", { filePath: path.join(checkout, "README.md") }),
  ).rejects.toThrow();
  for (const filePath of ["../outside.txt", path.join(checkout, "README.md"), "escape.txt"]) {
    await expect(
      invoke("read_environment_file_base64", { environmentId: home.id, filePath }),
    ).rejects.toThrow();
  }
  await expect(
    invoke("read_environment_file_base64", { environmentId: "other", filePath: "README.md" }),
  ).rejects.toThrow();
});

test("home file mutations and reads follow the configured checkout and reject a cleared path", async () => {
  const home = await ensure();
  const other = path.join(root, "checkout-B");
  await runCommand("git", ["clone", checkout, other]);
  await storage.updateProject(projectId, { localPath: other });
  await invoke("delete_local_file", { environmentId: home.id, filePath: "README.md" });
  expect(await readFile(path.join(checkout, "README.md"), "utf8")).toBe("fixture\n");
  await expect(readFile(path.join(other, "README.md"))).rejects.toThrow();
  await storage.updateProject(projectId, { localPath: null });
  await expect(
    invoke("read_environment_file_base64", { environmentId: home.id, filePath: "README.md" }),
  ).rejects.toThrow("no local checkout");
  await expect(
    invoke("delete_local_file", { environmentId: home.id, filePath: "README.md" }),
  ).rejects.toThrow("no local checkout");
});

test("renaming a home preserves the live branch and checkout", async () => {
  const home = await ensure();
  const renamed = (await invoke("rename_environment", {
    environmentId: home.id,
    name: "Release checkout",
  })) as Environment;
  expect(renamed.name).toBe("release-checkout");
  expect(renamed.branch).toBe("main");
  expect(
    (await runCommand("git", ["branch", "--show-current"], { cwd: checkout })).stdout.trim(),
  ).toBe("main");
});

test("starting a home with a missing checkout refuses to create a worktree", async () => {
  const home = await ensure();
  await rm(checkout, { recursive: true, force: true });
  await expect(startEnvironmentOnce(home.id, context, () => undefined)).rejects.toThrow(
    "checkout is unavailable",
  );
  expect(await storage.getEnvironment(home.id)).toMatchObject({ status: "error" });
  await expect(readFile(path.join(context.worktreeDir!, "README.md"))).rejects.toThrow();
});

test("base and detached homes never discover a PR or delete a remote ref", async () => {
  const home = await ensure();
  const gh = await fakeGh();
  try {
    await wakePrMonitorForCompletion(home.id, context);
    await requestPrMonitorRefresh(home.id, context);
    expect((await storage.getEnvironment(home.id))?.prUrl).toBeNull();
    await deleteMergedEnvironmentRemoteBranch({
      ...home,
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "merged",
    });
    const detached = path.join(root, "detached");
    await runCommand("git", ["clone", checkout, detached]);
    await runCommand("git", ["checkout", "--detach"], { cwd: detached });
    await storage.updateProject(projectId, { localPath: detached });
    await wakePrMonitorForCompletion(home.id, context);
    const target = await projectHomePrTarget((await storage.getEnvironment(home.id))!, storage);
    expect(target.ready).toBe(false);
    expect(await gh.log()).toBe("");
  } finally {
    gh.restore();
  }
});

test("toolbar and external switches clear home PR identity before selection, refresh and merge", async () => {
  const home = await ensure();
  const git = new ProjectGitService(storage);
  await runCommand("git", ["branch", "feature/A"], { cwd: checkout });
  await runCommand("git", ["branch", "feature/B"], { cwd: checkout });
  await git.switchBranch(projectId, "refs/heads/feature/A");
  await storage.updateEnvironment(home.id, {
    prUrl: "https://github.com/org/repo/pull/1",
    prState: "open",
  });
  await git.switchBranch(projectId, "refs/heads/feature/B");
  expect(await storage.getEnvironment(home.id)).toMatchObject({ branch: "feature/B", prUrl: null });
  await storage.updateEnvironment(home.id, {
    branch: "feature/A",
    prUrl: "https://github.com/org/repo/pull/1",
    prState: "open",
  });
  expect(await invoke("get_environment", { environmentId: home.id })).toMatchObject({
    branch: "feature/B",
    prUrl: null,
  });
  await storage.updateEnvironment(home.id, {
    branch: "feature/A",
    prUrl: "https://github.com/org/repo/pull/1",
    prState: "open",
  });
  await requestPrMonitorRefresh(home.id, context);
  expect(await storage.getEnvironment(home.id)).toMatchObject({ branch: "feature/B", prUrl: null });
  await storage.updateEnvironment(home.id, {
    branch: "feature/A",
    prUrl: "https://github.com/org/repo/pull/1",
    prState: "open",
  });
  await expect(invoke("merge_pr_local", { environmentId: home.id })).rejects.toThrow(
    "branch changed",
  );
});

for (const command of ["merge_pr_local", "merge_environment_pr"]) {
  test(`${command} merges a home from its checkout and preserves every local and remote branch`, async () => {
    const home = await ensure();
    await runCommand("git", ["switch", "-c", "feature/A"], { cwd: checkout });
    await ensure();
    await storage.updateEnvironment(home.id, {
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    const gh = await fakeGh();
    try {
      const result = await invoke(command, {
        environmentId: home.id,
        cleanupAfterMerge: true,
        deleteBranch: true,
      });
      expect(result).toMatchObject({ outcome: "merged" });
      expect(await readFile(path.join(checkout, "README.md"), "utf8")).toBe("fixture\n");
      expect(
        (await runCommand("git", ["branch", "--show-current"], { cwd: checkout })).stdout.trim(),
      ).toBe("feature/A");
      const log = await gh.log();
      expect(log).toContain(
        `${await realpath(checkout)} api repos/org/repo/pulls/1/merge --method PUT`,
      );
      expect(log).not.toContain("DELETE");
      expect(log).not.toContain("--delete-branch");
      if (command === "merge_environment_pr") {
        expect(result).toMatchObject({ cleanupOutcome: "completed" });
        expect(await storage.getEnvironment(home.id)).toBeNull();
      }
    } finally {
      gh.restore();
    }
  });
}

test("home dispatch and project Git mutations fence each other, including persisted background work after reload", async () => {
  const home = await ensure();
  await runCommand("git", ["branch", "feature/B"], { cwd: checkout });
  let active: "working" | "idle" = "working";
  const provider = {
    agent: "codex",
    createSession: async () => "session-1",
    registerSession: () => undefined,
    send: async () => undefined,
    status: async () => "idle",
    activity: async () => active,
    messages: async () => [],
    structured: async () => null,
    dispose: async () => undefined,
  } as unknown as NativeAgentRuntimeProvider;
  let service: NativeAgentService;
  const git = new ProjectGitService(storage, () => service.hasActiveCheckoutWork(home.id));
  context.projectGit = git;
  const options = {
    provider: async () => provider,
    beginCoordinatorTurn: (id: string) => git.beginCoordinatorTurn(id),
  };
  service = new NativeAgentService(
    storage,
    async () => {
      throw new Error("unexpected invocation");
    },
    options,
  );
  try {
    await service.dispatchPrompt({
      environmentId: home.id,
      agent: "codex",
      logicalSessionKey: "tab-1",
      requestId: "r1",
      prompt: "work",
    });
    await expect(git.switchBranch(projectId, "refs/heads/feature/B")).rejects.toThrow(
      "active coordinator turn",
    );
    await expect(git.sync(projectId)).rejects.toThrow("active coordinator turn");
    await service.shutdown();
    service = new NativeAgentService(
      new StorageService(path.join(root, "data")),
      async () => {
        throw new Error("unexpected invocation");
      },
      options,
    );
    await expect(git.switchBranch(projectId, "refs/heads/feature/B")).rejects.toThrow(
      "active coordinator turn",
    );
    active = "idle";
    const switching = git.switchBranch(projectId, "refs/heads/feature/B");
    await expect(
      service.dispatchPrompt({
        environmentId: home.id,
        agent: "codex",
        logicalSessionKey: "tab-1",
        requestId: "r2",
        prompt: "work",
      }),
    ).rejects.toThrow("checkout is changing");
    await switching;
  } finally {
    await service.shutdown();
  }
});

test("completion discovers only a same-repository PR targeting the home base", async () => {
  await runCommand("git", ["switch", "-c", "feature/A"], { cwd: checkout });
  const home = await ensure();
  const candidate = {
    url: "https://github.com/org/repo/pull/1",
    state: "OPEN",
    mergeable: "MERGEABLE",
    headRefName: "feature/A",
    baseRefName: "main",
    isCrossRepository: false,
  };
  const gh = await fakeGh(
    JSON.stringify([
      { ...candidate, url: "https://github.com/org/repo/pull/2", isCrossRepository: true },
      { ...candidate, url: "https://github.com/org/repo/pull/3", baseRefName: "other" },
      candidate,
    ]),
  );
  try {
    const target = await projectHomePrTarget(home, storage);
    expect((await detectEnvironmentPullRequest(target))?.url).toBe(candidate.url);
    await wakePrMonitorForCompletion(home.id, context);
    const deadline = Date.now() + 3000;
    while (!(await storage.getEnvironment(home.id))?.prUrl && Date.now() < deadline)
      await Bun.sleep(10);
    expect((await storage.getEnvironment(home.id))?.prUrl).toBe(candidate.url);
    expect(await gh.log()).toContain("--head feature/A");
  } finally {
    gh.restore();
  }
});
