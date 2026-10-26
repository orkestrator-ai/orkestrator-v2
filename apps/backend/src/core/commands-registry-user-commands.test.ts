import * as accounts from "./agent-accounts-active.js";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUserCommandLaunch } from "./commands-registry-user-commands.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { runCommand } from "./shell.js";
import { BackendRuntime } from "./backend-runtime.js";
import { StorageService, createEnvironment, createProject } from "./storage.js";
import { CoordinatorService } from "./coordinator-service.js";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";
import * as pty from "./pty.js";

let root: string;
let context: CommandContext;
let storage: StorageService;
let environment: Environment;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "user-command-launch-")));
  await runCommand("git", ["init", "-q", "-b", "main", root]);
  await runCommand("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(createProject("remote", root));
  environment = {
    ...createEnvironment(project.id, { environmentType: "local" }),
    worktreePath: root,
    status: "running",
  };
  await storage.addEnvironment(environment);
  context = {
    storage,
    appRoot: root,
    resourceRoot: root,
    toolchainBinDir: "",
    emit() {},
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime: new BackendRuntime({ emit() {} }),
  } as CommandContext;
});
afterEach(async () => {
  context.runtime.shutdown();
  storage.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("local launch uses the checkout and a login shell, holding move admission through spawn", async () => {
  const launch = await resolveUserCommandLaunch(context, environment.id);
  expect(launch).toMatchObject({ target: "worktree", cwd: root });
  expect(() => context.runtime.environments.fence.beginMove(environment.id)).toThrow("submission");
  const spawn = spyOn(pty, "spawnPty").mockImplementation(() => {
    throw new Error("spawn boundary");
  });
  try {
    expect(() => launch.spawn("echo test")).toThrow("spawn boundary");
    expect(spawn.mock.calls[0]?.[1]).toEqual(["-lc", "echo test"]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: root, cols: 120, rows: 40 });
    expect(spawn.mock.calls[0]?.[2]?.env?.PATH).toBeString();
  } finally {
    launch.release?.();
    spawn.mockRestore();
  }
  expect(context.runtime.environments.fence.beginMove(environment.id)).toBe(true);
  context.runtime.environments.fence.endMove(environment.id);
});

test("missing worktrees and pending lifecycle states refuse launch", async () => {
  for (const patch of [
    { worktreePath: null },
    { worktreePath: path.join(root, "missing") },
    { status: "stopping" as const },
    { status: "creating" as const },
    { lifecycleOperation: "moving" as const },
  ]) {
    await storage.updateEnvironment(environment.id, { ...environment, ...patch });
    await expect(resolveUserCommandLaunch(context, environment.id)).rejects.toThrow();
  }
});

test("moving, recovery-pending, replaced and deleting environments reject admission", async () => {
  const fence = context.runtime.environments.fence;
  fence.beginMove(environment.id);
  await expect(resolveUserCommandLaunch(context, environment.id)).rejects.toThrow("moved");
  fence.endMove(environment.id);
  fence.setMoveRecoveryPending(environment.id, true);
  await expect(resolveUserCommandLaunch(context, environment.id)).rejects.toThrow("recovery");
  fence.setMoveRecoveryPending(environment.id, false);
  await fence.withReplacement(environment.id, async () => {
    await expect(resolveUserCommandLaunch(context, environment.id)).rejects.toThrow("rebuilt");
  });
  context.runtime.environments.beginDelete(environment.id);
  await expect(resolveUserCommandLaunch(context, environment.id)).rejects.toThrow("deleted");
});

test("deletion during deferred resolution prevents spawn and releases admission", async () => {
  const original = storage.getEnvironment.bind(storage);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = spyOn(storage, "getEnvironment").mockImplementation(async (id) => {
    await gate;
    return original(id);
  });
  const pending = resolveUserCommandLaunch(context, environment.id);
  const rejected = pending.catch((error: Error) => error);
  expect(() => context.runtime.environments.fence.beginMove(environment.id)).toThrow("submission");
  context.runtime.environments.beginDelete(environment.id);
  release();
  try {
    expect(await rejected).toMatchObject({ message: expect.stringContaining("deleted") });
  } finally {
    read.mockRestore();
  }
  context.runtime.environments.endDelete(environment.id);
  expect(context.runtime.environments.fence.beginMove(environment.id)).toBe(true);
  context.runtime.environments.fence.endMove(environment.id);
});

test("coordinator launches require an open conversation and an existing project checkout", async () => {
  const coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  const snapshot = await coordinator.ensure(environment.projectId);
  const conversation = snapshot.workspace.conversations[0]!;
  const id = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
  const launch = await resolveUserCommandLaunch(context, id);
  expect(launch).toMatchObject({ target: "project-checkout", cwd: root });
  launch.release?.();
  await coordinator.closeConversation(environment.projectId, conversation.id);
  await expect(resolveUserCommandLaunch(context, id)).rejects.toThrow("closed");
});

test("container launch uses a private in-container session and identity", async () => {
  await storage.updateEnvironment(environment.id, {
    environmentType: "containerized",
    containerId: "container-1",
    status: "running",
  });
  const launch = await resolveUserCommandLaunch(context, environment.id);
  const spawn = spyOn(pty, "spawnPty").mockImplementation(() => {
    throw new Error("spawn boundary");
  });
  try {
    expect(launch.target).toBe("container");
    expect(() => launch.spawn("read value")).toThrow("spawn boundary");
    const args = spawn.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("container-1");
    expect(args.some((arg) => arg.includes("ps -o pgid="))).toBe(true);
    expect(args).toContain("node");
    expect(args).toContain("/workspace");
    expect(args.some((arg) => arg.startsWith("ORKESTRATOR_USER_COMMAND_ID="))).toBe(true);
  } finally {
    launch.release?.();
    spawn.mockRestore();
  }
});

test("active account configuration strips inherited API credentials from the local shell", async () => {
  const key = "ANTHROPIC_API_KEY";
  const previous = process.env[key];
  process.env[key] = "synthetic-test-credential";
  const account = spyOn(accounts, "activeAgentAccountShellEnvironment").mockResolvedValue({
    CLAUDE_CONFIG_DIR: path.join(root, "account"),
  });
  const spawn = spyOn(pty, "spawnPty").mockImplementation(() => {
    throw new Error("spawn boundary");
  });
  let launch: Awaited<ReturnType<typeof resolveUserCommandLaunch>> | undefined;
  try {
    launch = await resolveUserCommandLaunch(context, environment.id);
    expect(() => launch!.spawn("echo test")).toThrow("spawn boundary");
    const env = spawn.mock.calls[0]?.[2]?.env;
    expect(env?.CLAUDE_CONFIG_DIR).toBe(path.join(root, "account"));
    expect(env?.[key]).toBeUndefined();
  } finally {
    launch?.release?.();
    account.mockRestore();
    spawn.mockRestore();
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("coordinator and container refusal states explain unavailable launch targets", async () => {
  const coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  const snapshot = await coordinator.ensure(environment.projectId);
  const conversation = snapshot.workspace.conversations[0]!;
  await storage.updateProject(environment.projectId, { localPath: null });
  await expect(
    resolveUserCommandLaunch(context, coordinatorRuntimeId(snapshot.workspace.id, conversation.id)),
  ).rejects.toThrow("no checkout");
  await storage.updateEnvironment(environment.id, {
    environmentType: "containerized",
    containerId: null,
    status: "stopped",
  });
  await expect(resolveUserCommandLaunch(context, environment.id)).rejects.toThrow(
    "container first",
  );
});
