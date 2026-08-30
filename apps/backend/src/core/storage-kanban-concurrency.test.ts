import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStoragePair<T>(
  run: (first: StorageService, second: StorageService, dataDir: string) => Promise<T>,
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
  test("validates initial status and appends direct creations to each project column", async () => {
    await withStoragePair(async (storage) => {
      await expect(
        storage.addKanbanTask("project-1", "Invalid", "", { status: "invalid" as never }),
      ).rejects.toThrow("status is invalid");

      const implicitDefault = await storage.addKanbanTask("project-1", "Implicit default", "");
      const explicitDefault = await storage.addKanbanTask("project-1", "Explicit default", "", {});
      expect(implicitDefault).toMatchObject({
        acceptanceCriteria: "",
        status: "backlog",
        order: 0,
      });
      expect(explicitDefault).toMatchObject({
        acceptanceCriteria: "",
        status: "backlog",
        order: 1,
      });

      for (const status of ["in-progress", "review", "done"] as const) {
        const first = await storage.addKanbanTask("project-1", `${status} first`, "", {
          acceptanceCriteria: `${status} criteria`,
          status,
        });
        const otherProject = await storage.addKanbanTask(
          "project-2",
          `${status} other project`,
          "",
          { status },
        );
        const second = await storage.addKanbanTask("project-1", `${status} second`, "", { status });
        expect(first).toMatchObject({
          acceptanceCriteria: `${status} criteria`,
          status,
          order: 0,
        });
        expect(otherProject).toMatchObject({ status, order: 0 });
        expect(second).toMatchObject({ status, order: 1 });
      }
    });
  });

  test("preserves concurrent task creation across service instances", async () => {
    await withStoragePair(async (first, second) => {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 === 0 ? first : second).addKanbanTask("project-1", `Task ${index}`, ""),
        ),
      );

      const tasks = await first.getKanbanTasks("project-1");
      expect(tasks).toHaveLength(12);
      expect(new Set(tasks.map((task) => task.title)).size).toBe(12);
      expect(new Set(tasks.map((task) => task.order))).toEqual(
        new Set(Array.from({ length: 12 }, (_, index) => index)),
      );
    });
  });

  test("converges concurrent ticket and comment retries on one durable append", async () => {
    await withStoragePair(async (first, second) => {
      const [created, retried] = await Promise.all([
        first.addKanbanTask("project-1", "Idempotent", "Details", {
          acceptanceCriteria: "One record",
          requestId: "ticket-request-1",
        }),
        second.addKanbanTask("project-1", "Idempotent", "Details", {
          acceptanceCriteria: "One record",
          requestId: "ticket-request-1",
        }),
      ]);
      expect(retried.id).toBe(created.id);
      expect(await first.getKanbanTasks("project-1")).toHaveLength(1);

      const [firstComment, secondComment] = await Promise.all([
        first.addKanbanComment(created.id, "Exactly once", "project-1", "comment-request-1"),
        second.addKanbanComment(created.id, "Exactly once", "project-1", "comment-request-1"),
      ]);
      expect(firstComment.comments).toHaveLength(1);
      expect(secondComment.comments).toHaveLength(1);

      await expect(
        first.addKanbanTask("project-1", "Changed", "Details", {
          requestId: "ticket-request-1",
        }),
      ).rejects.toThrow("requestId was already used");
      await expect(
        second.addKanbanComment(created.id, "Changed", "project-1", "comment-request-1"),
      ).rejects.toThrow("requestId was already used");
    });
  });

  test("rejects a deterministic image id reused with a different filename", async () => {
    await withStoragePair(async (storage) => {
      const task = await storage.addKanbanTask("project-1", "Image request", "");
      const webp = Buffer.from("RIFF0000WEBP", "latin1").toString("base64");
      const first = await storage.addNormalizedKanbanImageForRequest(
        task.id,
        "before.png",
        webp,
        "image-request-1",
      );

      await expect(
        storage.addNormalizedKanbanImageForRequest(task.id, "after.png", webp, "image-request-1"),
      ).rejects.toThrow("requestId was already used with a different filename");
      expect((await storage.getKanbanTasks("project-1"))[0]!.images).toEqual([first.image]);
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
      await expect(first.updateKanbanTask("missing", { title: "never" })).rejects.toThrow(
        "Kanban task not found",
      );

      const task = await first.addKanbanTask("project-1", "Recovered", "");
      expect((await first.getKanbanTasks("project-1")).map((candidate) => candidate.id)).toEqual([
        task.id,
      ]);
    });
  });

  test("checks project ownership inside update and comment mutations", async () => {
    await withStoragePair(async (storage) => {
      const task = await storage.addKanbanTask("project-1", "Scoped", "");

      await expect(
        storage.updateKanbanTask(task.id, { title: "Cross-project update" }, "project-2"),
      ).rejects.toThrow("Kanban task not found");
      await expect(
        storage.addKanbanComment(task.id, "Cross-project comment", "project-2"),
      ).rejects.toThrow("Kanban task not found");

      expect((await storage.getKanbanTasks("project-1"))[0]).toMatchObject({
        title: "Scoped",
        comments: [],
      });
    });
  });

  test("rejects invalid task and pull request states without corrupting storage", async () => {
    await withStoragePair(async (storage) => {
      const task = await storage.addKanbanTask("project-1", "Valid", "");

      await expect(
        storage.updateKanbanTask(task.id, {
          status: "invalid" as never,
        }),
      ).rejects.toThrow("status is invalid");
      await expect(
        storage.updateKanbanTask(task.id, {
          prState: "invalid" as never,
        }),
      ).rejects.toThrow("pull request state is invalid");

      expect((await storage.getKanbanTasks("project-1"))[0]).toMatchObject({
        id: task.id,
        status: "backlog",
      });
    });
  });

  test("keeps image files when authoritative deletion persistence fails", async () => {
    await withStoragePair(async (storage, _second, dataDir) => {
      const validImageBase64 = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
          '<rect width="1" height="1"/></svg>',
      ).toString("base64");
      const imageTask = await storage.addKanbanTask("project-1", "Image", "");
      const taskToDelete = await storage.addKanbanTask("project-1", "Task", "");
      const withImage = await storage.addKanbanImage(imageTask.id, "image.svg", validImageBase64);
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
        await expect(storage.deleteKanbanImage(imageTask.id, imageId)).rejects.toThrow(
          "injected Kanban save failure",
        );
        await expect(storage.deleteKanbanTask(taskToDelete.id)).rejects.toThrow(
          "injected Kanban save failure",
        );
      } finally {
        internals.saveJson = originalSaveJson;
      }

      const tasks = await storage.getKanbanTasks("project-1");
      expect(tasks.find((task) => task.id === imageTask.id)?.images).toContainEqual(
        expect.objectContaining({ id: imageId }),
      );
      expect(tasks.find((task) => task.id === taskToDelete.id)?.images).toContainEqual(
        expect.objectContaining({ id: taskImageId }),
      );
      expect((await fs.stat(path.join(dataDir, "kanban-images", `${imageId}.webp`))).isFile()).toBe(
        true,
      );
      expect(
        (await fs.stat(path.join(dataDir, "kanban-images", `${taskImageId}.webp`))).isFile(),
      ).toBe(true);
    });
  });

  test("commits metadata and retries best-effort image cleanup", async () => {
    await withStoragePair(async (storage, _second, dataDir) => {
      const validImageBase64 = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
          '<rect width="1" height="1"/></svg>',
      ).toString("base64");
      const task = await storage.addKanbanTask("project-1", "Image", "");
      const withImage = await storage.addKanbanImage(task.id, "image.svg", validImageBase64);
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

  test("rejects cross-task image deletion and traversal-shaped image IDs", async () => {
    await withStoragePair(async (storage, _second, dataDir) => {
      const validImageBase64 = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
          '<rect width="1" height="1"/></svg>',
      ).toString("base64");
      const owner = await storage.addKanbanTask("project-1", "Owner", "");
      const other = await storage.addKanbanTask("project-1", "Other", "");
      const withImage = await storage.addKanbanImage(owner.id, "image.svg", validImageBase64);
      const imageId = withImage.images[0]!.id;
      const imagePath = path.join(dataDir, "kanban-images", `${imageId}.webp`);
      const outsidePath = path.join(dataDir, "outside.webp");
      await fs.writeFile(outsidePath, "sentinel");

      await expect(storage.deleteKanbanImage(other.id, imageId)).rejects.toThrow(
        "not found on task",
      );
      await expect(storage.deleteKanbanImage(owner.id, "../outside")).rejects.toThrow(
        "image ID is invalid",
      );
      await expect(storage.getKanbanImageData("../outside")).rejects.toThrow("image ID is invalid");
      await expect(storage.getKanbanImageData("/tmp/outside")).rejects.toThrow(
        "image ID is invalid",
      );

      expect((await fs.stat(imagePath)).isFile()).toBe(true);
      expect(await fs.readFile(outsidePath, "utf8")).toBe("sentinel");
      expect(
        (await storage.getKanbanTasks("project-1")).find((task) => task.id === owner.id)?.images,
      ).toContainEqual(expect.objectContaining({ id: imageId }));

      const storedTasks = await storage.getKanbanTasks("project-1");
      storedTasks
        .find((task) => task.id === owner.id)!
        .images.push({
          id: "../outside",
          filename: "malformed.webp",
          createdAt: new Date(0).toISOString(),
        });
      await fs.writeFile(path.join(dataDir, "kanban.json"), JSON.stringify(storedTasks));
      const originalWarn = console.warn;
      console.warn = () => undefined;
      try {
        await storage.deleteKanbanTask(owner.id);
      } finally {
        console.warn = originalWarn;
      }
      expect(await fs.readFile(outsidePath, "utf8")).toBe("sentinel");
    });
  });

  test("preserves concurrent image and comment deletions across service instances", async () => {
    await withStoragePair(async (first, second) => {
      const validImageBase64 = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
          '<rect width="1" height="1"/></svg>',
      ).toString("base64");
      const task = await first.addKanbanTask("project-1", "Concurrent", "");
      const withComment = await first.addKanbanComment(task.id, "remove me");
      const withImage = await first.addKanbanImage(task.id, "remove.svg", validImageBase64);
      const commentId = withComment.comments[0]!.id;
      const imageId = withImage.images[0]!.id;

      await Promise.all([
        first.deleteKanbanComment(task.id, commentId),
        second.deleteKanbanImage(task.id, imageId),
      ]);

      const saved = (await first.getKanbanTasks("project-1"))[0]!;
      expect(saved.comments).toEqual([]);
      expect(saved.images).toEqual([]);
    });
  });
});
