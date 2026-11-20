import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { StorageDatabase, type StoreLayout } from "./storage-database.js";
import { ownedCachedValues } from "./storage-database-rows.js";

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
    const { db } = connection(directory);
    db.writeStore("owned", { a: { id: "a", owner: "p1" } });
    db.db.query("UPDATE store_rows SET value = '{' WHERE store = 'owned'").run();
    db.db.query("UPDATE stores SET revision = revision + 1 WHERE name = 'owned'").run();
    expect(() => db.readStoreRowsByOwner("owned", "p1")).toThrow("Storage owned is unreadable");
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
