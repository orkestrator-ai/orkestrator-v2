import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { StorageDatabase, StoreCorruptError, type StoreLayout } from "./database.js";
import { ownedCachedValues } from "./database-rows.js";

type Item = { id: string; owner?: string; n?: number };

const layouts: Record<string, StoreLayout> = {
  items: { kind: "array", owner: (value) => (value as Item).owner },
  owned: { kind: "record", owner: (value) => (value as Item).owner },
};

const directories: string[] = [];
const open: StorageDatabase[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-owner-reads-"));
  directories.push(directory);
  return directory;
}

/** A connection that counts the serialized length of what it fetches. */
function connection(directory: string): { db: StorageDatabase; fetched: () => number } {
  let bytes = 0;
  const db = new StorageDatabase(directory, {
    layoutFor: (store) => layouts[store] ?? { kind: "document" },
    observeFetch: (length) => {
      bytes += length;
    },
  });
  open.push(db);
  return {
    db,
    fetched: () => {
      const total = bytes;
      bytes = 0;
      return total;
    },
  };
}

/** The answer of a connection with nothing cached. */
function uncached(directory: string, store: string, owner: string): unknown[] | null {
  const { db } = connection(directory);
  try {
    return db.readStoreRowsByOwner(store, owner);
  } finally {
    db.close();
  }
}

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("owner-scoped reads from the row cache", () => {
  test("a store cached at the committed revision answers without fetching", async () => {
    const directory = await dataDir();
    const { db, fetched } = connection(directory);
    db.writeStore("items", [
      { id: "1", owner: "p1" },
      { id: "2", owner: "p2" },
      { id: "3", owner: "p1" },
    ]);
    fetched();
    expect(db.readStoreRowsByOwner("items", "p1")).toEqual([
      { id: "1", owner: "p1" },
      { id: "3", owner: "p1" },
    ]);
    expect(db.readStoreRowsByOwner("items", "none")).toEqual([]);
    expect(fetched()).toBe(0);
  });

  test("whole-store and single-row writes keep the cached owners current", async () => {
    const directory = await dataDir();
    const { db, fetched } = connection(directory);
    db.writeStore("items", [
      { id: "1", owner: "p1" },
      { id: "2", owner: "p2" },
      { id: "3", owner: "p1" },
    ]);
    // Move one row to another owner, add one, keep one unchanged.
    db.writeStore("items", [
      { id: "1", owner: "p1", n: 1 },
      { id: "2", owner: "p1" },
      { id: "3", owner: "p1" },
      { id: "4", owner: "p2" },
    ]);
    db.updateStoreRow("items", "3", () => ({ result: null, value: { id: "3", owner: "p2" } }));
    db.updateStoreRow("items", "5", () => ({ result: null, value: { id: "5", owner: "p1" } }));
    fetched();
    const p1 = db.readStoreRowsByOwner("items", "p1");
    const p2 = db.readStoreRowsByOwner("items", "p2");
    expect(fetched()).toBe(0);
    expect(p1).toEqual([
      { id: "1", owner: "p1", n: 1 },
      { id: "2", owner: "p1" },
      { id: "5", owner: "p1" },
    ]);
    expect(p2).toEqual([
      { id: "3", owner: "p2" },
      { id: "4", owner: "p2" },
    ]);
    // Exactly what the database's owner column answers.
    expect(uncached(directory, "items", "p1")).toEqual(p1);
    expect(uncached(directory, "items", "p2")).toEqual(p2);
  });

  test("another connection's write makes the next read select from the database", async () => {
    const directory = await dataDir();
    const reader = connection(directory);
    const writer = connection(directory);
    writer.db.writeStore("owned", { a: { id: "a", owner: "p1" }, b: { id: "b", owner: "p2" } });
    reader.db.readStore("owned");
    reader.fetched();
    expect(reader.db.readStoreRowsByOwner("owned", "p2")).toEqual([{ id: "b", owner: "p2" }]);
    expect(reader.fetched()).toBe(0);

    writer.db.updateStoreRow("owned", "a", () => ({
      result: null,
      value: { id: "a", owner: "p2" },
    }));
    expect(reader.db.readStoreRowsByOwner("owned", "p2")).toEqual([
      { id: "a", owner: "p2" },
      { id: "b", owner: "p2" },
    ]);
    expect(reader.fetched()).toBeGreaterThan(0);
  });

  test("an unreadable cached row still reports the store as corrupt", async () => {
    const directory = await dataDir();
    const { db, fetched } = connection(directory);
    db.writeStore("owned", { a: { id: "a", owner: "p1" } });
    db.db.query("UPDATE store_rows SET value = '{' WHERE store = 'owned'").run();
    db.db.query("UPDATE stores SET revision = revision + 1 WHERE name = 'owned'").run();
    expect(Array.from(db.readStoreSerialized("owned")!.rows, (row) => row.value)).toEqual(["{"]);
    expect(fetched()).toBeGreaterThan(0);
    expect(() => db.readStoreRowsByOwner("owned", "p1")).toThrow(StoreCorruptError);
    expect(fetched()).toBe(0);
  });

  test("tied positions follow SQLite's binary ordering of Unicode keys", async () => {
    const directory = await dataDir();
    const { db, fetched } = connection(directory);
    const supplementary = { id: "\u{10000}", owner: "project" };
    const privateUse = { id: "\uE000", owner: "project" };
    db.transaction(() => {
      db.rows("owned").put(supplementary.id, JSON.stringify(supplementary), {
        owner: "project",
        position: 1,
      });
      db.rows("owned").put(privateUse.id, JSON.stringify(privateUse), {
        owner: "project",
        position: 1,
      });
    });

    const cold = uncached(directory, "owned", "project");
    expect(cold).toEqual([privateUse, supplementary]);
    db.readStoreSerialized("owned");
    fetched();
    expect(db.readStoreRowsByOwner("owned", "project")).toEqual(cold);
    expect(fetched()).toBe(0);
  });

  test("owner binding replaces lone surrogates in whole-store and single-row writes", async () => {
    const directory = await dataDir();
    const writer = connection(directory);
    const first = { id: "first", owner: "p\uD800" };
    const second = { id: "second", owner: "p\uDC00" };
    writer.db.writeStore("items", [first]);
    writer.db.updateStoreRow("items", second.id, () => ({ result: null, value: second }));
    const loaded = connection(directory);
    loaded.db.readStoreSerialized("items");
    writer.fetched();
    loaded.fetched();
    for (const owner of [first.owner, second.owner, "p\uFFFD"]) {
      const cold = uncached(directory, "items", owner);
      expect(cold).toEqual([first, second]);
      expect(writer.db.readStoreRowsByOwner("items", owner)).toEqual(cold);
      expect(loaded.db.readStoreRowsByOwner("items", owner)).toEqual(cold);
    }
    expect(writer.fetched()).toBe(0);
    expect(loaded.fetched()).toBe(0);
  });

  test("owner reads use the pending cache after each uncommitted write", async () => {
    const { db, fetched } = connection(await dataDir());
    const initial = { id: "a", owner: "original" };
    const edited = { id: "a", owner: "edited" };
    const updated = { id: "a", owner: "updated" };
    db.writeStore("items", [initial]);
    expect(() =>
      db.transaction(() => {
        db.writeStoreInTransaction("items", [edited]);
        fetched();
        expect(db.readStoreRowsByOwner("items", "edited")).toEqual([edited]);
        expect(fetched()).toBe(0);
        db.updateStoreRow("items", "a", () => ({ result: null, value: updated }));
        fetched();
        expect(db.readStoreRowsByOwner("items", "updated")).toEqual([updated]);
        expect(db.readStoreRowsByOwner("items", "edited")).toEqual([]);
        expect(fetched()).toBe(0);
        throw new Error("roll back owner edits");
      }),
    ).toThrow("roll back owner edits");
    expect(db.readStoreRowsByOwner("items", "original")).toEqual([initial]);
    expect(db.readStoreRowsByOwner("items", "updated")).toEqual([]);
    expect(fetched()).toBe(0);
  });
});

describe("ownedCachedValues", () => {
  test("orders by position then key, as the owner query does", () => {
    const rows = new Map([
      ["\u0000b", { collection: "", key: "b", position: 1, value: "B", owner: "o" }],
      ["\u0000a", { collection: "", key: "a", position: 1, value: "A", owner: "o" }],
      ["\u0000c", { collection: "", key: "c", position: 0, value: "C", owner: "o" }],
      ["\u0000d", { collection: "", key: "d", position: 2, value: "D", owner: null }],
    ]);
    expect(ownedCachedValues(rows, "o")).toEqual(["C", "A", "B"]);
  });

  test("declines when any cached row's owner is unknown", () => {
    const rows = new Map([
      ["\u0000a", { collection: "", key: "a", position: 0, value: "A", owner: "o" }],
      ["\u0000b", { collection: "", key: "b", position: 1, value: "B" }],
    ]);
    expect(ownedCachedValues(rows, "o")).toBeNull();
  });
});
