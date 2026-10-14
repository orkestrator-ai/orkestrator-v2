import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService, type ResourceChange } from "./storage.js";
import type { StorageDatabase } from "./storage-database.js";
import { readStoredValue, seedStore, storageFilesContain } from "./storage-test-support.js";

class ProbeStorage extends StorageService {
  db(): StorageDatabase {
    return this.database;
  }
  atomic<T>(operation: () => Promise<T>): Promise<T> {
    return this.atomically(operation);
  }
  save(file: string, value: unknown): Promise<void> {
    return this.saveJson(this.file(file), value);
  }
  load<T>(file: string, fallback: () => T): Promise<T> {
    return this.loadJson(this.file(file), fallback);
  }
  remove(file: string): Promise<void> {
    return this.deleteStore(this.file(file));
  }
  update<V, T>(file: string, fallback: () => V, mutate: (value: V) => T): T {
    return this.updateStore(this.file(file), fallback, mutate);
  }
  scrub(): void {
    this.scrubDeletedDatabaseContent();
  }
  shout(id: string): void {
    this.announce("kanban", id);
  }
  serialize<T>(target: string, operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.file(target), "probe storage", operation, {
      acquireTimeoutMs: 2_000,
    });
  }
}

const directories: string[] = [];
const services: StorageService[] = [];

async function storage(directory?: string): Promise<{ storage: ProbeStorage; dataDir: string }> {
  const dataDir =
    directory ?? (await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-atomic-")));
  if (!directory) directories.push(dataDir);
  const service = new ProbeStorage(dataDir);
  services.push(service);
  await service.init();
  return { storage: service, dataDir };
}

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("atomically", () => {
  test("commits every store together and publishes announcements after the commit", async () => {
    const { storage: probe, dataDir } = await storage();
    const seen: ResourceChange[] = [];
    probe.addResourceChangeListener((change) => {
      // The commit already happened when a listener hears about it.
      expect(readStoredValue(dataDir, "kanban.json")).toEqual([{ id: "t1" }]);
      seen.push(change);
    });
    await probe.atomic(async () => {
      await probe.save("kanban.json", [{ id: "t1" }]);
      await probe.save("project-notes.json", [{ projectId: "p1", content: "x", updatedAt: "y" }]);
      // Reads inside see the buffered writes; other connections do not yet.
      expect(await probe.load("kanban.json", (): unknown[] => [])).toEqual([{ id: "t1" }]);
      expect(readStoredValue(dataDir, "kanban.json")).toBeUndefined();
      probe.shout("p1");
      expect(seen).toEqual([]);
    });
    expect(seen.map((change) => change.id)).toEqual(["p1"]);
    expect(readStoredValue(dataDir, "project-notes.json")).toHaveLength(1);
  });

  test("writes nothing and announces nothing when the operation throws", async () => {
    const { storage: probe, dataDir } = await storage();
    seedStore(dataDir, "kanban.json", [{ id: "before" }]);
    const seen: ResourceChange[] = [];
    probe.addResourceChangeListener((change) => seen.push(change));
    await expect(
      probe.atomic(async () => {
        await probe.save("kanban.json", [{ id: "after" }]);
        await probe.remove("project-notes.json");
        probe.shout("p1");
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(readStoredValue(dataDir, "kanban.json")).toEqual([{ id: "before" }]);
    expect(seen).toEqual([]);
  });

  test("leaves every store unchanged when the commit itself fails", async () => {
    const { storage: probe, dataDir } = await storage();
    seedStore(dataDir, "kanban.json", [{ id: "before" }]);
    const database = probe.db();
    const real = database.writeStoreInTransaction.bind(database);
    let calls = 0;
    // The second store's write fails after the first already ran in the transaction.
    const write = spyOn(database, "writeStoreInTransaction").mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      return real(...args);
    });
    try {
      await expect(
        probe.atomic(async () => {
          await probe.save("kanban.json", [{ id: "after" }]);
          await probe.save("project-notes.json", []);
        }),
      ).rejects.toThrow("disk full");
    } finally {
      write.mockRestore();
    }
    expect(readStoredValue(dataDir, "kanban.json")).toEqual([{ id: "before" }]);
    expect(readStoredValue(dataDir, "project-notes.json")).toBeUndefined();
    // The cache did not keep the rolled-back value either.
    expect(await probe.load("kanban.json", (): unknown[] => [])).toEqual([{ id: "before" }]);
  });

  test("buffers deletes and synchronous updates, then scrubs deleted content", async () => {
    const { storage: probe, dataDir } = await storage();
    await probe.save("linear-auth.json", { apiKey: "SECRET-LINEAR-KEY" });
    await probe.save("kanban.json", [{ id: "t1", body: "SECRET-TICKET-BODY" }]);
    expect(storageFilesContain(dataDir, "SECRET-TICKET-BODY")).toBe(true);
    await probe.atomic(async () => {
      await probe.remove("linear-auth.json");
      probe.update(
        "kanban.json",
        (): Array<{ id: string }> => [],
        (tasks) => {
          tasks.splice(0, 1, { id: "t2" });
        },
      );
      probe.scrub();
      expect(await probe.load("linear-auth.json", () => null)).toBeNull();
    });
    expect(readStoredValue(dataDir, "linear-auth.json")).toBeUndefined();
    expect(readStoredValue(dataDir, "kanban.json")).toEqual([{ id: "t2" }]);
    expect(storageFilesContain(dataDir, "SECRET-LINEAR-KEY")).toBe(false);
    expect(storageFilesContain(dataDir, "SECRET-TICKET-BODY")).toBe(false);
  });
});

describe("serializeMutation", () => {
  test("excludes two backends sharing a data directory", async () => {
    const { storage: first, dataDir } = await storage();
    const { storage: second } = await storage(dataDir);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const holding = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstRun = first.serialize("kanban.json", async () => {
      order.push("first:start");
      await holding;
      order.push("first:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondRun = second.serialize("kanban.json", async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("keeps running later mutations after one fails", async () => {
    const { storage: probe } = await storage();
    await expect(
      probe.serialize("kanban.json", async () => {
        throw new Error("first failed");
      }),
    ).rejects.toThrow("first failed");
    await expect(probe.serialize("kanban.json", async () => "second")).resolves.toBe("second");
  });
});

describe("updateStore", () => {
  test("serializes synchronous mutations from two backends without a lease", async () => {
    const { storage: first, dataDir } = await storage();
    const { storage: second } = await storage(dataDir);
    await Promise.all(
      Array.from({ length: 40 }, async (_, index) =>
        (index % 2 === 0 ? first : second).update(
          "project-notes.json",
          (): Array<{ projectId: string }> => [],
          (notes) => {
            notes.push({ projectId: `p${index}` });
          },
        ),
      ),
    );
    expect(readStoredValue<unknown[]>(dataDir, "project-notes.json")).toHaveLength(40);
  });
});
