import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStoragePair<T>(
  run: (
    first: StorageService,
    second: StorageService,
    dataDir: string,
  ) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-kanban-lock-"));
  const first = new StorageService(dataDir);
  const second = new StorageService(dataDir);
  await Promise.all([first.init(), second.init()]);
  try {
    return await run(first, second, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("StorageService Kanban mutation serialization", () => {
  test("preserves concurrent task creation across service instances", async () => {
    await withStoragePair(async (first, second) => {
      await Promise.all(Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).addKanbanTask(
          "project-1",
          `Task ${index}`,
          "",
        )
      ));

      const tasks = await first.getKanbanTasks("project-1");
      expect(tasks).toHaveLength(12);
      expect(new Set(tasks.map((task) => task.title)).size).toBe(12);
      expect(new Set(tasks.map((task) => task.order))).toEqual(
        new Set(Array.from({ length: 12 }, (_, index) => index)),
      );
    });
  });

  test("preserves concurrent updates and comments on the same task", async () => {
    await withStoragePair(async (first, second) => {
      const task = await first.addKanbanTask("project-1", "Initial", "Initial");
      await Promise.all([
        first.updateKanbanTask(task.id, { title: "Updated title" }),
        second.updateKanbanTask(task.id, { description: "Updated description" }),
        first.addKanbanComment(task.id, "first"),
        second.addKanbanComment(task.id, "second"),
      ]);

      const saved = (await second.getKanbanTasks("project-1"))[0]!;
      expect(saved).toMatchObject({
        title: "Updated title",
        description: "Updated description",
      });
      expect(new Set(saved.comments.map((comment) => comment.text))).toEqual(
        new Set(["first", "second"]),
      );
    });
  });

  test("continues processing after a queued mutation fails", async () => {
    await withStoragePair(async (first) => {
      await expect(
        first.updateKanbanTask("missing", { title: "never" }),
      ).rejects.toThrow("Kanban task not found");

      const task = await first.addKanbanTask("project-1", "Recovered", "");
      expect((await first.getKanbanTasks("project-1")).map(
        (candidate) => candidate.id,
      )).toEqual([task.id]);
    });
  });

  test("keeps image files when authoritative deletion persistence fails", async () => {
    await withStoragePair(async (storage, _second, dataDir) => {
      const validImageBase64 = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">'
        + '<rect width="1" height="1"/></svg>',
      ).toString("base64");
      const imageTask = await storage.addKanbanTask("project-1", "Image", "");
      const taskToDelete = await storage.addKanbanTask("project-1", "Task", "");
      const withImage = await storage.addKanbanImage(
        imageTask.id,
        "image.svg",
        validImageBase64,
      );
      const withTaskImage = await storage.addKanbanImage(
        taskToDelete.id,
        "task-image.svg",
        validImageBase64,
      );
      const imageId = withImage.images[0]!.id;
      const taskImageId = withTaskImage.images[0]!.id;
      const internals = storage as unknown as {
        saveJson(filePath: string, value: unknown): Promise<void>;
      };
      const originalSaveJson = internals.saveJson.bind(storage);

      internals.saveJson = async () => {
        throw new Error("injected Kanban save failure");
      };
      try {
        await expect(
          storage.deleteKanbanImage(imageTask.id, imageId),
        ).rejects.toThrow("injected Kanban save failure");
        await expect(
          storage.deleteKanbanTask(taskToDelete.id),
        ).rejects.toThrow("injected Kanban save failure");
      } finally {
        internals.saveJson = originalSaveJson;
      }

      const tasks = await storage.getKanbanTasks("project-1");
      expect(tasks.find((task) => task.id === imageTask.id)?.images)
        .toContainEqual(expect.objectContaining({ id: imageId }));
      expect(tasks.find((task) => task.id === taskToDelete.id)?.images)
        .toContainEqual(expect.objectContaining({ id: taskImageId }));
      expect((await fs.stat(
        path.join(dataDir, "kanban-images", `${imageId}.webp`),
      )).isFile()).toBe(true);
      expect((await fs.stat(
        path.join(dataDir, "kanban-images", `${taskImageId}.webp`),
      )).isFile()).toBe(true);
    });
  });

  test("commits metadata and retries best-effort image cleanup", async () => {
    await withStoragePair(async (storage, _second, dataDir) => {
      const validImageBase64 = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">'
        + '<rect width="1" height="1"/></svg>',
      ).toString("base64");
      const task = await storage.addKanbanTask("project-1", "Image", "");
      const withImage = await storage.addKanbanImage(
        task.id,
        "image.svg",
        validImageBase64,
      );
      const imageId = withImage.images[0]!.id;
      const imagePath = path.join(dataDir, "kanban-images", `${imageId}.webp`);
      const originalRm = fs.rm;
      const originalWarn = console.warn;
      let cleanupAttempts = 0;
      let warnings = 0;
      fs.rm = (async (target, options) => {
        if (target === imagePath) {
          cleanupAttempts += 1;
          throw new Error("injected image cleanup failure");
        }
        return originalRm(target, options);
      }) as typeof fs.rm;
      console.warn = () => {
        warnings += 1;
      };

      try {
        await expect(storage.deleteKanbanImage(task.id, imageId)).resolves.toMatchObject({
          images: [],
        });
      } finally {
        fs.rm = originalRm;
        console.warn = originalWarn;
      }

      expect(cleanupAttempts).toBe(2);
      expect(warnings).toBe(1);
      expect((await storage.getKanbanTasks("project-1"))[0]?.images).toEqual([]);
      expect((await fs.stat(imagePath)).isFile()).toBe(true);
    });
  });
});
