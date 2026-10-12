import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCommandRegistry, type CommandContext } from "./commands.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
import { createProject, StorageService } from "./storage.js";

const roots: string[] = [];

afterEach(async () => {
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
  return { root, projectPath, storage, create };
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
