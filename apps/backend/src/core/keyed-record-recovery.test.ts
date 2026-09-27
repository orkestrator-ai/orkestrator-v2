import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordFileStem } from "./keyed-record-format.js";
import {
  markMigrationComplete,
  readMigrationProgress,
  runKeyedRecordMigration,
  type KeyedRecordMigrationEntry,
} from "./keyed-record-migration.js";
import { KeyedRecordStore, type KeyedRecordStoreOptions } from "./keyed-record-store.js";

/**
 * Fault injection for the step-06 recovery matrix. A "crash" is a fault hook
 * that never resolves: the store instance is abandoned mid-operation exactly
 * where a dying process would stop, and a fresh instance on the same
 * directory plays the restarted process.
 */
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-keyed-recovery-"));
  directories.push(directory);
  return directory;
}

const never = () => new Promise<never>(() => undefined);

function storeAt(
  directory: string,
  overrides: Partial<KeyedRecordStoreOptions> = {},
): KeyedRecordStore {
  return new KeyedRecordStore({
    directory,
    namespace: "recovery/v1",
    schema: "recovery-record-v1",
    retentionClass: "cache",
    maxPayloadBytes: 4_096,
    maxRecords: 32,
    maxTotalPayloadBytes: 64 * 1_024,
    ...overrides,
  });
}

function recordPath(directory: string, key: string): string {
  return path.join(directory, `${recordFileStem("recovery/v1", key)}.rec`);
}

async function payloadOf(store: KeyedRecordStore, key: string): Promise<string | null> {
  const read = await store.get(key);
  return read.status === "found" ? read.payload.toString() : null;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!condition()) throw new Error("condition not reached");
}

describe("keyed record recovery matrix", () => {
  test("a crash before the payload is complete leaves the old record and an orphan temp", async () => {
    const directory = path.join(await tempDirectory(), "records");
    await storeAt(directory).put("key", "committed");
    let crashed = false;
    const dying = storeAt(directory, {
      faults: {
        at: (stage) => {
          if (stage !== "after-stage") return;
          crashed = true;
          return never();
        },
      },
    });
    void dying.put("key", "never-published");
    await waitFor(() => crashed);

    const restarted = storeAt(directory);
    expect(await payloadOf(restarted, "key")).toBe("committed");
    const temps = async () => (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"));
    expect(await temps()).toHaveLength(1);
    // Inside the grace window an active writer may still own the temp file.
    expect((await restarted.repair()).removedTemp).toBe(0);
    expect(await temps()).toHaveLength(1);
    const later = storeAt(directory, { now: () => Date.now() + 120_000 });
    expect((await later.repair()).removedTemp).toBe(1);
    expect(await temps()).toEqual([]);
    expect(await payloadOf(later, "key")).toBe("committed");
  });

  test("a crash after publish but before the index update is repaired from headers", async () => {
    const directory = path.join(await tempDirectory(), "records");
    await storeAt(directory).put("key", "one");
    let crashed = false;
    void storeAt(directory, {
      faults: {
        at: (stage) => {
          if (stage !== "before-index-commit") return;
          crashed = true;
          return never();
        },
      },
    }).put("key", "two-longer");
    await waitFor(() => crashed);
    const restarted = storeAt(directory);
    expect(await payloadOf(restarted, "key")).toBe("two-longer");
    await restarted.repair();
    const [entry] = await restarted.list();
    expect(entry).toMatchObject({ key: "key", revision: 2, payloadBytes: 10 });
  });

  test("a corrupt cache payload is an explicit miss that repair removes", async () => {
    const directory = path.join(await tempDirectory(), "records");
    const store = storeAt(directory);
    await store.put("key", "cached");
    await fs.writeFile(recordPath(directory, "key"), "garbage\n");
    expect(await store.get("key")).toEqual({ status: "corrupt", reason: "malformed-header" });
    expect((await storeAt(directory).repair()).removedCorrupt).toBe(1);
    expect(await store.get("key")).toEqual({ status: "missing" });
  });

  test("a corrupt durable payload recovers the validated prior generation or reports it", async () => {
    const directory = path.join(await tempDirectory(), "records");
    const store = storeAt(directory, { retentionClass: "durable" });
    await store.put("key", "generation-1");
    await store.put("key", "generation-2");
    const file = recordPath(directory, "key");
    const bytes = await fs.readFile(file);
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1);
    await fs.writeFile(file, bytes);
    const recovered = await store.get("key");
    expect(recovered.status).toBe("found");
    if (recovered.status !== "found") throw new Error("expected recovery");
    expect(recovered.generation).toBe("previous");
    expect(recovered.payload.toString()).toBe("generation-1");

    await fs.writeFile(file.replace(/\.rec$/, ".prev"), "corrupt too");
    expect(await store.get("key")).toEqual({ status: "corrupt", reason: "checksum-mismatch" });
    // Durable corruption is reported, never deleted by repair.
    await storeAt(directory, { retentionClass: "durable" }).repair();
    expect((await fs.readdir(directory)).filter((name) => !name.startsWith("_"))).toHaveLength(2);
  });

  test("an interrupted delete cannot be undone by the retained generation", async () => {
    const directory = path.join(await tempDirectory(), "records");
    await storeAt(directory, { retentionClass: "durable" }).put("key", "one");
    await storeAt(directory, { retentionClass: "durable" }).put("key", "two");
    let crashed = false;
    void storeAt(directory, {
      retentionClass: "durable",
      faults: {
        at: (stage) => {
          if (stage !== "after-delete-current") return;
          crashed = true;
          return never();
        },
      },
    }).delete("key");
    await waitFor(() => crashed);
    const restarted = storeAt(directory, { retentionClass: "durable" });
    expect(await restarted.get("key")).toEqual({ status: "missing" });
    expect((await restarted.repair()).removedOrphanPrevious).toBe(1);
    expect(await fs.readdir(directory)).toEqual(["_meta"]);
  });

  test("a stale writer in another instance gets a CAS conflict", async () => {
    const directory = path.join(await tempDirectory(), "records");
    const first = storeAt(directory);
    const second = storeAt(directory);
    await first.put("key", "base");
    expect(await second.put("key", "newer", { expectedRevision: 1 })).toMatchObject({
      status: "written",
      revision: 2,
    });
    expect(await first.put("key", "stale", { expectedRevision: 1 })).toEqual({
      status: "conflict",
      currentRevision: 2,
    });
    expect(await payloadOf(first, "key")).toBe("newer");
  });

  test("an unavailable quota index is rebuilt, never assumed empty", async () => {
    const directory = path.join(await tempDirectory(), "records");
    const options = { retentionClass: "durable" as const, maxTotalPayloadBytes: 100 };
    await storeAt(directory, options).put("a", "x".repeat(70));
    await fs.writeFile(path.join(directory, "_meta", "index.json"), "{corrupt");
    const restarted = storeAt(directory, options);
    expect(await restarted.put("b", "y".repeat(40))).toEqual({
      status: "rejected",
      reason: "quota",
    });
    expect(await restarted.put("b", "y".repeat(20))).toMatchObject({ status: "written" });

    // A rebuild that hits its scan bound is incomplete: durable admission
    // fails closed rather than trusting partial totals.
    await fs.rm(path.join(directory, "_meta", "index.json"));
    const bounded = storeAt(directory, { ...options, maxRepairEntries: 1 });
    expect(await bounded.put("c", "z")).toEqual({ status: "rejected", reason: "quota" });
    expect(bounded.lastReconcileReport()?.complete).toBe(false);
  });
});

describe("keyed record migration", () => {
  function entries(count: number): KeyedRecordMigrationEntry[] {
    return Array.from({ length: count }, (_, index) => ({
      key: `legacy-${index}`,
      payload: `legacy-payload-${index}`,
      owner: { environmentId: index % 2 === 0 ? "env-even" : "env-odd" },
      updatedAt: index,
    }));
  }

  test("imports once, skips invalid and existing records, and publishes completion", async () => {
    const directory = path.join(await tempDirectory(), "records");
    const store = storeAt(directory);
    await store.put("legacy-1", "live-write-wins");
    const result = await runKeyedRecordMigration(store, {
      id: "legacy",
      sourceFingerprint: "source-1",
      entries: () => [...entries(3), null],
      maxEntries: 10,
    });
    expect(result).toMatchObject({ status: "completed", imported: 2, existing: 1, invalid: 1 });
    expect(await payloadOf(store, "legacy-1")).toBe("live-write-wins");
    expect((await readMigrationProgress(store, "legacy"))?.completedAt).toBeNumber();
    const again = await runKeyedRecordMigration(store, {
      id: "legacy",
      sourceFingerprint: "source-1",
      entries: () => {
        throw new Error("a completed migration must not enumerate the source");
      },
      maxEntries: 10,
    });
    expect(again.status).toBe("already-complete");
  });

  test("a crash halfway through import resumes idempotently twice without resurrection", async () => {
    const directory = path.join(await tempDirectory(), "records");
    const source = entries(10);
    const crashAt = (position: number) => {
      let crashed = false;
      return {
        crashed: () => crashed,
        faults: {
          at: (stage: string, detail: { processed: number }) => {
            if (stage !== "after-record" || detail.processed !== position) return;
            crashed = true;
            return never();
          },
        },
      };
    };

    const first = crashAt(5);
    const firstStore = storeAt(directory);
    void runKeyedRecordMigration(firstStore, {
      id: "legacy",
      sourceFingerprint: "source-1",
      entries: () => source,
      maxEntries: 100,
      progressEvery: 2,
      faults: first.faults,
    });
    await waitFor(first.crashed);
    // The user deletes an imported record and a not-yet-imported one while
    // the import is down; the legacy source still holds both.
    const afterCrash = storeAt(directory);
    expect(await afterCrash.delete("legacy-1", { tombstone: true })).toBe(true);
    expect(await afterCrash.delete("legacy-7", { tombstone: true })).toBe(false);
    await afterCrash.tombstones.addOwner("environmentId", "env-odd");
    await afterCrash.deleteWhere((metadata) => metadata.owner.environmentId === "env-odd");

    const second = crashAt(8);
    void runKeyedRecordMigration(storeAt(directory), {
      id: "legacy",
      sourceFingerprint: "source-1",
      entries: () => source,
      maxEntries: 100,
      progressEvery: 2,
      faults: second.faults,
    });
    await waitFor(second.crashed);
    const progress = await readMigrationProgress(storeAt(directory), "legacy");
    expect(progress?.processed).toBeGreaterThanOrEqual(4);
    expect(progress?.completedAt).toBeUndefined();

    const finalStore = storeAt(directory);
    const result = await runKeyedRecordMigration(finalStore, {
      id: "legacy",
      sourceFingerprint: "source-1",
      entries: () => source,
      maxEntries: 100,
    });
    expect(result.status).toBe("completed");
    for (let index = 0; index < 10; index += 1) {
      const expected = index % 2 === 0 ? `legacy-payload-${index}` : null;
      expect(await payloadOf(finalStore, `legacy-${index}`)).toBe(expected);
    }
  });

  test("deletion racing an in-flight import wins", async () => {
    const directory = path.join(await tempDirectory(), "records");
    const store = storeAt(directory);
    let deleted = false;
    await runKeyedRecordMigration(store, {
      id: "legacy",
      sourceFingerprint: "source-1",
      entries: () => entries(4),
      maxEntries: 100,
      faults: {
        at: async (stage, detail) => {
          if (stage !== "after-record" || detail.processed !== 1 || deleted) return;
          deleted = true;
          await store.delete("legacy-0", { tombstone: true });
          await store.delete("legacy-3", { tombstone: true });
        },
      },
    });
    expect(await payloadOf(store, "legacy-0")).toBeNull();
    expect(await payloadOf(store, "legacy-3")).toBeNull();
    expect(await payloadOf(store, "legacy-2")).toBe("legacy-payload-2");
  });

  test("tombstones stay bounded and completion can be marked without a source", async () => {
    const directory = path.join(await tempDirectory(), "records");
    const store = storeAt(directory, { maxTombstones: 2 });
    await store.tombstones.addKey("a");
    await store.tombstones.addKey("b");
    expect((await store.tombstones.read()).overflowed).toBe(false);
    await store.tombstones.addKey("c");
    const bounded = await store.tombstones.read();
    expect(Object.keys(bounded.keys)).toHaveLength(2);
    expect(bounded.overflowed).toBe(true);
    await store.tombstones.retireAll();
    expect(await store.tombstones.read()).toMatchObject({ keys: {}, overflowed: false });

    await markMigrationComplete(store, "other", "absent");
    expect((await readMigrationProgress(store, "other"))?.completedAt).toBeNumber();
  });
});
