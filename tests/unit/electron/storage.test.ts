import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnvironment, defaultConfig, defaultEnvironmentName, StorageService } from "../../../electron/backend/storage";

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

function withFixedDate<T>(iso: string, fn: () => T): T {
  const RealDate = Date;
  const fixedTime = new RealDate(iso).getTime();

  globalThis.Date = class FixedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedTime);
      } else if (args.length === 1) {
        super(args[0]);
      } else {
        super(
          args[0],
          args[1],
          args[2] ?? 1,
          args[3] ?? 0,
          args[4] ?? 0,
          args[5] ?? 0,
          args[6] ?? 0,
        );
      }
    }

    static now() {
      return fixedTime;
    }
  } as DateConstructor;

  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Electron StorageService", () => {
  test("default config uses the shared dark terminal background", () => {
    expect(defaultConfig().global.terminalAppearance.backgroundColor).toBe("#141414");
  });

  test("formats default environment names from UTC timestamps", () => {
    expect(withFixedDate("2026-04-15T12:34:56.789Z", () => defaultEnvironmentName())).toBe(
      "20260415-123456",
    );
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

  test("persists feature planning chats and story refinements", async () => {
    const dataDir = await createTempDir("ork-storage-features-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const feature = await storage.createFeaturePlan("project-1");
    expect(feature).toMatchObject({
      projectId: "project-1",
      title: "new feature",
      status: "collecting",
    });
    expect(feature.messages[0]).toMatchObject({
      role: "assistant",
      content: "Tell me about the new feature",
    });

    const withUserMessage = await storage.appendFeaturePlanMessage(feature.id, "user", "Users can save filters.");
    expect(withUserMessage.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Users can save filters.",
    });

    const storyId = "story-1";
    await storage.updateFeaturePlan(feature.id, {
      status: "stories",
      summary: "Users can save and reuse filtered views.",
      stories: [{
        id: storyId,
        title: "Save a filtered view",
        description: "A user can save the current filters so they can return to that view later.",
        acceptanceCriteria: ["Saved filters can be named", "Saved filters can be reopened"],
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    const withStoryChat = await storage.appendFeatureStoryMessage(feature.id, storyId, "assistant", "What should change?");
    expect(withStoryChat.stories[0]?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "What should change?",
      }),
    ]);

    const reloaded = new StorageService(dataDir);
    await reloaded.init();
    await expect(reloaded.getFeaturePlans("project-1")).resolves.toEqual([
      expect.objectContaining({
        id: feature.id,
        status: "stories",
        summary: "Users can save and reuse filtered views.",
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Users can save filters." }),
        ]),
        stories: [
          expect.objectContaining({
            id: storyId,
            title: "Save a filtered view",
            acceptanceCriteria: ["Saved filters can be named", "Saved filters can be reopened"],
            messages: [
              expect.objectContaining({ role: "assistant", content: "What should change?" }),
            ],
          }),
        ],
      }),
    ]);
  });

  test("preserves feature plan identity and rejects unknown feature/story ids", async () => {
    const dataDir = await createTempDir("ork-storage-features-errors-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const feature = await storage.createFeaturePlan("project-1");

    // id and projectId must not be overwritable through updates.
    const updated = await storage.updateFeaturePlan(feature.id, {
      title: "renamed",
      id: "hacked-id",
      projectId: "other-project",
    } as never);
    expect(updated.id).toBe(feature.id);
    expect(updated.projectId).toBe("project-1");
    expect(updated.title).toBe("renamed");

    await expect(storage.updateFeaturePlan("missing", { title: "x" })).rejects.toThrow(/not found/i);
    await expect(storage.appendFeaturePlanMessage("missing", "user", "hi")).rejects.toThrow(/not found/i);
    await expect(storage.appendFeatureStoryMessage(feature.id, "missing-story", "user", "hi")).rejects.toThrow(/not found/i);

    // A failed mutation must not corrupt the persisted plan.
    await expect(storage.getFeaturePlans("project-1")).resolves.toEqual([
      expect.objectContaining({ id: feature.id, projectId: "project-1", title: "renamed" }),
    ]);
  });

  test("serializes concurrent feature plan mutations without losing writes", async () => {
    const dataDir = await createTempDir("ork-storage-features-concurrency-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const feature = await storage.createFeaturePlan("project-1");
    await storage.updateFeaturePlan(feature.id, {
      stories: [{
        id: "story-1",
        title: "Story one",
        description: "desc",
        acceptanceCriteria: [],
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    // Fire a feature-chat append and a story append concurrently. With a stale
    // read-modify-write both would clobber each other; the mutation queue must
    // preserve both.
    await Promise.all([
      storage.appendFeaturePlanMessage(feature.id, "user", "feature note"),
      storage.appendFeatureStoryMessage(feature.id, "story-1", "user", "story note"),
    ]);

    const [reloaded] = await storage.getFeaturePlans("project-1");
    expect(reloaded?.messages.some((message) => message.content === "feature note")).toBe(true);
    expect(reloaded?.stories[0]?.messages.some((message) => message.content === "story note")).toBe(true);
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
