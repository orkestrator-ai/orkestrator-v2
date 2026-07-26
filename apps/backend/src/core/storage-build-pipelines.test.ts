import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStorage<T>(run: (storage: StorageService) => Promise<T>): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-build-pipelines-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const snapshot = (phase = "building") => ({ id: "p1", phase });

describe("StorageService build pipelines", () => {
  test("stores a pipeline before its environment exists", async () => {
    await withStorage(async (storage) => {
      // The blank environment id is the whole point: a pipeline is created
      // before the environment it will run in.
      const saved = await storage.saveBuildPipeline("p1", "proj-1", "", 1, snapshot());
      expect(saved).toMatchObject({ id: "p1", projectId: "proj-1", environmentId: "", revision: 1 });
      expect(await storage.getBuildPipeline("p1")).toMatchObject({ revision: 1 });
    });
  });

  test("increments the revision on every write", async () => {
    await withStorage(async (storage) => {
      expect((await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot())).revision).toBe(1);
      expect((await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot())).revision).toBe(2);
      expect((await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot())).revision).toBe(3);
    });
  });

  test("rejects a write whose expected revision is stale", async () => {
    await withStorage(async (storage) => {
      await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot(), 0);
      await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot("reviewing"), 1);

      // A second client still believing it is at revision 1 must lose.
      await expect(
        storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot("verifying"), 1),
      ).rejects.toThrow("revision conflict");
      expect(await storage.getBuildPipeline("p1")).toMatchObject({
        snapshot: { phase: "reviewing" },
        revision: 2,
      });
    });
  });

  test("rejects a first write that expects an existing record", async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot(), 3),
      ).rejects.toThrow("revision conflict");
    });
  });

  test("refuses to move a pipeline between projects", async () => {
    await withStorage(async (storage) => {
      await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot());
      await expect(
        storage.saveBuildPipeline("p1", "proj-2", "e1", 1, snapshot()),
      ).rejects.toThrow("another project");
    });
  });

  test("lists only the requested project, oldest write first", async () => {
    await withStorage(async (storage) => {
      await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot());
      await storage.saveBuildPipeline("p2", "proj-2", "e2", 1, { id: "p2" });
      await storage.saveBuildPipeline("p3", "proj-1", "e3", 1, { id: "p3" });

      const listed = await storage.listBuildPipelines("proj-1");
      expect(listed.map((entry) => entry.id)).toEqual(["p1", "p3"]);
    });
  });

  test("deletes by environment and reports what it removed", async () => {
    await withStorage(async (storage) => {
      await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot());
      await storage.saveBuildPipeline("p2", "proj-1", "e1", 1, { id: "p2" });
      await storage.saveBuildPipeline("p3", "proj-1", "e2", 1, { id: "p3" });

      expect((await storage.deleteBuildPipelinesByEnvironment("e1")).sort())
        .toEqual(["p1", "p2"]);
      expect((await storage.listBuildPipelines("proj-1")).map((entry) => entry.id))
        .toEqual(["p3"]);
    });
  });

  test("deleting an unknown pipeline is a no-op rather than an error", async () => {
    await withStorage(async (storage) => {
      await expect(storage.deleteBuildPipeline("never-existed")).resolves.toBeUndefined();
    });
  });

  test("rejects a snapshot that is not a JSON object", async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.saveBuildPipeline("p1", "proj-1", "e1", 1, "not-an-object"),
      ).rejects.toThrow("must be a JSON object");
    });
  });

  test("rejects an over-sized snapshot rather than truncating the task", async () => {
    await withStorage(async (storage) => {
      const huge = { id: "p1", blob: "x".repeat(33 * 1024 * 1024) };
      await expect(
        storage.saveBuildPipeline("p1", "proj-1", "e1", 1, huge),
      ).rejects.toThrow("32 MB limit");
    });
  });

  test("ignores a corrupt record instead of failing every read", async () => {
    await withStorage(async (storage) => {
      await storage.saveBuildPipeline("good", "proj-1", "e1", 1, snapshot());
      const file = path.join(storage.getDataDir(), "build-pipelines.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      stored.corrupt = { id: "corrupt", revision: "not-a-number" };
      await fs.writeFile(file, JSON.stringify(stored));

      expect((await storage.listBuildPipelines("proj-1")).map((entry) => entry.id))
        .toEqual(["good"]);
      expect(await storage.getBuildPipeline("corrupt")).toBeNull();
    });
  });

  test("serializes concurrent writes so the revision never collides", async () => {
    await withStorage(async (storage) => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot()),
        ),
      );
      const revisions = results.map((result) => result.revision).sort((a, b) => a - b);
      expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
  });

  test("rejects blank identifiers", async () => {
    await withStorage(async (storage) => {
      await expect(storage.getBuildPipeline("")).rejects.toThrow("must not be blank");
      await expect(storage.listBuildPipelines("")).rejects.toThrow("must not be blank");
      await expect(storage.saveBuildPipeline("", "proj-1", "e1", 1, snapshot()))
        .rejects.toThrow("must not be blank");
      await expect(storage.saveBuildPipeline("p1", "", "e1", 1, snapshot()))
        .rejects.toThrow("must not be blank");
    });
  });
});
