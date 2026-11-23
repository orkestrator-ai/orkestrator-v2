import { afterEach, describe, expect, test, mock, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import {
  createLocalWorktree,
  removeLocalWorktree,
  cleanupFailedLocalWorktree,
  showWorktreeSeedRefusalsWithoutSetup,
} from "./commands-environment.js";
import { setupTerminalSessionId } from "./commands-terminal.js";
import {
  rememberWorktreeSeedRefusals,
  takeWorktreeSeedRefusals,
} from "./containers/project-seed-files.js";
import type { Environment } from "./models.js";
import { createEnvironment } from "./storage/shared-core.js";
import type { StorageService } from "./storage/service.js";
import { runCommand } from "./shell.js";
import * as shell from "./shell.js";
import * as remoteGit from "./git/noninteractive-env.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  mock.restore();
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("local worktree removal", () => {
  test("prunes a registered worktree whose directory disappeared", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-project-"));
    const worktreeParent = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-parent-"));
    tempDirectories.push(projectPath, worktreeParent);
    const worktreePath = path.join(worktreeParent, "missing");

    await runCommand("git", ["init", projectPath]);
    await runCommand("git", ["-C", projectPath, "config", "user.name", "Orkestrator Test"]);
    await runCommand("git", ["-C", projectPath, "config", "user.email", "test@example.invalid"]);
    await fs.writeFile(path.join(projectPath, "README.md"), "test\n");
    await runCommand("git", ["-C", projectPath, "add", "README.md"]);
    await runCommand("git", ["-C", projectPath, "commit", "-m", "initial"]);
    await runCommand("git", ["-C", projectPath, "worktree", "add", "-b", "missing", worktreePath]);
    await fs.rm(worktreePath, { recursive: true, force: true });

    await removeLocalWorktree(projectPath, worktreePath);

    const { stdout } = await runCommand("git", [
      "-C",
      projectPath,
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(stdout).not.toContain(worktreePath);
  });
});

for (const cleanup of [false, true]) {
  for (const missing of [false, true]) {
    test(`${cleanup ? "failed creation cleanup" : "removal"} stops daemon before deleting (${missing ? "missing" : "present"})`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-stop-"));
      tempDirectories.push(root);
      const worktree = path.join(root, "worktree");
      if (!missing) await fs.mkdir(worktree);
      const calls: string[][] = [];
      spyOn(shell, "runCommand").mockImplementation(async (_command, args = []) => {
        calls.push(args);
        if (args.includes("fsmonitor--daemon")) {
          expect(await fs.stat(worktree)).toBeDefined();
          // Even a failed stop request must not block removal.
          throw new Error("daemon unavailable");
        }
        if (args.includes("remove")) await fs.rm(worktree, { recursive: true, force: true });
        return { stdout: "", stderr: "" };
      });
      if (cleanup) await cleanupFailedLocalWorktree(root, worktree, "feature");
      else await removeLocalWorktree(root, worktree);
      const stop = ["-C", worktree, "-c", "core.fsmonitor=false", "fsmonitor--daemon", "stop"];
      expect(calls[0]).toEqual(
        missing ? ["-C", root, "worktree", "remove", "--force", worktree] : stop,
      );
      expect(calls.filter((args) => args.includes("stop"))).toHaveLength(missing ? 0 : 1);
      expect(calls.some((args) => args.includes("remove"))).toBe(true);
      expect(calls.some((args) => args.includes("-D"))).toBe(cleanup);
    });
  }
}

test("cleans a worktree and branch when add succeeds but output capture rejects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-output-"));
  tempDirectories.push(root);
  const project = path.join(root, "repo");
  await runCommand("git", ["init", "-b", "main", project]);
  await runCommand("git", [
    "-C",
    project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  const realRun = shell.runCommand;
  const failure = new shell.CommandFailedError("lost output", {
    timedOut: true,
    outputCloseTimedOut: true,
    exitCode: 0,
  });
  const run = spyOn(shell, "runCommand").mockImplementation(async (command, args = [], options) => {
    const result = await realRun(command, args, options);
    if (args.includes("worktree") && args.includes("add")) throw failure;
    return result;
  });
  try {
    await expect(
      createLocalWorktree(
        project,
        "app",
        "feature",
        "main",
        [],
        path.join(root, "trees"),
        undefined,
        true,
      ),
    ).rejects.toBe(failure);
    expect(await fs.stat(path.join(root, "trees", "app-feature")).catch(() => null)).toBeNull();
    expect(
      (await realRun("git", ["-C", project, "worktree", "list", "--porcelain"])).stdout,
    ).not.toContain("app-feature");
    expect((await realRun("git", ["-C", project, "branch", "--list", "feature"])).stdout).toBe("");
  } finally {
    run.mockRestore();
  }
});

test("a new worktree gets the files the Environment Files setting matches, never a link", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-env-files-"));
  tempDirectories.push(root);
  const project = path.join(root, "repo");
  const outside = path.join(root, "outside");
  await runCommand("git", ["init", "-b", "main", project]);
  await runCommand("git", [
    "-C",
    project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  // Untracked files in the project checkout, as a user's own `.env` would be.
  await fs.mkdir(path.join(project, "config"));
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "host-secret"), "HOST_ONLY=1\n");
  await fs.writeFile(path.join(project, ".env"), "A=1\n");
  await fs.writeFile(path.join(project, ".env.local"), "not matched by these patterns\n");
  await fs.writeFile(path.join(project, "config", "app.env"), "C=1\n");
  await fs.symlink(path.join(outside, "host-secret"), path.join(project, "leak.env"));

  const worktree = await createLocalWorktree(
    project,
    "app",
    "feature",
    "main",
    [],
    path.join(root, "trees"),
    undefined,
    true,
    [".env", "*.env", "config/*.env", "../outside/host-secret"],
  );

  // A local-only project's own branch is its base: no remote, no fetch.
  expect(worktree.startPointSource).toBe("local-branch");
  expect(worktree.envFileRefusals).toEqual([
    { name: "../outside/host-secret", reason: "invalid-pattern" },
    { name: "leak.env", reason: "symlink" },
  ]);
  expect(await fs.readFile(path.join(worktree.path, ".env"), "utf8")).toBe("A=1\n");
  expect(await fs.readFile(path.join(worktree.path, "config", "app.env"), "utf8")).toBe("C=1\n");
  expect(await fs.lstat(path.join(worktree.path, ".env.local")).catch(() => null)).toBeNull();
  expect(await fs.lstat(path.join(worktree.path, "leak.env")).catch(() => null)).toBeNull();
});

async function initProject(root: string): Promise<string> {
  const project = path.join(root, "repo");
  await runCommand("git", ["init", "-b", "main", project]);
  await runCommand("git", [
    "-C",
    project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  return project;
}

test("a pinned start commit creates the worktree without contacting the remote", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-pinned-"));
  tempDirectories.push(root);
  const project = await initProject(root);
  const pinned = (await runCommand("git", ["-C", project, "rev-parse", "HEAD"])).stdout.trim();
  // The base moves on after the dialog resolved it; the pin must still win.
  await runCommand("git", [
    "-C",
    project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "later",
  ]);
  // A remote nothing can reach: any fetch on the path would fail the create.
  await runCommand("git", ["-C", project, "remote", "add", "origin", path.join(root, "gone.git")]);
  const trees = path.join(root, "trees");

  const worktree = await createLocalWorktree(project, "app", "pinned", pinned, [], trees);

  expect(worktree.startPointSource).toBe("pinned-commit");
  expect(worktree.createdFromCommit).toBe(pinned);
  expect(worktree.startPointResolveMs).toBeGreaterThanOrEqual(0);
  expect((await runCommand("git", ["-C", worktree.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(
    pinned,
  );
  // Unpinned, the same start has to fetch the base first, and that is what fails.
  await expect(
    createLocalWorktree(project, "app", "unpinned", "main", [], trees),
  ).rejects.toThrow();
});

test("a missing pin reports the commit without trying to fetch it as a branch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-lost-pin-"));
  tempDirectories.push(root);
  const project = await initProject(root);
  const missing = "f".repeat(40);
  const remote = spyOn(remoteGit, "runRemoteGit");
  await expect(
    createLocalWorktree(project, "app", "missing-pin", missing, [], path.join(root, "trees")),
  ).rejects.toThrow(`Starting commit ${missing} is unavailable`);
  expect(remote).not.toHaveBeenCalled();
});

test("an opencode.json named by files-to-copy reaches the worktree, untracked or only staged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-opencode-"));
  tempDirectories.push(root);
  const project = await initProject(root);
  // Untracked in the project checkout: the worktree's own checkout lacks it.
  await fs.writeFile(path.join(project, "opencode.json"), '{"model":"own"}');

  const own = await createLocalWorktree(
    project,
    "app",
    "own",
    "main",
    ["opencode.json"],
    path.join(root, "trees"),
    undefined,
    true,
  );
  expect(await fs.readFile(path.join(own.path, "opencode.json"), "utf8")).toBe('{"model":"own"}');
  expect(own.envFileRefusals).toEqual([]);

  // Only a command node's staged copy has it.
  await fs.rm(path.join(project, "opencode.json"));
  const seed = path.join(root, "seed");
  await fs.mkdir(seed);
  await fs.writeFile(path.join(seed, "opencode.json"), '{"model":"staged"}');
  await fs.writeFile(
    path.join(seed, ".orkestrator-seed-manifest.json"),
    JSON.stringify(["opencode.json"]),
  );
  const staged = await createLocalWorktree(
    project,
    "app",
    "staged",
    "main",
    [],
    path.join(root, "trees"),
    seed,
    true,
  );
  expect(await fs.readFile(path.join(staged.path, "opencode.json"), "utf8")).toBe(
    '{"model":"staged"}',
  );
});

describe("worktree refusals with no setup commands", () => {
  const runtimes: BackendRuntime[] = [];
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.shutdown();
  });

  async function setupContext() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-notices-"));
    tempDirectories.push(dataDir);
    const runtime = new BackendRuntime({ emit: () => undefined });
    runtimes.push(runtime);
    const tabs: string[] = [];
    const events: string[] = [];
    const context = {
      runtime,
      storage: {
        getDataDir: () => dataDir,
        ensureSetupTab: async (environmentId: string) => {
          tabs.push(environmentId);
        },
      } as unknown as StorageService,
      emit: (event: string) => {
        events.push(event);
      },
    } as unknown as CommandContext;
    return { context, runtime, tabs, events };
  }

  function localEnvironment(id: string): Environment {
    return {
      ...createEnvironment("project-1"),
      id,
      environmentType: "local",
      worktreePath: "/worktrees/app-feature",
    };
  }

  test("opens a setup session to show them, and forgets them once shown", async () => {
    const { context, runtime, tabs } = await setupContext();
    const environment = localEnvironment("env-notices");
    rememberWorktreeSeedRefusals(environment.id, [{ name: "leak.env", reason: "symlink" }]);

    await showWorktreeSeedRefusalsWithoutSetup(environment, context, undefined);

    const sessionId = setupTerminalSessionId(environment.id);
    const output = runtime.terminals.readOutput(sessionId);
    expect(output).toContain("No setup commands to run");
    expect(output).toContain("Skipped leak.env from the project folder: it is a symbolic link");
    expect(runtime.environments.setupSession(environment.id)?.sessionId).toBe(sessionId);
    expect(tabs).toEqual([environment.id]);
    expect(takeWorktreeSeedRefusals(environment.id)).toEqual([]);
  });

  test("writes them to an open preparation session instead", async () => {
    const { context, runtime, tabs } = await setupContext();
    const environment = localEnvironment("env-preparing");
    const sessionId = setupTerminalSessionId(environment.id);
    runtime.terminals.emitOutput(sessionId, "preparing\r\n", context.emit);
    rememberWorktreeSeedRefusals(environment.id, [
      { name: "Environment Files", reason: "too-many-matches" },
    ]);

    await showWorktreeSeedRefusalsWithoutSetup(environment, context, sessionId);

    const output = runtime.terminals.readOutput(sessionId);
    expect(output).toContain("preparing");
    expect(output).toContain("Copied no Environment Files matches into the worktree");
    expect(tabs).toEqual([]);
  });

  test("opens nothing when there is nothing to show", async () => {
    const { context, runtime, tabs, events } = await setupContext();
    const environment = localEnvironment("env-quiet");

    await showWorktreeSeedRefusalsWithoutSetup(environment, context, undefined);

    expect(runtime.environments.setupSession(environment.id)).toBeUndefined();
    expect(runtime.terminals.readOutput(setupTerminalSessionId(environment.id))).toBe("");
    expect(tabs).toEqual([]);
    expect(events).toEqual([]);
  });
});
