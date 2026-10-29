import { afterEach, describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCommandRegistry, type CommandContext } from "./commands.js";
import { startEnvironmentOnce } from "./commands-environment.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
import { createProject, StorageService } from "./storage.js";
import { coordinatorAttachmentsRoot } from "./storage-coordinators.js";
import { updateWorktreeLocations } from "./worktree-locations.js";
import { BackendRuntime } from "./backend-runtime.js";
import { CoordinatorService } from "./coordinator-service.js";

// This slow-tier file creates real repositories/worktrees and waits for
// subprocess cleanup. Give that fixture work its own bounded host budget;
// explicit operation deadlines and shorter test budgets remain unchanged.
setDefaultTimeout(30_000);

const roots: string[] = [];
const runtimes: BackendRuntime[] = [];

async function cleanupFixtures() {
  const finished = runtimes.splice(0);
  for (const runtime of finished) runtime.shutdown();
  // A diff scan still running writes the worktree's Git exclude file.
  await Promise.all(finished.map((runtime) => runtime.diffStats.settled()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
}

afterEach(cleanupFixtures);

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
  const runtime = new BackendRuntime({ emit: () => undefined });
  runtimes.push(runtime);
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime,
  } as CommandContext;
  const create = (args: Record<string, unknown>) =>
    commands.get("create_environment")!(
      { projectId: project.id, ...args },
      context,
    ) as Promise<Environment>;
  return { root, project, projectPath, storage, create, context, commands };
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

  test("rejects aliases to root or whitespace-ending folders before saving an environment", async () => {
    const { root, project, storage, create } = await setup();
    const whitespaceTarget = path.join(root, "trees ");
    await fs.mkdir(whitespaceTarget);
    for (const [name, target, error] of [
      ["root", path.parse(root).root, "filesystem root"],
      ["whitespace", whitespaceTarget, "surrounding whitespace"],
    ] as const) {
      const alias = path.join(root, `${name}-alias`);
      await fs.symlink(target, alias);
      await expect(create({ environmentType: "local", worktreeBaseDir: alias })).rejects.toThrow(
        error,
      );
      const reloaded = new StorageService(storage.getDataDir());
      await reloaded.init();
      expect(await reloaded.getEnvironmentsByProject(project.id)).toEqual([]);
    }
    expect(await fs.stat(path.join(root, "trees")).catch(() => null)).toBeNull();
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

test("fixture teardown waits for an in-flight diff scan's exclude write before removing its root", async () => {
  const { root, projectPath, context, storage } = await setup();
  await commitFixture(projectPath, root);
  const tracking = context.runtime.diffStats;
  const excludeFile = path.join(projectPath, ".git", "info", "exclude");
  let reachedWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    reachedWrite = resolve;
  });
  let releaseWrite!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let reachedSettlement!: () => void;
  const settling = new Promise<void>((resolve) => {
    reachedSettlement = resolve;
  });
  const realWrite = fs.writeFile.bind(fs);
  let writeCompleted = false;
  const write = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (args[0] === excludeFile) {
      reachedWrite();
      await released;
    }
    await realWrite(...args);
    if (args[0] === excludeFile) writeCompleted = true;
  });
  const realRm = fs.rm.bind(fs);
  let excludeAtRemoval: string | undefined;
  const remove = spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (args[0] === root) {
      expect(writeCompleted).toBe(true);
      excludeAtRemoval = await fs.readFile(excludeFile, "utf8");
    }
    return realRm(...args);
  });
  const realSettled = tracking.settled.bind(tracking);
  const settled = spyOn(tracking, "settled").mockImplementation(() => {
    reachedSettlement();
    return realSettled();
  });
  let cleanup: Promise<void> | undefined;
  try {
    tracking.service.track({
      environmentId: "cleanup-scan",
      kind: "local",
      worktreePath: projectPath,
      comparisonRef: "origin/main",
    });
    await writing;
    cleanup = cleanupFixtures();
    await settling;
    expect(await fs.stat(root).catch(() => null)).not.toBeNull();
    expect(await fs.readFile(excludeFile, "utf8")).not.toContain(".orkestrator");
    releaseWrite();
    await cleanup;
    expect(excludeAtRemoval).toContain(".orkestrator");
    expect(await fs.stat(root).catch(() => null)).toBeNull();
    // All scanner writes have finished; another event-loop turn cannot recreate it.
    await Bun.sleep(0);
    expect(await fs.stat(root).catch(() => null)).toBeNull();
  } finally {
    releaseWrite();
    try {
      await cleanup;
      await realSettled();
    } finally {
      write.mockRestore();
      remove.mockRestore();
      settled.mockRestore();
      storage.close();
    }
  }
});

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
    await storage.updateEnvironment(environment.id, {
      setupOverride: true,
      diffBaseOverride: { ref: "refs/heads/main", commit: "a".repeat(40) },
    });
    await startEnvironmentOnce(environment.id, context, () => {});
    const persisted = (await storage.getEnvironment(environment.id))!;
    expect(persisted.worktreeBaseDir).toBe(selected);
    expect(persisted.diffBaseOverride).toBeNull();
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

test("generic reads reach a coordinator's staged attachments but nothing else in application data", async () => {
  const { project, storage, context, commands } = await setup();
  const coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  const { workspace } = await coordinator.ensure(project.id);
  const imageData = "iVBORw0KGgo=";
  const attachment = await storage.coordinators.writeCoordinatorAttachment(
    workspace.id,
    workspace.conversations[0]!.id,
    "pasted.png",
    imageData,
  );
  expect(path.dirname(attachment)).toBe(
    path.join(
      coordinatorAttachmentsRoot(storage.getDataDir()),
      workspace.id,
      workspace.conversations[0]!.id,
    ),
  );
  expect(path.basename(attachment)).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/,
  );
  expect((await fs.stat(attachment)).mode & 0o777).toBe(0o600);
  await fs.writeFile(path.join(storage.getDataDir(), "secret.json"), "{}");
  const read = (filePath: string) => commands.get("read_file_base64")!({ filePath }, context);

  expect(await read(attachment)).toBe(imageData);
  await expect(read(path.join(storage.getDataDir(), "secret.json"))).rejects.toThrow(
    "outside Orkestrator workspace storage",
  );
  // Preserve the traversal in the request rather than normalizing it in the test.
  await expect(
    read(`${coordinatorAttachmentsRoot(storage.getDataDir())}/../secret.json`),
  ).rejects.toThrow("outside Orkestrator workspace storage");
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

test("retargeting an accepted alias keeps creation and cleanup at the original physical root", async () => {
  for (const explicit of [false, true]) {
    const { root, projectPath, storage, create, context, commands } = await setup();
    await commitFixture(projectPath, root);
    const original = path.join(root, "original");
    const replacement = path.join(root, "replacement");
    const alias = path.join(root, "alias");
    await fs.mkdir(original);
    await fs.mkdir(replacement);
    await fs.symlink(original, alias);
    if (!explicit) await updateWorktreeLocations({ environments: alias }, context);
    const environment = await create({
      environmentType: "local",
      branch: "feature",
      ...(explicit ? { worktreeBaseDir: alias } : {}),
    });
    await storage.updateEnvironment(environment.id, { setupOverride: true });
    await fs.unlink(alias);
    await fs.symlink(replacement, alias);
    const reloaded = new StorageService(storage.getDataDir());
    await reloaded.init();
    context.storage = reloaded;
    await startEnvironmentOnce(environment.id, context, () => {});
    const persisted = (await reloaded.getEnvironment(environment.id))!;
    expect(persisted.worktreeBaseDir).toBe(original);
    expect(path.dirname(persisted.worktreePath!)).toBe(original);
    expect(await fs.readFile(path.join(persisted.worktreePath!, "README.md"), "utf8")).toBe(
      "fixture",
    );
    expect(await fs.readdir(replacement)).toEqual([]);

    // A same-named directory behind the retargeted alias must survive cleanup.
    const decoy = path.join(replacement, path.basename(persisted.worktreePath!));
    await fs.mkdir(decoy);
    await fs.writeFile(path.join(decoy, "keep.txt"), "keep");
    await commands.get("delete_environment")!({ environmentId: environment.id }, context);
    expect(await reloaded.getEnvironment(environment.id)).toBeNull();
    expect(await fs.stat(persisted.worktreePath!).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(alias, path.basename(decoy), "keep.txt"), "utf8")).toBe(
      "keep",
    );
    expect(await fs.stat(original)).not.toBeNull();
  }
});

test("start rejects persisted aliases to root or trailing whitespace without creating a worktree", async () => {
  const { root, storage, create, context } = await setup();
  const whitespaceTarget = path.join(root, "trees ");
  await fs.mkdir(whitespaceTarget);
  for (const [name, target, error] of [
    ["root", path.parse(root).root, "filesystem root"],
    ["whitespace", whitespaceTarget, "surrounding whitespace"],
  ] as const) {
    const alias = path.join(root, `${name}-alias`);
    await fs.symlink(target, alias);
    const environment = await create({ environmentType: "local" });
    await storage.updateEnvironment(environment.id, { worktreeBaseDir: alias });
    const reloaded = new StorageService(storage.getDataDir());
    await reloaded.init();
    context.storage = reloaded;
    await expect(startEnvironmentOnce(environment.id, context, () => {})).rejects.toThrow(error);
    const persisted = (await reloaded.getEnvironment(environment.id))!;
    expect(persisted.worktreeBaseDir).toBe(alias);
    expect(persisted.worktreePath).toBeFalsy();
  }
  expect(await fs.readdir(whitespaceTarget)).toEqual([]);
  expect(await fs.stat(path.join(root, "trees")).catch(() => null)).toBeNull();
});
