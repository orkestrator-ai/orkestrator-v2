import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { DesignService } from "./design-service.js";
import { StorageService } from "./storage.js";

describe("design command registry", () => {
  let dir: string;
  let storage: StorageService;
  let design: DesignService;
  let context: CommandContext;
  let commands: ReturnType<typeof createCommandRegistry>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ork-design-commands-"));
    storage = new StorageService(dir);
    await storage.init();
    await storage.addProject({
      id: "project",
      name: "Project",
      gitUrl: "https://example.invalid/project.git",
      localPath: dir,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    await storage.addEnvironment({
      id: "local",
      projectId: "project",
      name: "Local",
      branch: "main",
      environmentType: "local",
      worktreePath: dir,
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
    });
    await storage.addEnvironment({
      id: "container",
      projectId: "project",
      name: "Container",
      branch: "container",
      environmentType: "containerized",
      containerId: "container-id",
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 1,
    });
    design = new DesignService(dir, () => {});
    context = { storage, design } as CommandContext;
    commands = createCommandRegistry();
  });

  afterEach(async () => {
    await design.close();
    await rm(dir, { recursive: true, force: true });
  });

  const invoke = (name: string, args: Record<string, unknown>) =>
    Promise.resolve(commands.get(name)!(args, context));

  test("validates environments and exercises action, changes, and import", async () => {
    expect(await invoke("design_status", {})).toHaveProperty("ready");
    const canvas = (await invoke("design_action", {
      environmentId: "local",
      action: "create_canvas",
      input: { name: "Commands" },
    })) as { id: string; revision: number };
    expect(
      await invoke("design_changes", {
        environmentId: "local",
        canvasId: canvas.id,
        generation: design.generation,
        after: canvas.revision,
      }),
    ).toMatchObject({ reset: false, revision: 1 });
    const imported = (await invoke("design_import", {
      environmentId: "container",
      document: JSON.stringify(await design.get(canvas.id)),
    })) as { environmentId: string; id: string };
    expect(imported).toMatchObject({ environmentId: "container" });
    expect(imported.id).not.toBe(canvas.id);
    await expect(
      invoke("design_action", { environmentId: "missing", action: "list_canvases", input: {} }),
    ).rejects.toThrow("Environment not found");
    await expect(
      invoke("design_import", { environmentId: "missing", document: "{}" }),
    ).rejects.toThrow("Environment not found");
  });

  test("guards save names and revisions and selects the environment writer", async () => {
    const local = await design.create("local", "Local");
    const container = await design.create("container", "Container");
    const writeLocal = mock(async () => undefined);
    const writeContainer = mock(async () => undefined);
    commands.set("write_local_file", writeLocal);
    commands.set("write_container_file", writeContainer);

    await invoke("design_save", {
      environmentId: "local",
      canvasId: local.id,
      expectedRevision: 1,
      filePath: "local.orkdes",
    });
    await invoke("design_save", {
      environmentId: "container",
      canvasId: container.id,
      expectedRevision: 1,
      filePath: "container.orkdes",
    });
    expect(writeLocal).toHaveBeenCalledTimes(1);
    expect(writeContainer).toHaveBeenCalledTimes(1);
    await expect(
      invoke("design_save", {
        environmentId: "local",
        canvasId: local.id,
        expectedRevision: 0,
        filePath: "local.orkdes",
      }),
    ).rejects.toThrow("revision conflict");
    await expect(
      invoke("design_save", {
        environmentId: "local",
        canvasId: local.id,
        expectedRevision: 1,
        filePath: "../escape.orkdes",
      }),
    ).rejects.toThrow();
  });
});
