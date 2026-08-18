import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStorage<T>(run: (storage: StorageService) => Promise<T>): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-build-pipelines-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  for (const id of ["e1", "e2", "e3"]) {
    await storage.addEnvironment({
      id,
      projectId: "proj-1",
      name: id,
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
    });
  }
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
      expect(saved).toMatchObject({
        id: "p1",
        projectId: "proj-1",
        environmentId: "",
        revision: 1,
      });
      expect(await storage.getBuildPipeline("p1")).toMatchObject({ revision: 1 });
    });
  });

  test("increments the revision on every write", async () => {
    await withStorage(async (storage) => {
      expect((await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot())).revision).toBe(
        1,
      );
      expect((await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot())).revision).toBe(
        2,
      );
      expect((await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot())).revision).toBe(
        3,
      );
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

  test("atomically reserves one active pipeline per GitHub issue", async () => {
    await withStorage(async (storage) => {
      const githubSnapshot = (id: string, phase = "creating-environment") => ({
        id,
        phase,
        source: {
          type: "github",
          repositoryOwner: "OpenAI",
          repositoryName: "Codex",
          issueNumber: 42,
        },
      });
      await storage.saveBuildPipeline("p1", "proj-1", "", 1, githubSnapshot("p1"));
      await expect(
        storage.saveBuildPipeline("p2", "proj-1", "", 1, githubSnapshot("p2")),
      ).rejects.toThrow("active build already exists");

      await storage.saveBuildPipeline("p1", "proj-1", "", 1, githubSnapshot("p1", "complete"));
      await expect(
        storage.saveBuildPipeline("p2", "proj-1", "", 1, githubSnapshot("p2")),
      ).resolves.toMatchObject({ id: "p2" });
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
      await expect(storage.saveBuildPipeline("p1", "proj-2", "e1", 1, snapshot())).rejects.toThrow(
        "another project",
      );
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

  test("lists every valid pipeline across projects, oldest write first", async () => {
    await withStorage(async (storage) => {
      await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot());
      await storage.saveBuildPipeline("p2", "proj-2", "e2", 1, { id: "p2" });

      const file = path.join(storage.getDataDir(), "build-pipelines.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      stored.p1!.updatedAt = "2026-07-29T10:00:00.000Z";
      stored.p2!.updatedAt = "2026-07-29T09:00:00.000Z";
      stored.corrupt = { id: "corrupt", revision: "bad" };
      await fs.writeFile(file, JSON.stringify(stored));

      const listed = await storage.listAllBuildPipelines();
      expect(listed.map((entry) => [entry.id, entry.projectId])).toEqual([
        ["p2", "proj-2"],
        ["p1", "proj-1"],
      ]);
    });
  });

  test("deletes by environment and reports what it removed", async () => {
    await withStorage(async (storage) => {
      await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot());
      await storage.saveBuildPipeline("p2", "proj-1", "e1", 1, { id: "p2" });
      await storage.saveBuildPipeline("p3", "proj-1", "e2", 1, { id: "p3" });

      expect((await storage.deleteBuildPipelinesByEnvironment("e1")).sort()).toEqual(["p1", "p2"]);
      expect((await storage.listBuildPipelines("proj-1")).map((entry) => entry.id)).toEqual(["p3"]);
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

  test("rejects non-serializable snapshots and malformed revision metadata", async () => {
    await withStorage(async (storage) => {
      const circular: Record<string, unknown> = { id: "p1" };
      circular.self = circular;
      await expect(storage.saveBuildPipeline("p1", "proj-1", "e1", 1, circular)).rejects.toThrow(
        "JSON serializable",
      );
      await expect(storage.saveBuildPipeline("p1", "proj-1", "e1", 0, snapshot())).rejects.toThrow(
        "positive integer",
      );
      await expect(
        storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot(), -1),
      ).rejects.toThrow("non-negative integer");
      await expect(
        storage.saveBuildPipeline("p1", "proj-1", null as unknown as string, 1, snapshot()),
      ).rejects.toThrow("must be a string");
    });
  });

  test("rejects an over-sized snapshot rather than truncating the task", async () => {
    await withStorage(async (storage) => {
      const huge = { id: "p1", blob: "x".repeat(33 * 1024 * 1024) };
      await expect(storage.saveBuildPipeline("p1", "proj-1", "e1", 1, huge)).rejects.toThrow(
        "32 MB limit",
      );
    });
  });

  test("ignores a corrupt record instead of failing every read", async () => {
    await withStorage(async (storage) => {
      await storage.saveBuildPipeline("good", "proj-1", "e1", 1, snapshot());
      const file = path.join(storage.getDataDir(), "build-pipelines.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      stored.corrupt = { id: "corrupt", revision: "not-a-number" };
      await fs.writeFile(file, JSON.stringify(stored));

      expect((await storage.listBuildPipelines("proj-1")).map((entry) => entry.id)).toEqual([
        "good",
      ]);
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

  test("serializes concurrent writes across StorageService instances", async () => {
    await withStorage(async (storage) => {
      const second = new StorageService(storage.getDataDir());
      await second.init();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          (index % 2 === 0 ? storage : second).saveBuildPipeline(
            "p1",
            "proj-1",
            "e1",
            1,
            snapshot(),
          ),
        ),
      );
      expect(results.map((result) => result.revision).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });
  });

  test("rejects a nonblank environment that does not exist or is being deleted", async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.saveBuildPipeline("missing", "proj-1", "missing", 1, snapshot()),
      ).rejects.toThrow("environment not found");

      await storage.updateEnvironment("e1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot())).rejects.toThrow(
        "being deleted",
      );
    });
  });

  test("deletes a linked pipeline while its stored environment id is still blank", async () => {
    await withStorage(async (storage) => {
      await storage.saveBuildPipeline("p1", "proj-1", "", 1, snapshot());
      await storage.updateEnvironment("e1", { buildPipelineId: "p1" });

      expect(await storage.deleteBuildPipelinesByEnvironment("e1", "p1")).toEqual(["p1"]);
      expect(await storage.getBuildPipeline("p1")).toBeNull();
    });
  });

  test("rejects blank identifiers", async () => {
    await withStorage(async (storage) => {
      await expect(storage.getBuildPipeline("")).rejects.toThrow("must not be blank");
      await expect(storage.listBuildPipelines("")).rejects.toThrow("must not be blank");
      await expect(storage.saveBuildPipeline("", "proj-1", "e1", 1, snapshot())).rejects.toThrow(
        "must not be blank",
      );
      await expect(storage.saveBuildPipeline("p1", "", "e1", 1, snapshot())).rejects.toThrow(
        "must not be blank",
      );
      await expect(storage.deleteBuildPipeline("")).rejects.toThrow("must not be blank");
      await expect(storage.deleteBuildPipelinesByEnvironment("")).rejects.toThrow(
        "must not be blank",
      );
      await expect(storage.deleteBuildPipelinesByEnvironment("e1", "   ")).rejects.toThrow(
        "must not be blank",
      );
    });
  });

  describe("backup scrubbing", () => {
    /** Every retained copy of the pipeline file, primary and backups. */
    async function readAllCopies(storage: StorageService): Promise<string> {
      const dir = storage.getDataDir();
      const names = (await fs.readdir(dir)).filter((name) =>
        name.startsWith("build-pipelines.json"),
      );
      const contents = await Promise.all(
        names.map((name) => fs.readFile(path.join(dir, name), "utf8")),
      );
      return contents.join("\n");
    }

    test("removes a deleted environment's task snapshots from every retained backup", async () => {
      await withStorage(async (storage) => {
        // Task snapshots embed attachment data and full review findings, so an
        // early revision surviving in a backup is a real disclosure.
        await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, {
          id: "p1",
          phase: "building",
          notes: "EMBEDDED-ATTACHMENT",
        });
        await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot("reviewing"), 1);
        await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot("complete"), 2);
        expect(await readAllCopies(storage)).toContain("EMBEDDED-ATTACHMENT");

        await storage.deleteBuildPipelinesByEnvironment("e1");

        expect(await readAllCopies(storage)).not.toContain("EMBEDDED-ATTACHMENT");
      });
    });

    test("single-pipeline deletion removes its snapshots from every retained backup", async () => {
      await withStorage(async (storage) => {
        await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, {
          id: "p1",
          phase: "building",
          notes: "SINGLE-DELETE-SECRET",
        });
        await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot("reviewing"), 1);
        expect(await readAllCopies(storage)).toContain("SINGLE-DELETE-SECRET");

        await storage.deleteBuildPipeline("p1");

        expect(await readAllCopies(storage)).not.toContain("SINGLE-DELETE-SECRET");
      });
    });

    test("leaves another environment's pipelines intact in the backups", async () => {
      await withStorage(async (storage) => {
        await storage.saveBuildPipeline("p2", "proj-1", "e2", 1, {
          id: "p2",
          phase: "building",
          notes: "KEEP-ME",
        });
        await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, {
          id: "p1",
          phase: "building",
          notes: "DROP-ME",
        });
        await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot("complete"), 1);

        await storage.deleteBuildPipelinesByEnvironment("e1");

        const all = await readAllCopies(storage);
        expect(all).toContain("KEEP-ME");
        expect(all).not.toContain("DROP-ME");
        expect(await storage.getBuildPipeline("p2")).not.toBeNull();
      });
    });

    test("discards a corrupt backup that cannot be proven scrubbed", async () => {
      await withStorage(async (storage) => {
        await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, {
          id: "p1",
          phase: "building",
          notes: "SENSITIVE",
        });
        await storage.saveBuildPipeline("p1", "proj-1", "e1", 1, snapshot("complete"), 1);
        const backup = path.join(storage.getDataDir(), "build-pipelines.json.bak.1");
        await fs.writeFile(backup, "{ not json SENSITIVE");

        await storage.deleteBuildPipelinesByEnvironment("e1");

        expect(await readAllCopies(storage)).not.toContain("SENSITIVE");
      });
    });

    test("does not touch backups when the environment owned no pipelines", async () => {
      await withStorage(async (storage) => {
        await storage.saveBuildPipeline("p2", "proj-1", "e2", 1, {
          id: "p2",
          phase: "building",
          notes: "KEEP-ME",
        });
        await storage.saveBuildPipeline("p2", "proj-1", "e2", 1, snapshot("complete"), 1);

        expect(await storage.deleteBuildPipelinesByEnvironment("e1")).toEqual([]);

        expect(await readAllCopies(storage)).toContain("KEEP-ME");
      });
    });
  });
});
