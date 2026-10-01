import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
import { prMonitorService } from "./commands-pr-monitor.js";

let root: string;
let checkout: string;
let storage: StorageService;
let context: CommandContext;
let projectId: string;
let commands: ReturnType<typeof createCommandRegistry>;

const ensure = () =>
  commands.get("ensure_project_home_environment")!({ projectId }, context) as Promise<Environment>;

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
