import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StorageService } from "../../../apps/backend/src/core/storage";

const tempDirs: string[] = [];
const validImageBase64 = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
).toString("base64");

async function createStorage(prefix: string): Promise<{ dataDir: string; storage: StorageService }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dataDir);
  const storage = new StorageService(dataDir);
  await storage.init();
  return { dataDir, storage };
}

function persistedSession(
  id: string,
  environmentId: string,
  status: "connected" | "disconnected",
  createdAt: string,
  order: number,
) {
  return {
    id,
    environmentId,
    containerId: "container-1",
    tabId: `tab-${order}`,
    sessionType: "plain",
    status,
    createdAt,
    lastActivityAt: createdAt,
    order,
    hasLaunchedCommand: false,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("StorageService feature edge cases", () => {
  test("caps an environment at 20 sessions by evicting its oldest disconnected session and buffer", async () => {
    const { dataDir, storage } = await createStorage("ork-storage-session-cap-");
    const sessions = Array.from({ length: 20 }, (_, index) => persistedSession(
      `session-${index}`,
      "env-1",
      index === 2 || index === 7 ? "disconnected" : "connected",
      new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      index,
    ));
    sessions.push(persistedSession(
      "other-environment-session",
      "env-2",
      "disconnected",
      "2025-01-01T00:00:00.000Z",
      0,
    ));
    await fs.writeFile(path.join(dataDir, "sessions.json"), JSON.stringify(sessions));
    await storage.saveSessionBuffer("session-2", "evict me");
    await storage.saveSessionBuffer("session-7", "keep me");
    await storage.saveSessionBuffer("other-environment-session", "unrelated");

    const created = await storage.createSession("env-1", "container-1", "new-tab", "plain");
    const environmentSessions = await storage.getSessionsByEnvironment("env-1");

    expect(environmentSessions).toHaveLength(20);
    expect(environmentSessions.map((session) => session.id)).not.toContain("session-2");
    expect(environmentSessions.map((session) => session.id)).toContain("session-7");
    expect(environmentSessions.map((session) => session.id)).toContain(created.id);
    expect(created.order).toBe(20);
    await expect(storage.loadSessionBuffer("session-2")).resolves.toBeNull();
    await expect(storage.loadSessionBuffer("session-7")).resolves.toBe("keep me");
    await expect(storage.loadSessionBuffer("other-environment-session")).resolves.toBe("unrelated");
  });

  test("does not evict connected sessions when all 20 existing sessions are active", async () => {
    const { dataDir, storage } = await createStorage("ork-storage-session-active-cap-");
    const sessions = Array.from({ length: 20 }, (_, index) => persistedSession(
      `connected-${index}`,
      "env-1",
      "connected",
      new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      index,
    ));
    await fs.writeFile(path.join(dataDir, "sessions.json"), JSON.stringify(sessions));

    const created = await storage.createSession("env-1", "container-1", "new-tab", "plain");

    expect(await storage.getSessionsByEnvironment("env-1")).toHaveLength(21);
    await expect(storage.getSession("connected-0")).resolves.not.toBeNull();
    await expect(storage.getSession(created.id)).resolves.not.toBeNull();
  });

  test("truncates oversized session buffers to their trailing 500 KiB", async () => {
    const { storage } = await createStorage("ork-storage-buffer-limit-");
    const prefix = "discarded-prefix";
    const retained = "x".repeat(500 * 1024);

    await storage.saveSessionBuffer("session-1", prefix + retained);

    const loaded = await storage.loadSessionBuffer("session-1");
    expect(loaded).toBe(retained);
    expect(Buffer.byteLength(loaded!, "utf8")).toBe(500 * 1024);
  });

  test("handles absent and entirely-live buffer directories without deleting anything", async () => {
    const { dataDir, storage } = await createStorage("ork-storage-buffer-live-");
    await expect(storage.cleanupOrphanedBuffers()).resolves.toEqual([]);

    await fs.writeFile(
      path.join(dataDir, "sessions.json"),
      JSON.stringify([
        persistedSession("live-a", "env-1", "connected", "2026-01-01T00:00:00.000Z", 0),
        persistedSession("live-b", "env-1", "disconnected", "2026-01-01T00:01:00.000Z", 1),
      ]),
    );
    await storage.saveSessionBuffer("live-a", "a");
    await storage.saveSessionBuffer("live-b", "b");

    await expect(storage.cleanupOrphanedBuffers()).resolves.toEqual([]);
    await expect(storage.loadSessionBuffer("live-a")).resolves.toBe("a");
    await expect(storage.loadSessionBuffer("live-b")).resolves.toBe("b");
  });

  test("deletes orphan extensions whose derived stem collides with a live session id", async () => {
    const { dataDir, storage } = await createStorage("ork-storage-buffer-collision-");
    await fs.writeFile(
      path.join(dataDir, "sessions.json"),
      JSON.stringify([
        persistedSession("live-session", "env-1", "connected", "2026-01-01T00:00:00.000Z", 0),
      ]),
    );
    await storage.saveSessionBuffer("live-session", "live");
    const collidingOrphan = path.join(dataDir, "buffers", "live-session.log");
    await fs.writeFile(collidingOrphan, "orphan");

    await expect(storage.cleanupOrphanedBuffers()).resolves.toEqual(["live-session"]);
    await expect(storage.loadSessionBuffer("live-session")).resolves.toBe("live");
    await expect(fs.access(collidingOrphan)).rejects.toThrow();
  });

  test("filters Kanban tasks by project and appends status transitions to the target column", async () => {
    const { storage } = await createStorage("ork-storage-kanban-order-");
    const firstReview = await storage.addKanbanTask("project-1", "Review one", "");
    const secondReview = await storage.addKanbanTask("project-1", "Review two", "");
    const moving = await storage.addKanbanTask("project-1", "Move me", "");
    const otherProject = await storage.addKanbanTask("project-2", "Other project", "");
    await storage.updateKanbanTask(firstReview.id, { status: "review" });
    await storage.updateKanbanTask(secondReview.id, { status: "review" });
    await storage.updateKanbanTask(otherProject.id, { status: "review" });

    const transitioned = await storage.updateKanbanTask(moving.id, { status: "review" });
    const projectTasks = await storage.getKanbanTasks("project-1");

    expect(projectTasks.map((task) => task.id)).toEqual([
      firstReview.id,
      secondReview.id,
      moving.id,
    ]);
    expect(projectTasks).not.toContainEqual(expect.objectContaining({ id: otherProject.id }));
    expect(transitioned).toMatchObject({ status: "review", order: 2 });
    expect(projectTasks.filter((task) => task.status === "review").map((task) => task.order)).toEqual([0, 1, 2]);
  });

  test("rejects task and image deletion for a missing Kanban task", async () => {
    const { storage } = await createStorage("ork-storage-kanban-missing-");

    await expect(storage.deleteKanbanTask("missing-task")).rejects.toThrow(
      "Kanban task not found: missing-task",
    );
    await expect(storage.deleteKanbanImage("missing-task", "missing-image")).rejects.toThrow(
      "Kanban task not found: missing-task",
    );
  });

  test("does not persist image metadata when writing the resized image fails", async () => {
    const { storage } = await createStorage("ork-storage-kanban-write-failure-");
    const task = await storage.addKanbanTask("project-1", "Image task", "");
    const originalWriteFile = fs.writeFile;
    fs.writeFile = (async () => {
      throw Object.assign(new Error("image write failed"), { code: "ENOSPC" });
    }) as typeof fs.writeFile;

    try {
      await expect(storage.addKanbanImage(task.id, "pixel.svg", validImageBase64)).rejects.toMatchObject({
        code: "ENOSPC",
      });
    } finally {
      fs.writeFile = originalWriteFile;
    }

    expect((await storage.getKanbanTasks("project-1"))[0]?.images).toEqual([]);
  });

  test("deleting a Kanban task removes each of its persisted image files", async () => {
    const { dataDir, storage } = await createStorage("ork-storage-kanban-task-images-");
    const task = await storage.addKanbanTask("project-1", "Image task", "");
    const first = await storage.addKanbanImage(task.id, "first.svg", validImageBase64);
    const second = await storage.addKanbanImage(task.id, "second.svg", validImageBase64);
    const imageIds = [first.images[0]!.id, second.images[1]!.id];

    await storage.deleteKanbanTask(task.id);

    await expect(storage.getKanbanTasks("project-1")).resolves.toEqual([]);
    for (const imageId of imageIds) {
      await expect(fs.access(path.join(dataDir, "kanban-images", `${imageId}.webp`))).rejects.toThrow();
    }
  });
});
