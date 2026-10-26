import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEnvironment, StorageService, type ResourceChange } from "./storage.js";
import { LEGACY_JSON_DIRECTORY } from "./storage-stores.js";
import type { StorageDatabase } from "./storage-database.js";
import {
  readStoredValue,
  seedStore,
  storageFilesContain,
  storageInternals,
} from "./storage-test-support.js";

/** Drives the store primitives of a running service's `StorageContext`. */
class ProbeStorage extends StorageService {
  private get primitives() {
    return storageInternals(this).context;
  }
  db(): StorageDatabase {
    return this.primitives.database;
  }
  atomic<T>(operation: () => Promise<T>): Promise<T> {
    return this.primitives.atomically(operation);
  }
  save(file: string, value: unknown): Promise<void> {
    return this.primitives.saveJson(this.primitives.file(file), value);
  }
  sensitive(file: string, value: unknown): Promise<void> {
    return this.primitives.saveSensitiveJson(this.primitives.file(file), value);
  }
  load<T>(file: string, fallback: () => T): Promise<T> {
    return this.primitives.loadJson(this.primitives.file(file), fallback);
  }
  remove(file: string): Promise<void> {
    return this.primitives.deleteStore(this.primitives.file(file));
  }
  update<V, T>(file: string, fallback: () => V, mutate: (value: V) => T): T {
    return this.primitives.updateStore(this.primitives.file(file), fallback, mutate);
  }
  scrub(): void {
    this.primitives.scrubDeletedDatabaseContent();
  }
  shout(id: string): void {
    this.primitives.changes.announce("kanban", id);
  }
  serialize<T>(target: string, operation: () => Promise<T>): Promise<T> {
    return this.primitives.serialize(this.primitives.file(target), "probe storage", operation, {
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

  test.each(["rollback", "commit failure", "intent failure", "commit"])(
    "archive deletes and prunes follow the database %s",
    async (outcome) => {
      const { storage: probe, dataDir } = await storage();
      const drafts = { gone: { text: "PRIVATE-DRAFT" }, kept: { text: "kept" } };
      await probe.save("compose-drafts.json", drafts);
      await probe.save("linear-auth.json", { apiKey: "PRIVATE-KEY" });
      const archive = path.join(dataDir, LEGACY_JSON_DIRECTORY, "generation");
      await fs.mkdir(archive, { recursive: true });
      for (const suffix of ["", ".bak.1"]) {
        await fs.writeFile(
          path.join(archive, `compose-drafts.json${suffix}`),
          JSON.stringify(drafts),
        );
        await fs.writeFile(
          path.join(archive, `linear-auth.json${suffix}`),
          '{"apiKey":"PRIVATE-KEY"}',
        );
      }
      const realWrite = probe.db().writeStoreInTransaction.bind(probe.db());
      const write =
        outcome === "commit failure" || outcome === "intent failure"
          ? spyOn(probe.db(), "writeStoreInTransaction").mockImplementation((...args) => {
              if (outcome === "commit failure" || args[0] === "storage-legacy-json-cleanups") {
                throw new Error("disk full");
              }
              return realWrite(...args);
            })
          : undefined;
      try {
        const result = probe.atomic(async () => {
          await probe.remove("linear-auth.json");
          await probe.sensitive("compose-drafts.json", { kept: drafts.kept });
          for (const suffix of ["", ".bak.1"]) {
            expect(
              await fs.readFile(path.join(archive, `compose-drafts.json${suffix}`), "utf8"),
            ).toContain("PRIVATE-DRAFT");
            expect(
              await fs.readFile(path.join(archive, `linear-auth.json${suffix}`), "utf8"),
            ).toContain("PRIVATE-KEY");
          }
          if (outcome === "rollback") throw new Error("refused");
        });
        if (outcome === "commit") await result;
        else await expect(result).rejects.toThrow(outcome === "rollback" ? "refused" : "disk full");
      } finally {
        write?.mockRestore();
      }
      for (const suffix of ["", ".bak.1"]) {
        const contents = await fs.readFile(
          path.join(archive, `compose-drafts.json${suffix}`),
          "utf8",
        );
        expect(contents.includes("PRIVATE-DRAFT")).toBe(outcome !== "commit");
        expect(
          await fs.access(path.join(archive, `linear-auth.json${suffix}`)).then(
            () => true,
            () => false,
          ),
        ).toBe(outcome !== "commit");
      }
      expect(readStoredValue(dataDir, "compose-drafts.json")).toEqual(
        outcome === "commit" ? { kept: drafts.kept } : drafts,
      );
      expect(readStoredValue(dataDir, "linear-auth.json") !== undefined).toBe(outcome !== "commit");
      // A later write cannot accidentally replay intents from a rolled-back scope.
      await probe.save("project-notes.json", []);
      expect(
        (await fs.readFile(path.join(archive, "compose-drafts.json"), "utf8")).includes(
          "PRIVATE-DRAFT",
        ),
      ).toBe(outcome !== "commit");
    },
  );

  test.each([false, true])(
    "environment attachment archive cleanup follows commit (rollback=%s)",
    async (rollback) => {
      const { storage: probe, dataDir } = await storage();
      const environment = createEnvironment("project-1");
      environment.initialPromptAttachments = [
        { id: "a", name: "private.png", base64Data: "ATOMIC-ATTACHMENT" },
      ];
      await probe.addEnvironment(environment);
      const archive = path.join(dataDir, LEGACY_JSON_DIRECTORY, "generation");
      await fs.mkdir(archive, { recursive: true });
      for (const suffix of ["", ".bak.1"]) {
        await fs.writeFile(
          path.join(archive, `environments.json${suffix}`),
          JSON.stringify([environment]),
        );
      }
      const mutation = probe.atomic(async () => {
        await probe.updateEnvironment(environment.id, { initialPromptAttachments: null });
        expect(await fs.readFile(path.join(archive, "environments.json"), "utf8")).toContain(
          "ATOMIC-ATTACHMENT",
        );
        if (rollback) throw new Error("refused");
      });
      if (rollback) await expect(mutation).rejects.toThrow("refused");
      else await mutation;
      for (const suffix of ["", ".bak.1"]) {
        expect(
          (await fs.readFile(path.join(archive, `environments.json${suffix}`), "utf8")).includes(
            "ATOMIC-ATTACHMENT",
          ),
        ).toBe(rollback);
      }
      expect(
        (await probe.getEnvironment(environment.id))?.initialPromptAttachments !== undefined,
      ).toBe(rollback);
    },
  );

  test("successive pruning targets cannot restore content deleted earlier in the same scope", async () => {
    const { storage: probe, dataDir } = await storage();
    const drafts = { a: { text: "FIRST-SECRET" }, b: { text: "SECOND-SECRET" } };
    await probe.save("compose-drafts.json", drafts);
    const archive = path.join(dataDir, LEGACY_JSON_DIRECTORY, "generation");
    await fs.mkdir(archive, { recursive: true });
    await fs.writeFile(path.join(archive, "compose-drafts.json"), JSON.stringify(drafts));
    await probe.atomic(async () => {
      await probe.sensitive("compose-drafts.json", { b: drafts.b });
      await probe.sensitive("compose-drafts.json", {});
      // Reintroduce a record into the live store; the downgrade copy stays scrubbed.
      await probe.sensitive("compose-drafts.json", { a: { text: "recreated" } });
    });
    expect(
      JSON.parse(await fs.readFile(path.join(archive, "compose-drafts.json"), "utf8")),
    ).toEqual({});
    expect(storageFilesContain(dataDir, "FIRST-SECRET")).toBe(false);
    expect(storageFilesContain(dataDir, "SECOND-SECRET")).toBe(false);
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

describe("StorageContext.serialize", () => {
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

describe("Linear auth mutations", () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

  test("wait for another backend holding the linear-auth.json lease", async () => {
    const { storage: first, dataDir } = await storage();
    const { storage: second } = await storage(dataDir);

    let release!: () => void;
    let held = first.serialize(
      "linear-auth.json",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await pause();
    const saving = second.kanban.saveLinearAuth("SECOND-KEY");
    await pause();
    expect(await first.kanban.getLinearAuth()).toBeNull();
    release();
    await Promise.all([held, saving]);
    expect((await first.kanban.getLinearAuth())?.apiKey).toBe("SECOND-KEY");

    held = first.serialize(
      "linear-auth.json",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await pause();
    const clearing = second.kanban.clearLinearAuth();
    await pause();
    expect((await first.kanban.getLinearAuth())?.apiKey).toBe("SECOND-KEY");
    release();
    await Promise.all([held, clearing]);
    expect(await first.kanban.getLinearAuth()).toBeNull();
  });

  test("run after a failed mutation releases the lease", async () => {
    const { storage: first, dataDir } = await storage();
    const { storage: second } = await storage(dataDir);

    let fail!: (error: Error) => void;
    const failing = first.serialize(
      "linear-auth.json",
      () => new Promise<void>((_, reject) => (fail = reject)),
    );
    // Observe the rejection without awaiting it before the holder fails.
    const failed = failing.then(
      () => null,
      (error: Error) => error.message,
    );
    await pause();
    const saving = first.kanban.saveLinearAuth("QUEUED-KEY");
    await pause();
    expect(await second.kanban.getLinearAuth()).toBeNull();
    fail(new Error("holder failed"));
    expect(await failed).toBe("holder failed");
    await saving;
    expect((await second.kanban.getLinearAuth())?.apiKey).toBe("QUEUED-KEY");
    // The other backend can take the lease again.
    await second.kanban.clearLinearAuth();
    expect(await first.kanban.getLinearAuth()).toBeNull();
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
