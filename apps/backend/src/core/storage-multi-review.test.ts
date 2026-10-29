import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { StorageService } from "./storage.js";
import { LEGACY_JSON_DIRECTORY, openBackendDatabase } from "./storage-stores.js";
import {
  readStoredValue,
  seedStore,
  seedUnreadableStore,
  storageFilesContain,
  storageDatabase,
  storageInternals,
} from "./storage-test-support.js";

function workflow(id: string): MultiReviewWorkflow {
  const timestamp = new Date(0).toISOString();
  return {
    version: 1,
    controller: "backend",
    id,
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ id: `${id}-reviewer`, agent: "claude", model: "opus", status: "pending" }],
    fixModel: { agent: "codex", model: "gpt-5.6" },
    phase: "reviewing",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 0,
  };
}

/** A finished workflow: retained history that never blocks a new launch. */
function completed(id: string): MultiReviewWorkflow {
  return { ...workflow(id), phase: "completed" };
}

/** The store's private data directory, for inspecting files on disk. */
function storeDir(storage: StorageService): string {
  return storage.getDataDir();
}

async function withStorage(
  run: (storage: StorageService) => Promise<void>,
  options: {
    legacyMultiReviews?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-storage-multi-review-"));
  try {
    for (const [file, records] of [["multi-reviews.json", options.legacyMultiReviews]] as const) {
      if (!records) continue;
      // A pre-SQLite store and its backup: the first open imports them and
      // moves both into the retired JSON archive.
      const raw = JSON.stringify(records);
      await fs.writeFile(path.join(dataDir, file), raw);
      await fs.writeFile(path.join(dataDir, `${file}.bak.1`), raw);
    }
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "review",
      branch: "change",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/review",
      setupScriptsComplete: true,
    });
    try {
      await run(storage);
    } finally {
      storage.close();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test("Multi Review storage atomically enforces one active workflow per environment", async () => {
  await withStorage(async (storage) => {
    const outcomes = await Promise.all([
      storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1")),
      storage.createMultiReviewWorkflowIfNoActive("multi-2", "env-1", 1, workflow("multi-2")),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await storage.listMultiReviewWorkflows("env-1")).toHaveLength(1);
  });
});

test("Multi Review storage fences revisions and controller ownership", async () => {
  await withStorage(async (storage) => {
    const created = await storage.createMultiReviewWorkflowIfNoActive(
      "multi-1",
      "env-1",
      1,
      workflow("multi-1"),
    );
    expect(created?.revision).toBe(1);
    const claimed = await storage.claimMultiReviewController("multi-1", "owner-1", 2_000);
    expect(claimed.granted).toBe(true);
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      true,
    );
    expect((await storage.claimMultiReviewController("multi-1", "owner-2", 2_000)).granted).toBe(
      false,
    );

    const current = workflow("multi-1");
    current.backendRevision = 1;
    await expect(
      storage.saveMultiReviewWorkflow("multi-1", "env-1", 1, current, 0, {
        ownerId: "owner-1",
        token: claimed.token,
      }),
    ).rejects.toThrow("revision conflict");
    await storage.releaseMultiReviewController("multi-1", "owner-1", claimed.token);
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      false,
    );
    expect((await storage.claimMultiReviewController("multi-1", "owner-2", 2_000)).granted).toBe(
      true,
    );
  });
});

test("Multi Review lease writes leave workflow content and revision untouched", async () => {
  await withStorage(async (storage) => {
    await storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1"));
    const first = await storage.saveMultiReviewWorkflow(
      "multi-1",
      "env-1",
      1,
      { ...workflow("multi-1"), phase: "consolidating" },
      1,
    );
    await storage.saveMultiReviewWorkflow(
      "multi-1",
      "env-1",
      1,
      workflow("multi-1"),
      first.revision,
    );
    const dataDir = storeDir(storage);
    const committed = readStoredValue<Record<string, unknown>>(dataDir, "multi-reviews.json")!;

    for (let renewal = 0; renewal < 6; renewal++) {
      const claimed = await storage.claimMultiReviewController(
        "multi-1",
        `owner-${renewal}`,
        2_000,
      );
      expect(claimed.granted).toBe(true);
      await storage.releaseMultiReviewController("multi-1", `owner-${renewal}`, claimed.token);
    }

    // Lease churn is not a content commit: the released record is exactly the
    // last committed workflow, revision and timestamp included.
    expect(readStoredValue(dataDir, "multi-reviews.json")).toEqual(committed);
    expect((await storage.getMultiReviewWorkflow("multi-1"))?.revision).toBe(3);
    // No per-write backup or lock files accumulate beside the database.
    expect((await fs.readdir(dataDir)).filter((name) => name.startsWith("multi-reviews"))).toEqual(
      [],
    );
  });
});

test("Multi Review fence checks follow every write to the store", async () => {
  await withStorage(async (storage) => {
    await storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1"));
    const claimed = await storage.claimMultiReviewController("multi-1", "owner-1", 2_000);
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      true,
    );
    // Repeated checks against an unchanged store stay correct.
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      true,
    );
    expect(await storage.validateMultiReviewController("multi-1", "owner-2", claimed.token)).toBe(
      false,
    );

    // A write from another process replaces the store; the next check sees it.
    const dataDir = storeDir(storage);
    const stored = readStoredValue<Record<string, { controllerLease?: unknown }>>(
      dataDir,
      "multi-reviews.json",
    )!;
    delete stored["multi-1"]!.controllerLease;
    seedStore(dataDir, "multi-reviews.json", stored);
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      false,
    );
    expect(await storage.validateMultiReviewController("missing", "owner-1", claimed.token)).toBe(
      false,
    );
  });
});

test("Multi Review fence checks read one row and never wait for the store's lease", async () => {
  await withStorage(async (storage) => {
    for (let index = 0; index < 5; index++) {
      await storage.saveMultiReviewWorkflow(
        `retained-${index}`,
        "env-1",
        1,
        completed(`retained-${index}`),
      );
    }
    await storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1"));
    const claimed = await storage.claimMultiReviewController("multi-1", "owner-1", 15_000);

    // Another backend holds the Multi Review mutation lease throughout.
    const other = openBackendDatabase(storeDir(storage));
    const release = await other.acquireLease("multi-reviews.json", "another backend");
    const database = storageDatabase(storage);
    const wholeReads = spyOn(database, "readStore");
    const rowReads = spyOn(database, "readStoreRow");
    const leases = spyOn(database, "acquireLease");
    try {
      const checked = await Promise.race([
        storage.validateMultiReviewController("multi-1", "owner-1", claimed.token),
        Bun.sleep(1_000).then(() => "blocked behind the lease"),
      ]);
      expect(checked).toBe(true);
      expect(await storage.validateMultiReviewController("multi-1", "owner-2", claimed.token)).toBe(
        false,
      );
      expect(await storage.validateMultiReviewController("missing", "owner-1", claimed.token)).toBe(
        false,
      );
      // One row per check, whatever history the store retains.
      expect(rowReads).toHaveBeenCalledTimes(3);
      expect(wholeReads).not.toHaveBeenCalled();
      expect(leases).not.toHaveBeenCalled();
    } finally {
      wholeReads.mockRestore();
      rowReads.mockRestore();
      leases.mockRestore();
      await release();
      other.close();
    }
  });
});

test("Multi Review fence checks see another backend's claim, release and takeover at once", async () => {
  await withStorage(async (storage) => {
    const other = new StorageService(storeDir(storage));
    await other.init();
    try {
      await other.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1"));
      const first = await other.claimMultiReviewController("multi-1", "owner-1", 15_000);
      expect(await storage.validateMultiReviewController("multi-1", "owner-1", first.token)).toBe(
        true,
      );
      await other.releaseMultiReviewController("multi-1", "owner-1", first.token);
      expect(await storage.validateMultiReviewController("multi-1", "owner-1", first.token)).toBe(
        false,
      );
      const second = await other.claimMultiReviewController("multi-1", "owner-2", 15_000);
      expect(await storage.validateMultiReviewController("multi-1", "owner-2", second.token)).toBe(
        true,
      );
      expect(await storage.validateMultiReviewController("multi-1", "owner-1", first.token)).toBe(
        false,
      );

      // A workflow written after the first check is found by the next one.
      await other.saveMultiReviewWorkflow("multi-2", "env-1", 1, completed("multi-2"));
      const third = await other.claimMultiReviewController("multi-2", "owner-1", 15_000);
      expect(await storage.validateMultiReviewController("multi-2", "owner-1", third.token)).toBe(
        true,
      );
    } finally {
      other.close();
    }
  });
});

test("a stray JSON store from an older backend never answers a fence check", async () => {
  await withStorage(async (storage) => {
    await storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1"));
    const claimed = await storage.claimMultiReviewController("multi-1", "owner-1", 15_000);
    // An older backend sharing the directory still writes the retired file;
    // it is never read, so it cannot stand in for the database's leases.
    await fs.writeFile(
      path.join(storeDir(storage), "multi-reviews.json"),
      JSON.stringify(readStoredValue(storeDir(storage), "multi-reviews.json")),
    );
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      true,
    );
    await storage.releaseMultiReviewController("multi-1", "owner-1", claimed.token);
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      false,
    );
    const reclaimed = await storage.claimMultiReviewController("multi-1", "owner-2", 15_000);
    expect(await storage.validateMultiReviewController("multi-1", "owner-2", reclaimed.token)).toBe(
      true,
    );
  });
});

test("Multi Review reads and writes touch only the workflow they name", async () => {
  await withStorage(async (storage) => {
    const retained = await storage.saveMultiReviewWorkflow(
      "retained",
      "env-1",
      1,
      completed("retained"),
    );
    await storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1"));
    const database = storageDatabase(storage);
    const wholeReads = spyOn(database, "readStore");
    const wholeWrites = spyOn(database, "writeStore");
    try {
      const claimed = await storage.claimMultiReviewController("multi-1", "owner-1", 15_000);
      const saved = await storage.saveMultiReviewWorkflow(
        "multi-1",
        "env-1",
        1,
        { ...workflow("multi-1"), phase: "addressing" },
        1,
        { ownerId: "owner-1", token: claimed.token },
      );
      expect(saved.revision).toBe(2);
      expect((await storage.getMultiReviewWorkflow("multi-1"))?.revision).toBe(2);
      await storage.releaseMultiReviewController("multi-1", "owner-1", claimed.token);
      await storage.deleteMultiReviewWorkflow("multi-1");
      // The save's environment check reads the environments store; nothing
      // assembles or rewrites the Multi Review store.
      const multiReviewStore = ([store]: unknown[]) => store === "multi-reviews";
      expect(wholeReads.mock.calls.filter(multiReviewStore)).toEqual([]);
      expect(wholeWrites.mock.calls.filter(multiReviewStore)).toEqual([]);
    } finally {
      wholeReads.mockRestore();
      wholeWrites.mockRestore();
    }
    expect(await storage.getMultiReviewWorkflow("multi-1")).toBeNull();
    expect(await storage.getMultiReviewWorkflow("retained")).toEqual(retained);
  });
});

test("Multi Review writers in two backends lose no update", async () => {
  await withStorage(async (storage) => {
    const other = new StorageService(storeDir(storage));
    await other.init();
    try {
      await storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1"));
      await other.saveMultiReviewWorkflow("multi-2", "env-1", 1, completed("multi-2"));
      const lease = await storage.claimMultiReviewController("multi-1", "owner-1", 15_000);
      const fence = { ownerId: "owner-1", token: lease.token };
      for (let round = 0; round < 10; round++) {
        await Promise.all([
          storage.saveMultiReviewWorkflow(
            "multi-1",
            "env-1",
            1,
            workflow("multi-1"),
            round + 1,
            fence,
          ),
          (async () => {
            const claimed = await other.claimMultiReviewController("multi-2", "owner-2", 15_000);
            await other.releaseMultiReviewController("multi-2", "owner-2", claimed.token);
          })(),
        ]);
      }
      const first = await other.getMultiReviewWorkflow("multi-1");
      expect(first?.revision).toBe(11);
      // The concurrent lease churn on another workflow never reverted this
      // workflow's own lease.
      expect(first?.controllerLease).toMatchObject({ ownerId: "owner-1", token: lease.token });
      const second = await storage.getMultiReviewWorkflow("multi-2");
      expect(second?.revision).toBe(1);
      expect(second?.controllerLease).toBeUndefined();
    } finally {
      other.close();
    }
  });
});

test("an unreadable Multi Review store fails fence checks closed", async () => {
  await withStorage(async (storage) => {
    seedUnreadableStore(storeDir(storage), "multi-reviews.json");
    expect(await storage.getMultiReviewWorkflow("multi-1")).toBeNull();
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", "token")).toBe(false);
    await expect(storage.claimMultiReviewController("multi-1", "owner-1", 15_000)).rejects.toThrow(
      "Multi review workflow not found",
    );
  });
});

test("deleting a Multi Review scrubs it from the database and the retired JSON archive", async () => {
  const secret = "MULTI-REVIEW-SECRET-5d1c";
  const kept = "MULTI-REVIEW-KEPT-0b7e";
  const persisted = (id: string, marker: string) => ({
    version: 1,
    id,
    environmentId: "env-1",
    snapshot: { ...completed(id), targetBranch: marker },
    updatedAt: new Date(0).toISOString(),
    revision: 1,
  });
  await withStorage(
    async (storage) => {
      const dataDir = storeDir(storage);
      expect(storageFilesContain(dataDir, secret)).toBe(true);
      await storage.deleteMultiReviewWorkflow("multi-1");
      expect(await storage.getMultiReviewWorkflow("multi-1")).toBeNull();
      expect(storageFilesContain(dataDir, secret)).toBe(false);
      const stamp = (await fs.readdir(path.join(dataDir, LEGACY_JSON_DIRECTORY)))[0]!;
      for (const file of ["multi-reviews.json", "multi-reviews.json.bak.1"]) {
        const archived = await fs.readFile(
          path.join(dataDir, LEGACY_JSON_DIRECTORY, stamp, file),
          "utf8",
        );
        expect(archived).not.toContain(secret);
        expect(archived).toContain(kept);
      }
      expect((await storage.getMultiReviewWorkflow("multi-2"))?.snapshot).toMatchObject({
        targetBranch: kept,
      });
    },
    {
      legacyMultiReviews: {
        "multi-1": persisted("multi-1", secret),
        "multi-2": persisted("multi-2", kept),
      },
    },
  );
});

test("an environment sweep removes every Multi Review record that names it", async () => {
  await withStorage(async (storage) => {
    const secret = "MULTI-REVIEW-UNREADABLE-61aa";
    await storage.saveMultiReviewWorkflow("multi-1", "env-1", 1, completed("multi-1"));
    const dataDir = storeDir(storage);
    // A record this build cannot read still names its environment, so it
    // leaves with it; another environment's record stays.
    seedStore(dataDir, "multi-reviews.json", {
      ...readStoredValue<Record<string, unknown>>(dataDir, "multi-reviews.json"),
      unreadable: { environmentId: "env-1", note: secret },
      elsewhere: { environmentId: "env-2", note: "kept" },
    });
    await storage.deleteMultiReviewWorkflowsByEnvironment("env-1");
    expect(readStoredValue(dataDir, "multi-reviews.json")).toEqual({
      elsewhere: { environmentId: "env-2", note: "kept" },
    });
    expect(storageFilesContain(dataDir, secret)).toBe(false);
  });
});

test("multi review deletion retries scrubbing after the row deletion committed", async () => {
  const secret = "multi-RETRY-DELETE-SECRET-3f6a";
  const kept = "multi-RETRY-DELETE-KEPT-9b2c";
  const persisted = (id: string, marker: string) => ({
    version: 1,
    id,
    environmentId: "env-1",
    snapshot: { ...completed(id), targetBranch: marker },
    updatedAt: new Date(0).toISOString(),
    revision: 1,
  });
  const records = {
    "review-1": persisted("review-1", secret),
    "review-2": persisted("review-2", kept),
  };
  await withStorage(
    async (storage) => {
      const dataDir = storeDir(storage);
      const remove = (id: string) => storage.deleteMultiReviewWorkflow(id);
      const get = (id: string) => storage.getMultiReviewWorkflow(id);
      const changes: unknown[] = [];
      const unsubscribe = storage.addResourceChangeListener((change) => changes.push(change));
      const scrub = spyOn(
        storageInternals(storage).context,
        "scrubSensitiveJsonBackups",
      ).mockRejectedValueOnce(new Error("scrub interrupted"));
      try {
        await expect(remove("review-1")).rejects.toThrow("scrub interrupted");
        expect(await get("review-1")).toBeNull();
        expect(storageFilesContain(dataDir, secret)).toBe(true);
        const stamp = (await fs.readdir(path.join(dataDir, LEGACY_JSON_DIRECTORY)))[0]!;
        const archiveFiles = ["", ".bak.1"].map((suffix) =>
          path.join(dataDir, LEGACY_JSON_DIRECTORY, stamp, `multi-reviews.json${suffix}`),
        );
        for (const file of archiveFiles) expect(await fs.readFile(file, "utf8")).toContain(secret);

        await remove("review-1");

        expect(scrub).toHaveBeenCalledTimes(2);
        expect(changes).toHaveLength(1);
        expect(await get("review-1")).toBeNull();
        expect(storageFilesContain(dataDir, secret)).toBe(false);
        for (const file of archiveFiles) {
          const archived = await fs.readFile(file, "utf8");
          expect(archived).not.toContain(secret);
          expect(archived).toContain(kept);
        }
        expect((await get("review-2"))?.snapshot).toMatchObject({ targetBranch: kept });
      } finally {
        scrub.mockRestore();
        unsubscribe();
      }
    },
    { legacyMultiReviews: records },
  );
});

test("a successful fence read cannot authorize a save after another backend takes over", async () => {
  await withStorage(async (storage) => {
    const other = new StorageService(storeDir(storage));
    await other.init();
    const clock = spyOn(Date, "now").mockReturnValue(10_000);
    try {
      await storage.saveMultiReviewWorkflow("multi-1", "env-1", 1, workflow("multi-1"));
      const first = await storage.claimMultiReviewController("multi-1", "owner-1", 2_000);
      clock.mockReturnValue(11_999);
      expect(await storage.validateMultiReviewController("multi-1", "owner-1", first.token)).toBe(
        true,
      );

      clock.mockReturnValue(12_001);
      const second = await other.claimMultiReviewController("multi-1", "owner-2", 15_000);
      expect(second.granted).toBe(true);
      expect(second.token).not.toBe(first.token);
      // No intervening validation: the save itself must check the committed fence.
      await expect(
        storage.saveMultiReviewWorkflow(
          "multi-1",
          "env-1",
          1,
          { ...workflow("multi-1"), phase: "addressing" },
          1,
          { ownerId: "owner-1", token: first.token },
        ),
      ).rejects.toThrow("Multi review controller lease conflict");
      const unchanged = await other.getMultiReviewWorkflow("multi-1");
      expect(unchanged).toMatchObject({
        revision: 1,
        snapshot: workflow("multi-1"),
        controllerLease: { ownerId: "owner-2", token: second.token },
      });
      await expect(
        other.saveMultiReviewWorkflow(
          "multi-1",
          "env-1",
          1,
          { ...workflow("multi-1"), phase: "consolidating" },
          1,
          { ownerId: "owner-2", token: second.token },
        ),
      ).resolves.toMatchObject({ revision: 2, snapshot: { phase: "consolidating" } });
      await storage.releaseMultiReviewController("multi-1", "owner-1", first.token);
      expect(await other.validateMultiReviewController("multi-1", "owner-2", second.token)).toBe(
        true,
      );
    } finally {
      clock.mockRestore();
      other.close();
    }
  });
});
