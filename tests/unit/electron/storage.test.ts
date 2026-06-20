import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnvironment, defaultConfig, StorageService } from "../../../electron/backend/storage";

mock.module("sharp", () => {
  const pipeline = {
    resize: mock(() => pipeline),
    webp: mock(() => pipeline),
    toBuffer: mock(async () => Buffer.from("webp-bytes")),
  };
  return { default: mock(() => pipeline) };
});

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Electron StorageService", () => {
  test("default config uses the shared dark terminal background", () => {
    expect(defaultConfig().global.terminalAppearance.backgroundColor).toBe("#141414");
  });

  test("creates unnamed environments with legacy-compatible timestamp names", () => {
    const environment = createEnvironment("project-1");

    expect(environment.name).toMatch(/^\d{8}-\d{6}$/);
    expect(environment.branch).toBe(environment.name);
  });

  test("recovers JSON from a rotated backup when the primary file is malformed", async () => {
    const dataDir = await createTempDir("ork-storage-json-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const first = defaultConfig();
    first.global.defaultAgent = "claude";
    await storage.saveConfig(first);

    const second = defaultConfig();
    second.global.defaultAgent = "codex";
    await storage.saveConfig(second);
    await fs.writeFile(path.join(dataDir, "config.json"), "{not-json");

    await expect(storage.loadConfig()).resolves.toMatchObject({
      global: expect.objectContaining({ defaultAgent: "claude" }),
    });
  });

  test("persists session buffers, deletes removed session buffers, and cleans orphan buffers", async () => {
    const dataDir = await createTempDir("ork-storage-sessions-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const session = await storage.createSession("env-1", "container-1", "tab-1", "claude");
    await storage.saveSessionBuffer(session.id, "terminal output");
    await expect(storage.loadSessionBuffer(session.id)).resolves.toBe("terminal output");

    await storage.removeSession(session.id);
    await expect(storage.loadSessionBuffer(session.id)).resolves.toBeNull();

    await fs.mkdir(path.join(dataDir, "buffers"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "buffers", "orphan.txt"), "stale");
    await expect(storage.cleanupOrphanedBuffers()).resolves.toEqual(["orphan"]);
    await expect(fs.stat(path.join(dataDir, "buffers", "orphan.txt"))).rejects.toThrow();
  });

  test("stores project notes and updates the existing note for the project", async () => {
    const dataDir = await createTempDir("ork-storage-notes-");
    const storage = new StorageService(dataDir);
    await storage.init();

    await expect(storage.getProjectNotes("project-1")).resolves.toMatchObject({ projectId: "project-1", content: "" });

    const first = await storage.saveProjectNotes("project-1", "initial notes");
    expect(first).toMatchObject({ projectId: "project-1", content: "initial notes" });

    const second = await storage.saveProjectNotes("project-1", "updated notes");
    expect(second).toMatchObject({ projectId: "project-1", content: "updated notes" });
    await expect(storage.getProjectNotes("project-1")).resolves.toMatchObject({ content: "updated notes" });
  });

  test("persists kanban images as retrievable files and removes them when deleted", async () => {
    const dataDir = await createTempDir("ork-storage-kanban-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const task = await storage.addKanbanTask("project-1", "Build thing", "Details");
    const transparentPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const withImage = await storage.addKanbanImage(task.id, "pixel.png", transparentPngBase64);
    const image = withImage.images[0];
    expect(image).toMatchObject({ filename: "pixel.png" });

    const encodedWebp = await storage.getKanbanImageData(image!.id);
    expect(encodedWebp.length).toBeGreaterThan(0);

    const withoutImage = await storage.deleteKanbanImage(task.id, image!.id);
    expect(withoutImage.images).toHaveLength(0);
    await expect(storage.getKanbanImageData(image!.id)).rejects.toThrow();
  });
});
