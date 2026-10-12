import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCommandRegistry, type CommandContext } from "./commands.js";
import { startEnvironmentOnce } from "./commands-environment.js";
import { diffStatsService } from "./commands-runtime-state.js";
import { prMonitorService } from "./commands-pr-monitor.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
import { createProject, StorageService } from "./storage.js";

const roots: string[] = [];

afterEach(async () => {
  for (const id of diffStatsService.trackedIds()) diffStatsService.untrack(id);
  prMonitorService.sync([]);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-location-")),
  );
  roots.push(root);
  const projectPath = path.join(root, "app");
  await runCommand("git", ["init", "-q", "-b", "main", projectPath]);
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(
    createProject("https://github.com/acme/app.git", projectPath),
  );
  const commands = createCommandRegistry();
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
  } as CommandContext;
  const create = (args: Record<string, unknown>) =>
    commands.get("create_environment")!(
      { projectId: project.id, ...args },
      context,
    ) as Promise<Environment>;
  return { root, projectPath, storage, create, context, commands };
}

describe("create_environment worktree location", () => {
  test("records the folder a local environment chose", async () => {
    const { root, storage, create } = await setup();
    const chosen = path.join(root, "elsewhere", "..", "trees");

    const environment = await create({ environmentType: "local", worktreeBaseDir: chosen });

    expect(environment.worktreeBaseDir).toBe(path.join(root, "trees"));
    expect((await storage.getEnvironment(environment.id))?.worktreeBaseDir).toBe(
      path.join(root, "trees"),
    );
  });

  test("leaves the location to the default when none is chosen", async () => {
    const { create } = await setup();
    expect((await create({ environmentType: "local" })).worktreeBaseDir).toBeUndefined();
  });

  test("refuses a folder for a container or inside the project checkout", async () => {
    const { root, projectPath, create } = await setup();
    await expect(
      create({ environmentType: "containerized", worktreeBaseDir: path.join(root, "trees") }),
    ).rejects.toThrow("Only a local environment");
    await expect(
      create({ environmentType: "local", worktreeBaseDir: path.join(projectPath, "trees") }),
    ).rejects.toThrow("project checkout");
    await expect(create({ environmentType: "local", worktreeBaseDir: "trees" })).rejects.toThrow(
      "absolute",
    );
  });
});

async function commitFixture(projectPath: string, root: string) {
  await fs.writeFile(path.join(projectPath, "README.md"), "fixture");
  await runCommand("git", ["-C", projectPath, "add", "."]);
  await runCommand("git", [
    "-C",
    projectPath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const origin = path.join(root, "origin.git");
  await runCommand("git", ["clone", "--bare", projectPath, origin]);
  await runCommand("git", ["-C", projectPath, "remote", "add", "origin", origin]);
  await runCommand("git", ["-C", projectPath, "fetch", "origin"]);
}

test("start uses and persists both explicit and configured roots; generic reads stay within the worktree", async () => {
  for (const explicit of [false, true]) {
    const { root, projectPath, storage, create, context, commands } = await setup();
    await commitFixture(projectPath, root);
    const selected = path.join(root, "chosen");
    if (!explicit) await storage.updateWorktreeLocations({ environments: selected });
    const environment = await create({
      environmentType: "local",
      branch: "feature",
      ...(explicit ? { worktreeBaseDir: selected } : {}),
    });
    await storage.updateEnvironment(environment.id, { setupOverride: true });
    await startEnvironmentOnce(environment.id, context, () => {});
    const persisted = (await storage.getEnvironment(environment.id))!;
    expect(persisted.worktreeBaseDir).toBe(selected);
    expect(path.dirname(persisted.worktreePath!)).toBe(selected);
    expect(await fs.readFile(path.join(persisted.worktreePath!, "README.md"), "utf8")).toBe(
      "fixture",
    );
    await fs.writeFile(path.join(selected, "sibling.txt"), "private");
    const read = (filePath: string) => commands.get("read_file_base64")!({ filePath }, context);
    expect(await read(path.join(persisted.worktreePath!, "README.md"))).toBe(
      Buffer.from("fixture").toString("base64"),
    );
    await expect(read(path.join(selected, "sibling.txt"))).rejects.toThrow();
  }
});

test("start rejects a configured default inside its project before creating directories", async () => {
  const { projectPath, storage, create, context } = await setup();
  const selected = path.join(projectPath, "nested", "trees");
  await storage.updateWorktreeLocations({ environments: selected });
  const environment = await create({ environmentType: "local" });
  await expect(startEnvironmentOnce(environment.id, context, () => {})).rejects.toThrow(
    "project checkout",
  );
  expect(await fs.stat(path.join(projectPath, "nested")).catch(() => null)).toBeNull();
  expect((await storage.getEnvironment(environment.id))?.worktreePath).toBeFalsy();
});
