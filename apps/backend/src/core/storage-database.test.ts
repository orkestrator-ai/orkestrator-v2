import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STORAGE_DATABASE_FILE,
  StorageDatabase,
  StorageDatabaseVersionError,
  StoreConflictError,
  type StoreLayout,
} from "./storage-database.js";

const directories: string[] = [];
const open: StorageDatabase[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-db-"));
  directories.push(directory);
  return directory;
}

const layouts: Record<string, StoreLayout> = {
  items: { kind: "array", owner: (value) => (value as { owner?: string }).owner },
  records: { kind: "record" },
  mail: { kind: "envelope", collections: ["mailboxes", "idempotency"] },
  "items-by-key": { kind: "record" },
  owned: { kind: "record", owner: (value) => (value as { owner?: string }).owner },
};

function database(
  directory: string,
  options: ConstructorParameters<typeof StorageDatabase>[1] = {},
) {
  const db = new StorageDatabase(directory, {
    layoutFor: (store) => layouts[store] ?? { kind: "document" },
    ...options,
  });
  open.push(db);
  return db;
}

function rowCount(db: StorageDatabase, store: string): number {
  return (
    db.db.query("SELECT count(*) AS count FROM store_rows WHERE store = ?").get(store) as {
      count: number;
    }
  ).count;
}

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("StorageDatabase", () => {
  test("row byte counts use portable SQLite SQL and count UTF-8 bytes", async () => {
    const db = database(await dataDir());
    const value = JSON.stringify({ text: "café 🐙" });
    db.transaction(() => db.rows("records").put("unicode", value));
    expect(db.rows("records").entry("unicode")?.bytes).toBe(Buffer.byteLength(value));
    expect(db.rows("records").list()[0]?.bytes).toBe(Buffer.byteLength(value));
    expect(db.rows("records").list({ values: false })[0]?.bytes).toBe(Buffer.byteLength(value));
  });

  test("creates a private WAL database", async () => {
    const directory = await dataDir();
    const db = database(directory);
    const stat = await fs.stat(path.join(directory, STORAGE_DATABASE_FILE));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(
      (db.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    expect(db.schemaVersion()).toBe(1);
  });

  test("round-trips every layout and reports absent stores as null", async () => {
    const db = database(await dataDir());
    expect(db.readStore("items")).toBeNull();
    db.writeStore("config", { nested: { value: [1, 2] } });
    db.writeStore("items", [
      { id: "b", owner: "p1", n: 1 },
      { id: "a", owner: "p2", n: 2 },
    ]);
    db.writeStore("records", { z: { n: 1 }, y: { n: 2 } });
    db.writeStore("mail", {
      version: 1,
      revision: 4,
      mailboxes: { m1: { messages: [] } },
      idempotency: {},
      pendingInject: [],
    });

    expect(db.readStore("config")?.value).toEqual({ nested: { value: [1, 2] } });
    expect(db.readStore("items")?.value).toEqual([
      { id: "b", owner: "p1", n: 1 },
      { id: "a", owner: "p2", n: 2 },
    ]);
    expect(Object.keys(db.readStore("records")?.value as object)).toEqual(["z", "y"]);
    expect(db.readStore("mail")?.value).toEqual({
      version: 1,
      revision: 4,
      mailboxes: { m1: { messages: [] } },
      idempotency: {},
      pendingInject: [],
    });
    expect(rowCount(db, "items")).toBe(2);
    expect(rowCount(db, "mail")).toBe(1);
  });

  test("returns fresh values so callers can mutate them", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: { list: [1] } });
    const first = db.readStore("records")!.value as Record<string, { list: number[] }>;
    first.a!.list.push(2);
    expect(db.readStore("records")?.value).toEqual({ a: { list: [1] } });
  });

  test("writes only the rows that changed", async () => {
    const db = database(await dataDir());
    db.writeStore(
      "records",
      Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, { index }])),
    );
    let statements = 0;
    const original = db.db.query.bind(db.db);
    db.db.query = ((sql: string) => {
      const statement = original(sql);
      if (/^\s*(INSERT INTO store_rows|DELETE FROM store_rows WHERE store = \? AND)/.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = ((...args: unknown[]) => {
          statements += 1;
          return run(...(args as []));
        }) as typeof statement.run;
      }
      return statement;
    }) as typeof db.db.query;
    const value = db.readStore("records")!.value as Record<string, { index: number }>;
    value.k7 = { index: -7 };
    delete value.k8;
    db.writeStore("records", value);
    expect(statements).toBe(2);
    expect(rowCount(db, "records")).toBe(49);
  });

  test("falls back to a whole document when items cannot be keyed", async () => {
    const db = database(await dataDir());
    db.writeStore("items", [{ id: "a" }, { id: "a" }]);
    expect(rowCount(db, "items")).toBe(0);
    expect(db.readStore("items")?.value).toEqual([{ id: "a" }, { id: "a" }]);
    db.writeStore("items", [{ id: "a" }, { id: "b" }]);
    expect(rowCount(db, "items")).toBe(2);
    db.writeStore("items", { not: "an array" });
    expect(rowCount(db, "items")).toBe(0);
    expect(db.readStore("items")?.value).toEqual({ not: "an array" });
  });

  test("observes commits from another connection", async () => {
    const directory = await dataDir();
    const first = database(directory);
    const second = database(directory);
    first.writeStore("records", { a: 1 });
    expect(second.readStore("records")?.value).toEqual({ a: 1 });
    second.writeStore("records", { a: 2, b: 3 });
    expect(first.readStore("records")?.value).toEqual({ a: 2, b: 3 });
    expect(first.storeRevision("records")).toBe(2);
  });

  test("diffs against the committed rows after a foreign write", async () => {
    const directory = await dataDir();
    const first = database(directory);
    const second = database(directory);
    first.writeStore("records", { a: 1, b: 2 });
    second.writeStore("records", { a: 1, c: 3 });
    // `first` still caches revision 1 with row "b"; its write must delete "c".
    first.writeStore("records", { a: 1 });
    expect(second.readStore("records")?.value).toEqual({ a: 1 });
    expect(rowCount(second, "records")).toBe(1);
  });

  test("refuses a write whose expected revision moved", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: 1 });
    expect(() => db.writeStore("records", { a: 2 }, { expectedRevision: 0 })).toThrow(
      StoreConflictError,
    );
    expect(() => db.writeStore("other", { a: 2 }, { expectedRevision: 1 })).toThrow(
      StoreConflictError,
    );
    db.writeStore("other", { a: 2 }, { expectedRevision: null });
    expect(db.storeRevision("other")).toBe(1);
  });

  test("commits several stores atomically", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: 1 });
    expect(() =>
      db.transaction(() => {
        db.writeStoreInTransaction("records", { a: 2 });
        db.writeStoreInTransaction("items", [{ id: "x" }]);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    // The cache must not keep the rolled-back revision either.
    expect(db.readStore("records")?.value).toEqual({ a: 1 });
    expect(db.readStore("items")).toBeNull();
  });

  test("reads rows by owner and by key", async () => {
    const db = database(await dataDir());
    db.writeStore("items", [
      { id: "1", owner: "p1" },
      { id: "2", owner: "p2" },
      { id: "3", owner: "p1" },
    ]);
    expect(db.readStoreRowsByOwner("items", "p1")).toEqual([
      { id: "1", owner: "p1" },
      { id: "3", owner: "p1" },
    ]);
    expect(db.readStoreRow("items", "2")).toEqual({ id: "2", owner: "p2" });
    expect(db.readStoreRow("items", "missing")).toBeUndefined();
    db.writeStore("mail", { mailboxes: { m: { n: 1 } }, idempotency: {} });
    expect(db.readStoreRow("mail", "m", "mailboxes")).toEqual({ n: 1 });
  });

  test.each([
    ["records", "a", "", { a: { n: 1 } }, { a: { n: 2 } }],
    ["items", "a", "", [{ id: "a", n: 1 }], [{ id: "a", n: 2 }]],
    ["mail", "a", "mailboxes", { mailboxes: { a: { n: 1 } } }, { mailboxes: { a: { n: 2 } } }],
  ])(
    "keyed reads follow %s document and row representation changes",
    async (store, key, collection, first, second) => {
      const directory = await dataDir();
      const writer = database(directory);
      const reader = database(directory);
      expect(reader.readStoreRow(store, key, collection)).toBeUndefined();
      writer.transaction(() => writer.writeRawDocumentInTransaction(store, JSON.stringify(first)));
      expect(reader.readStoreRow(store, key, collection)).toMatchObject({ n: 1 });
      // A whole-store cached document must not mask the later row representation.
      reader.readStore(store);
      writer.writeStore(store, second);
      expect(reader.readStoreRow(store, key, collection)).toMatchObject({ n: 2 });
      writer.transaction(() => writer.writeRawDocumentInTransaction(store, JSON.stringify(first)));
      expect(reader.readStoreRow(store, key, collection)).toMatchObject({ n: 1 });
    },
  );

  test("deletes stores and lists them by prefix", async () => {
    const db = database(await dataDir());
    db.writeStore("ops/a", 1);
    db.writeStore("ops/b", 2);
    db.writeStore("other", 3);
    expect(db.listStores("ops/")).toEqual(["ops/a", "ops/b"]);
    db.deleteStore("ops/a");
    expect(db.readStore("ops/a")).toBeNull();
    expect(db.listStores("ops/")).toEqual(["ops/b"]);
  });

  test("runs migrations once and refuses a newer database", async () => {
    const directory = await dataDir();
    let runs = 0;
    const migrations = [
      {
        version: 2,
        name: "seed",
        up: ({ db }: { db: import("bun:sqlite").Database }) => {
          runs += 1;
          db.exec("CREATE TABLE seeded (id INTEGER)");
        },
      },
    ];
    database(directory, { migrations }).close();
    const reopened = database(directory, { migrations });
    expect(runs).toBe(1);
    expect(reopened.schemaVersion()).toBe(2);
    reopened.close();
    expect(() => database(directory)).toThrow(StorageDatabaseVersionError);
  });

  test("rolls back a failed migration", async () => {
    const directory = await dataDir();
    expect(() =>
      database(directory, {
        migrations: [
          {
            version: 2,
            name: "broken",
            up: ({ db }) => {
              db.exec("CREATE TABLE half (id INTEGER)");
              throw new Error("migration failed");
            },
          },
        ],
      }),
    ).toThrow("migration failed");
    const db = database(directory);
    expect(db.schemaVersion()).toBe(0 + 1);
    expect(db.db.query("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeNull();
  });

  describe("leases", () => {
    test("excludes a second holder until release", async () => {
      const directory = await dataDir();
      const first = database(directory);
      const second = database(directory);
      const release = await first.acquireLease("store", "test");
      let acquired = false;
      const waiting = second.acquireLease("store", "test").then((releaseSecond) => {
        acquired = true;
        return releaseSecond;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(acquired).toBe(false);
      await release();
      await (
        await waiting
      )();
      expect(acquired).toBe(true);
    });

    test("times out against a live holder", async () => {
      const directory = await dataDir();
      const first = database(directory);
      const release = await first.acquireLease("store", "sample storage");
      await expect(
        database(directory).acquireLease("store", "sample storage", { acquireTimeoutMs: 80 }),
      ).rejects.toThrow("Timed out waiting for sample storage lock");
      await release();
    });

    test("reclaims a holder that stopped heartbeating", async () => {
      const directory = await dataDir();
      const first = database(directory);
      await first.acquireLease("store", "test");
      // Simulate a crashed holder: its heartbeat timer never fires again.
      first.db.query("UPDATE leases SET heartbeat_at = 0").run();
      const release = await database(directory).acquireLease("store", "test", { staleMs: 1_000 });
      await release();
    });

    test("a reclaimed holder's late release cannot free the new holder", async () => {
      const directory = await dataDir();
      const first = database(directory);
      const releaseStale = await first.acquireLease("store", "test");
      first.db.query("UPDATE leases SET heartbeat_at = 0").run();
      const second = database(directory);
      const releaseFresh = await second.acquireLease("store", "test", { staleMs: 1_000 });
      await releaseStale();
      await expect(
        database(directory).acquireLease("store", "test", { acquireTimeoutMs: 80 }),
      ).rejects.toThrow("Timed out");
      await releaseFresh();
    });
  });
});

describe("StorageDatabase cache consistency", () => {
  test("a rolled-back write is never served after a foreign commit", async () => {
    const directory = await dataDir();
    const first = database(directory);
    const second = database(directory);
    first.writeStore("records", { a: "committed" });
    expect(() =>
      first.transaction(() => {
        first.writeStoreInTransaction("records", { a: "rolled back" });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    // Reuses revision 2, the number the rolled-back write would have had.
    second.writeStore("records", { a: "foreign" });
    expect(first.readStore("records")?.value).toEqual({ a: "foreign" });
  });

  test("a store deleted inside a transaction reads as absent there", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: 1 });
    db.transaction(() => {
      db.deleteStoreInTransaction("records");
      expect(db.readStore("records")).toBeNull();
    });
    expect(db.readStore("records")).toBeNull();
  });

  test("an unreadable imported document reports corruption", async () => {
    const { StoreCorruptError } = await import("./storage-database.js");
    const db = database(await dataDir());
    db.transaction(() => db.writeRawDocumentInTransaction("config", "{ not json"));
    expect(db.hasStore("config")).toBe(true);
    expect(() => db.readStore("config")).toThrow(StoreCorruptError);
    db.writeStore("config", { repaired: true });
    expect(db.readStore("config")?.value).toEqual({ repaired: true });
  });
});

describe("StorageDatabase.updateStore", () => {
  test("serializes synchronous read-modify-write across connections", async () => {
    const directory = await dataDir();
    const first = database(directory);
    const second = database(directory);
    for (let index = 0; index < 20; index += 1) {
      const target = index % 2 === 0 ? first : second;
      target.updateStore(
        "items",
        () => [] as Array<{ id: string }>,
        (items) => {
          items.push({ id: `item-${index}` });
        },
      );
    }
    expect(first.readStore("items")!.value as unknown[]).toHaveLength(20);
  });

  test("writes nothing when the mutator throws or changes nothing", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: 1 });
    expect(() =>
      db.updateStore(
        "records",
        () => ({}),
        (value: Record<string, number>) => {
          value.a = 2;
          throw new Error("refused");
        },
      ),
    ).toThrow("refused");
    db.updateStore(
      "records",
      () => ({}),
      () => undefined,
    );
    expect(db.storeRevision("records")).toBe(1);
    expect(db.readStore("records")?.value).toEqual({ a: 1 });
  });
});

describe("read-only store reader", () => {
  test("rebuilds every layout without opening the database for writing", async () => {
    const { readStorageDatabaseStore } =
      await import("@orkestrator/protocol/node/storage-database");
    const directory = await dataDir();
    const db = database(directory);
    const values: Record<string, unknown> = {
      config: { nested: [1, { a: 2 }] },
      items: [
        { id: "b", owner: "p1" },
        { id: "a", owner: "p2" },
      ],
      records: { z: 1, y: { deep: true } },
      mail: { version: 1, mailboxes: { m: { n: 1 } }, idempotency: {}, pendingInject: [] },
    };
    for (const [store, value] of Object.entries(values)) db.writeStore(store, value);
    db.writeStore("items", [{ id: "a" }, { id: "a" }]);
    values.items = [{ id: "a" }, { id: "a" }];
    const revision = db.storeRevision("records");
    for (const [store, value] of Object.entries(values)) {
      expect(readStorageDatabaseStore(directory, store)).toEqual(value);
    }
    expect(readStorageDatabaseStore(directory, "missing")).toBeUndefined();
    expect(readStorageDatabaseStore(await dataDir(), "records")).toBeUndefined();
    expect(db.storeRevision("records")).toBe(revision);
  });
});

describe("StorageDatabase layout changes", () => {
  test("a store rewritten under a new layout reads back in that layout", async () => {
    const directory = await dataDir();
    const asArray = new StorageDatabase(directory, {
      layoutFor: () => ({ kind: "array" }),
    });
    open.push(asArray);
    asArray.writeStore("shifting", [{ id: "a" }]);
    asArray.close();
    // A later build maps the same store to a record keyed the same way.
    const asRecord = new StorageDatabase(directory, { layoutFor: () => ({ kind: "record" }) });
    open.push(asRecord);
    asRecord.writeStore("shifting", { a: { id: "a" } });
    expect(asRecord.readStore("shifting")?.value).toEqual({ a: { id: "a" } });
  });
});

describe("StorageDatabase read observation", () => {
  test("a read is observed whether the cache or the database serves it", async () => {
    const directory = await dataDir();
    const events: string[] = [];
    const db = database(directory, { observe: (event) => events.push(event) });
    db.writeStore("records", { a: 1 });
    events.length = 0;
    // Both served from the cache, yet each parses every row for its caller.
    db.readStore("records");
    db.readStore("records");
    expect(events).toEqual(["read", "read"]);
    database(directory).writeStore("records", { a: 2 });
    db.readStore("records");
    expect(events).toEqual(["read", "read", "read"]);
    db.writeStore("owned", { k: { owner: "o" } });
    events.length = 0;
    db.readStoreRow("records", "a");
    db.readStoreRowsByOwner("owned", "o");
    expect(events).toEqual(["read", "read"]);
    // An absent store is only a revision lookup.
    events.length = 0;
    db.readStore("absent");
    db.readStoreRow("absent", "a");
    expect(events).toEqual([]);
  });

  test("an internal lookup of cached rows is a stat, and a miss is still a read", async () => {
    const directory = await dataDir();
    const events: string[] = [];
    const db = database(directory, { observe: (event) => events.push(event) });
    db.writeStore("records", { a: 1 });
    events.length = 0;
    // The write diffs against the cached previous rows; row sizes reuse them.
    db.writeStore("records", { a: 2 });
    db.storeRowStats("records");
    expect(events).toEqual(["stat", "stat"]);
    events.length = 0;
    // Another connection's write leaves this cache stale: the diff must fetch.
    database(directory).writeStore("records", { a: 3 });
    db.writeStore("records", { a: 4 });
    expect(events).toEqual(["read"]);
    events.length = 0;
    // A read-modify-write decodes the store for its callback, then diffs.
    db.updateStore(
      "records",
      () => ({}),
      (value: Record<string, number>) => {
        value.b = 1;
      },
    );
    expect(events).toEqual(["read", "stat"]);
  });

  test("a keyed row read reuses a warm cache and fetches only its row on a miss", async () => {
    const directory = await dataDir();
    const events: string[] = [];
    const fetched: number[] = [];
    const db = database(directory, {
      observe: (event) => events.push(event),
      observeFetch: (length) => fetched.push(length),
    });
    const items = Array.from({ length: 50 }, (_, index) => ({ id: `k${index}`, n: index }));
    db.writeStore("items", items);
    db.readStore("items");
    events.length = 0;
    fetched.length = 0;
    // The cache holds the committed revision: a read, but nothing fetched.
    expect(db.readStoreRow("items", "k7")).toEqual({ id: "k7", n: 7 });
    expect(db.readStoreRow("items", "missing")).toBeUndefined();
    expect(events).toEqual(["read", "read"]);
    expect(fetched).toEqual([]);
    // Another connection's write makes the cache stale: fetch the one row only.
    database(directory).writeStore("items", [...items.slice(1), { id: "k0", n: 100 }]);
    expect(db.readStoreRow("items", "k0")).toEqual({ id: "k0", n: 100 });
    expect(fetched).toEqual([JSON.stringify({ id: "k0", n: 100 }).length]);
    // A miss leaves the cache alone, so the next keyed read still fetches.
    expect(db.readStoreRow("items", "k1")).toEqual({ id: "k1", n: 1 });
    expect(fetched).toHaveLength(2);
  });

  test.each(["commit", "rollback"] as const)(
    "keyed reads reuse the pending revision before %s",
    async (outcome) => {
      const directory = await dataDir();
      const events: string[] = [];
      const fetched: number[] = [];
      const db = database(directory, {
        observe: (event) => events.push(event),
        observeFetch: (length) => fetched.push(length),
      });
      db.writeStore("records", { kept: { n: 1 }, removed: { n: 2 } });
      const observer = database(directory);
      const committedRevision = observer.storeRevision("records");
      const update = () =>
        db.transaction(() => {
          db.writeStore("records", { kept: { n: 3 }, added: { n: 4 } });
          expect(db.storeRevision("records")).not.toBe(committedRevision);
          expect(observer.storeRevision("records")).toBe(committedRevision);
          events.length = 0;
          fetched.length = 0;
          expect(db.readStoreRow("records", "kept")).toEqual({ n: 3 });
          expect(db.readStoreRow("records", "added")).toEqual({ n: 4 });
          expect(db.readStoreRow("records", "removed")).toBeUndefined();
          expect(events).toEqual(["read", "read", "read"]);
          expect(fetched).toEqual([]);
          if (outcome === "rollback") throw new Error("rollback pending cache");
        });
      if (outcome === "rollback") expect(update).toThrow("rollback pending cache");
      else update();
      const expected =
        outcome === "commit"
          ? { kept: { n: 3 }, added: { n: 4 } }
          : { kept: { n: 1 }, removed: { n: 2 } };
      expect(db.readStore("records")?.value).toEqual(expected);
      expect(observer.readStore("records")?.value).toEqual(expected);
      expect(db.readStoreRow("records", "kept")).toEqual(expected.kept);
      expect(db.readStoreRow("records", "added")).toEqual(expected.added);
    },
  );
});

describe("StorageDatabase space reclamation", () => {
  test("a new database uses incremental auto-vacuum and shrinks after a scrubbed delete", async () => {
    const directory = await dataDir();
    const db = database(directory);
    expect((db.db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(
      2,
    );
    db.writeStore(
      "records",
      Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [`k${index}`, "x".repeat(20_000)]),
      ),
    );
    db.scrubDeletedContent();
    const pages = () =>
      (db.db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    const before = pages();
    db.deleteStore("records");
    db.scrubDeletedContent();
    expect(pages()).toBeLessThan(before / 2);
  });
});

describe("StorageDatabase.updateStoreRow", () => {
  test("writers of different keys on different connections keep each other's rows", async () => {
    const directory = await dataDir();
    const first = database(directory);
    const second = database(directory);
    first.writeStore("records", { shared: { n: 0 } });
    // `first` caches the store, then `second` commits a new key behind its back.
    expect(first.readStore("records")?.value).toEqual({ shared: { n: 0 } });
    second.updateStoreRow("records", "b", () => ({ result: null, value: { n: 2 } }));
    first.updateStoreRow("records", "a", () => ({ result: null, value: { n: 1 } }));
    expect(second.readStore("records")?.value).toEqual({
      shared: { n: 0 },
      b: { n: 2 },
      a: { n: 1 },
    });
  });

  test("reads the committed row, deletes it, and skips no-op writes", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: { n: 1 }, opaque: "not a record at all" });
    const seen = db.updateStoreRow("records", "a", (current) => ({ result: current }));
    expect(seen).toEqual({ n: 1 });
    const revision = db.storeRevision("records");
    db.updateStoreRow("records", "a", () => ({ result: null, value: { n: 1 } }));
    expect(db.storeRevision("records")).toBe(revision);
    db.updateStoreRow("records", "a", () => ({ result: null, delete: true }));
    db.updateStoreRow("records", "missing", () => ({ result: null, delete: true }));
    expect(db.readStore("records")?.value).toEqual({ opaque: "not a record at all" });
    expect(db.storeRevision("records")).toBe(revision! + 1);
  });

  test("creates an absent store and repairs a document-mode one", async () => {
    const directory = await dataDir();
    const db = database(directory);
    db.updateStoreRow("records", "a", () => ({ result: null, value: 1 }));
    expect(db.readStore("records")?.value).toEqual({ a: 1 });
    db.transaction(() => db.writeRawDocumentInTransaction("records", "{ torn"));
    db.updateStoreRow("records", "b", () => ({ result: null, value: 2 }));
    expect(db.readStore("records")?.value).toEqual({ b: 2 });
  });

  test("keyed writes invalidate whole-store caches only after commit", async () => {
    const directory = await dataDir();
    const db = database(directory);
    const other = database(directory);
    const original = { a: { n: 1 }, b: { n: 2 } };
    db.writeStore("records", original);
    other.readStore("records");
    const revision = db.storeRevision("records");
    expect(() =>
      db.transaction(() => {
        db.updateStoreRow("records", "a", () => ({ result: null, value: { n: 3 } }));
        db.updateStoreRow("records", "b", () => ({ result: null, delete: true }));
        expect(db.readStoreRow("records", "a")).toEqual({ n: 3 });
        expect(db.readStore("records")?.value).toEqual({ a: { n: 3 } });
        throw new Error("rollback keyed writes");
      }),
    ).toThrow("rollback keyed writes");
    expect(db.storeRevision("records")).toBe(revision);
    expect(db.readStore("records")?.value).toEqual(original);
    expect(other.readStore("records")?.value).toEqual(original);
    db.updateStoreRow("records", "a", () => ({ result: null, value: { n: 4 } }));
    expect(db.readStore("records")?.value).toEqual({ ...original, a: { n: 4 } });
    expect(other.readStore("records")?.value).toEqual({ ...original, a: { n: 4 } });
  });

  test("refuses stores that are not keyed records", async () => {
    const db = database(await dataDir());
    expect(() => db.updateStoreRow("items", "a", () => ({ result: null }))).toThrow(
      "requires a record store",
    );
  });
});

describe("StorageDatabase envelope rows, strict reads and row stats", () => {
  test("updates one envelope collection row and creates a collection on first write", async () => {
    const db = database(await dataDir());
    db.updateStoreRow("mail", "m1", () => ({ result: null, value: { n: 1 } }), {
      collection: "mailboxes",
    });
    db.writeStore("mail", { version: 1, mailboxes: { m1: { n: 1 } } });
    db.updateStoreRow("mail", "k", () => ({ result: null, value: "fp" }), {
      collection: "idempotency",
    });
    expect(db.readStore("mail")?.value).toEqual({
      version: 1,
      mailboxes: { m1: { n: 1 } },
      idempotency: { k: "fp" },
    });
    expect(() =>
      db.updateStoreRow("mail", "x", () => ({ result: null }), { collection: "unknown" }),
    ).toThrow("has no collection");
  });

  test("refuses to replace an unreadable store in strict mode", async () => {
    const { StoreCorruptError } = await import("./storage-database.js");
    const db = database(await dataDir());
    db.transaction(() => db.writeRawDocumentInTransaction("records", "{ torn"));
    expect(() =>
      db.updateStore(
        "records",
        () => ({}),
        () => undefined,
        { unreadable: "throw" },
      ),
    ).toThrow(StoreCorruptError);
    expect(() =>
      db.updateStoreRow("records", "a", () => ({ result: null, value: 1 }), {
        unreadable: "throw",
      }),
    ).toThrow(StoreCorruptError);
    expect(db.hasStore("records")).toBe(true);
  });

  test("reports row sizes without parsing", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: "x".repeat(10), b: { n: 1 } });
    expect(db.storeRowStats("records")).toEqual([
      { key: "a", bytes: 12, position: 0 },
      { key: "b", bytes: 7, position: 1 },
    ]);
    expect(db.storeRowStats("missing")).toBeNull();
  });
});

describe("StorageDatabase abandoned leases", () => {
  test("purges only leases whose holder stopped heartbeating long ago", async () => {
    const db = database(await dataDir());
    const releaseLive = await db.acquireLease("live", "test");
    await db.acquireLease("crashed", "test");
    db.db.query("UPDATE leases SET heartbeat_at = 0 WHERE name = 'crashed'").run();
    expect(db.purgeAbandonedLeases()).toBe(1);
    expect(db.db.query("SELECT name FROM leases").all()).toEqual([{ name: "live" }]);
    await releaseLive();
  });
});

describe("StorageDatabase revision continuity and corrupt rows", () => {
  test("a recreated store never reuses a revision another connection cached", async () => {
    const directory = await dataDir();
    const first = database(directory);
    const second = database(directory);
    first.writeStore("records", { a: "old" });
    expect(second.readStore("records")?.value).toEqual({ a: "old" });
    const cachedRevision = second.storeRevision("records")!;
    first.deleteStore("records");
    first.writeStore("records", { a: "new" });
    expect(first.storeRevision("records")).toBeGreaterThan(cachedRevision);
    expect(second.readStore("records")?.value).toEqual({ a: "new" });
  });

  test("a corrupt row reads and updates as StoreCorruptError", async () => {
    const { StoreCorruptError } = await import("./storage-database.js");
    const db = database(await dataDir());
    db.writeStore("records", { a: 1 });
    db.db.query("UPDATE store_rows SET value = '{ torn' WHERE store = 'records'").run();
    db.db.query("UPDATE stores SET revision = revision + 1 WHERE name = 'records'").run();
    expect(() => db.readStoreRow("records", "a")).toThrow(StoreCorruptError);
    expect(() => db.updateStoreRow("records", "a", () => ({ result: null }))).toThrow(
      StoreCorruptError,
    );
  });

  test("an absent envelope store starts from the given initial value", async () => {
    const db = database(await dataDir());
    db.updateStoreRow("mail", "m1", () => ({ result: null, value: { n: 1 } }), {
      collection: "mailboxes",
      initial: () => ({ version: 1, mailboxes: {}, idempotency: {} }),
    });
    expect(db.readStore("mail")?.value).toEqual({
      version: 1,
      mailboxes: { m1: { n: 1 } },
      idempotency: {},
    });
  });
});

describe("StorageDatabase uncached row access", () => {
  test("writes rows without the cache, bumping the revision once per transaction", async () => {
    const directory = await dataDir();
    const db = database(directory);
    const other = database(directory);
    const rows = db.rows("items-by-key");
    expect(() => rows.put("a", "1")).toThrow("inside a storage transaction");
    db.transaction(() => {
      rows.put("a", JSON.stringify({ owner: "p1" }));
      rows.put("b", JSON.stringify({ owner: "p2" }));
    });
    expect(db.storeRevision("items-by-key")).toBe(1);
    // The cached API and another connection see the same rows.
    expect(other.readStore("items-by-key")?.value).toEqual({
      a: { owner: "p1" },
      b: { owner: "p2" },
    });
    db.transaction(() => {
      rows.put("a", JSON.stringify({ owner: "p1", n: 2 }));
    });
    expect(other.readStore("items-by-key")?.value).toMatchObject({ a: { n: 2 } });
    expect(rows.list({ values: false }).map(({ key, value }) => [key, value])).toEqual([
      ["a", null],
      ["b", null],
    ]);
    expect(rows.get("missing")).toBeUndefined();
    expect(db.transaction(() => rows.delete("missing"))).toBe(false);
    expect(db.storeRevision("items-by-key")).toBe(2);
  });

  test("indexes owners, sizes rows and deletes by owner", async () => {
    const db = database(await dataDir());
    const rows = db.rows("owned");
    db.transaction(() => {
      rows.put("a", JSON.stringify({ owner: "p1" }));
      rows.put("b", JSON.stringify({ owner: "p2", pad: "xxxx" }));
      rows.put("c", JSON.stringify({ owner: "p1" }));
    });
    expect(rows.owners()).toEqual(["p1", "p2"]);
    expect(rows.list({ owner: "p1" }).map((row) => row.key)).toEqual(["a", "c"]);
    expect(rows.list({ owner: "p2" })[0]!.bytes).toBe(
      JSON.stringify({ owner: "p2", pad: "xxxx" }).length,
    );
    expect(db.transaction(() => rows.deleteWhere({ owner: "p1" }))).toBe(2);
    expect(db.readStore("owned")?.value).toEqual({ b: { owner: "p2", pad: "xxxx" } });
  });

  test("addresses envelope collections and continues a deleted store's revisions", async () => {
    const db = database(await dataDir());
    const rows = db.rows("mail");
    db.transaction(() => rows.put("m1", JSON.stringify({ n: 1 }), { collection: "mailboxes" }));
    expect(db.readStore("mail")?.value).toEqual({ mailboxes: { m1: { n: 1 } }, idempotency: {} });
    expect(() => db.transaction(() => rows.put("x", "1", { collection: "nope" }))).toThrow(
      "has no collection",
    );
    const before = db.storeRevision("mail")!;
    db.deleteStore("mail");
    db.transaction(() => rows.put("m2", "2", { collection: "mailboxes" }));
    expect(db.storeRevision("mail")).toBeGreaterThan(before);
  });

  test("a rolled-back row write leaves rows and revision unchanged", async () => {
    const db = database(await dataDir());
    const rows = db.rows("owned");
    db.transaction(() => rows.put("a", JSON.stringify({ owner: "p1" })));
    expect(() =>
      db.transaction(() => {
        rows.put("b", JSON.stringify({ owner: "p1" }));
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(rows.has("b")).toBe(false);
    expect(db.storeRevision("owned")).toBe(1);
    expect(db.readStore("owned")?.value).toEqual({ a: { owner: "p1" } });
  });
});

describe("StorageDatabase row API guards", () => {
  test("refuses a delete outside a transaction before deleting anything", async () => {
    const db = database(await dataDir());
    const rows = db.rows("owned");
    db.transaction(() => rows.put("a", JSON.stringify({ owner: "p1" })));
    expect(() => rows.delete("a")).toThrow("inside a storage transaction");
    expect(() => rows.deleteWhere({ owner: "p1" })).toThrow("inside a storage transaction");
    expect(rows.has("a")).toBe(true);
    expect(rows.entry("a")).toMatchObject({ owner: "p1", position: 0, bytes: 14 });
    expect(db.readStoreHeader("owned")).toMatchObject({ layout: "record", mode: "rows" });
    expect(db.readStoreHeader("missing")).toBeNull();
  });
});
