import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STORAGE_DATABASE_FILE,
  StorageDatabase,
  StorageDatabaseVersionError,
  StoreConflictError,
  StoreCorruptError,
  StoreTooLargeError,
  rowBytesExpression,
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
  test("WAL synchronization defaults to FULL and NORMAL requires an explicit option", async () => {
    for (const synchronous of [undefined, "full", "normal"] as const) {
      const db = database(await dataDir(), { synchronous });
      expect(db.db.query("PRAGMA synchronous").get()).toEqual({
        synchronous: synchronous === "normal" ? 1 : 2,
      });
      expect(db.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    }
  });

  test("a library without octet_length falls back to the cast, with the same answer", async () => {
    const db = database(await dataDir());
    const selected = rowBytesExpression(db.db);
    const fallback = rowBytesExpression({
      query() {
        throw new Error("no such function: octet_length");
      },
    });
    expect(fallback).toBe("length(CAST(value AS BLOB))");
    const value = JSON.stringify("é€😀\u0000 and a long tail ".repeat(5_000));
    db.transaction(() => db.rows("records").put("unicode", value));
    for (const expression of [selected, fallback]) {
      expect(
        db.db.query(`SELECT ${expression} AS bytes FROM store_rows WHERE store = 'records'`).get(),
      ).toEqual({ bytes: Buffer.byteLength(value) });
    }
  });

  test("production sizing falls back when the connection rejects octet_length", async () => {
    const db = database(await dataDir());
    const query = db.db.query.bind(db.db);
    const probe = spyOn(db.db, "query").mockImplementation(((sql: string) => {
      if (sql.includes("octet_length")) throw new Error("no such function: octet_length");
      return query(sql);
    }) as typeof db.db.query);
    try {
      const value = JSON.stringify({ owner: "one", text: "é😀" });
      db.transaction(() => db.rows("owned").put("unicode", value));
      expect(db.rows("owned").list({ values: false })[0]?.bytes).toBe(Buffer.byteLength(value));
      expect(db.rows("owned").entry("unicode")?.bytes).toBe(Buffer.byteLength(value));
    } finally {
      probe.mockRestore();
    }
  });

  test("a sizes-only listing keeps the listing's order without an ordered scan", async () => {
    const db = database(await dataDir());
    const rows = db.rows("owned");
    db.transaction(() => {
      rows.put("b", JSON.stringify({ owner: "one" }), { position: 2 });
      rows.put("a", JSON.stringify({ owner: "two", text: "é" }), { position: 3 });
      rows.put("c", JSON.stringify({ owner: "one" }), { position: 1 });
      rows.put("z", JSON.stringify({ owner: "one" }), { position: 7 });
      rows.put("y", JSON.stringify({ owner: "two" }), { position: 7 });
    });
    const queries = spyOn(db.db, "query");
    const sizes = rows.list({ values: false });
    const listingSql = queries.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes("NULL AS value") && sql.includes("FROM store_rows"));
    queries.mockRestore();
    expect(listingSql).toHaveLength(1);
    expect(sizes.map((entry) => entry.key)).toEqual(["c", "b", "a", "y", "z"]);
    expect(sizes.map(({ key, position }) => [key, position])).toEqual(
      rows.list().map(({ key, position }) => [key, position]),
    );
    expect(sizes.every((entry) => entry.value === null)).toBe(true);
    expect(sizes.find((entry) => entry.key === "a")?.bytes).toBe(
      Buffer.byteLength(JSON.stringify({ owner: "two", text: "é" })),
    );
    expect(rows.list({ values: false, owner: "two" }).map((entry) => entry.key)).toEqual([
      "a",
      "y",
    ]);

    // The plan is the point: the listing must not seek each row by its position.
    const plan = db.db.query(`EXPLAIN QUERY PLAN ${listingSql[0]}`).all("owned") as Array<{
      detail: string;
    }>;
    expect(plan.map((row) => row.detail).join("\n")).not.toContain("store_rows_position");
  });

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

  test("refuses a write whose serialized rows exceed maxBytes, writing nothing", async () => {
    const db = database(await dataDir());
    const mail = { version: 1, mailboxes: { a: { body: "é".repeat(10) } }, idempotency: {} };
    db.writeStore("mail", mail);
    const big = { ...mail, mailboxes: { ...mail.mailboxes, b: { body: "é".repeat(100) } } };
    // 100 two-byte characters: over 150 bytes, though the string length is not.
    expect(() => db.writeStore("mail", big, { maxBytes: 150 })).toThrow(StoreTooLargeError);
    expect(db.storeRevision("mail")).toBe(1);
    expect(db.readStore("mail")?.value).toEqual(mail);
    db.writeStore("mail", big, { maxBytes: 400 });
    expect(db.readStore("mail")?.value).toEqual(big);
  });

  test("serves a store's serialized rows from the cache until it changes", async () => {
    const directory = await dataDir();
    const db = database(directory);
    db.writeStore("mail", { version: 1, mailboxes: { a: { n: 1 } }, idempotency: {} });
    const first = db.readStoreSerialized("mail")!;
    expect(first.revision).toBe(1);
    expect([...first.rows].map((row) => [row.collection, row.key, row.value])).toEqual([
      ["mailboxes", "a", '{"n":1}'],
    ]);
    // Another connection's commit is seen through the revision.
    database(directory).writeStore("mail", {
      version: 1,
      mailboxes: { a: { n: 1 }, b: { n: 2 } },
      idempotency: {},
    });
    const second = db.readStoreSerialized("mail")!;
    expect(second.revision).toBe(2);
    expect([...second.rows].map((row) => row.key).toSorted()).toEqual(["a", "b"]);
    expect(db.readStoreSerialized("missing")).toBeNull();
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

  test("a failed migration logs one line with no error text, and fails the open as before", async () => {
    const directory = await dataDir();
    const logs = captureLogs();
    try {
      database(directory).close();
      expect(() =>
        database(directory, {
          migrations: [
            {
              version: 2,
              name: "broken",
              up: () => {
                throw new Error("/Users/someone/private path");
              },
            },
          ],
        }),
      ).toThrow("/Users/someone/private path");
      const failed = logs.records().filter((record) => record.event === "migration.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.level).toBe("error");
      expect(failed[0]?.fields).toMatchObject({ fromVersion: 1, toVersion: 2, step: "migrate" });
      expect(failed[0]?.fields?.error).not.toHaveProperty("message");
    } finally {
      logs.restore();
    }
  });

  test("a failed safety copy before a migration is told apart from the migration", async () => {
    const directory = await dataDir();
    const logs = captureLogs();
    try {
      database(directory).close();
      expect(() =>
        database(directory, {
          migrations: [{ version: 2, name: "fine", up: () => undefined }],
          beforeMigrate: () => {
            throw new Error("no snapshot");
          },
        }),
      ).toThrow("no snapshot");
      expect(
        logs.records().find((record) => record.event === "migration.failed")?.fields?.step,
      ).toBe("snapshot");
    } finally {
      logs.restore();
    }
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

  test("a keyed write carries a cached store forward without a refetch", async () => {
    const directory = await dataDir();
    const fetched: number[] = [];
    const db = database(directory, { observeFetch: (length) => fetched.push(length) });
    db.writeStore("records", { a: { n: 1 }, b: { n: 2 }, c: { n: 3 } });
    db.readStore("records");
    fetched.length = 0;

    db.updateStoreRow("records", "b", () => ({ result: undefined, value: { n: 20 } }));
    db.updateStoreRow("records", "d", () => ({ result: undefined, value: { n: 4 } }));
    db.updateStoreRow("records", "a", () => ({ result: undefined, delete: true }));
    fetched.length = 0;

    const expected = { b: { n: 20 }, c: { n: 3 }, d: { n: 4 } };
    expect(db.readStore("records")?.value).toEqual(expected);
    expect(Object.keys(db.readStore("records")?.value as object)).toEqual(["b", "c", "d"]);
    expect(fetched).toEqual([]);
    // The carried revision and rows match what another connection reads fresh.
    const other = database(directory);
    expect(other.readStore("records")).toEqual(db.readStore("records"));
  });

  test("a keyed write carries an envelope's collections forward", async () => {
    const fetched: number[] = [];
    const db = database(await dataDir(), { observeFetch: (length) => fetched.push(length) });
    db.writeStore("mail", { mailboxes: { m: { n: 1 } }, idempotency: { i: { n: 2 } } });
    db.readStore("mail");
    db.updateStoreRow("mail", "added", () => ({ result: undefined, value: { n: 3 } }), {
      collection: "idempotency",
    });
    fetched.length = 0;
    expect(db.readStore("mail")?.value).toEqual({
      mailboxes: { m: { n: 1 } },
      idempotency: { i: { n: 2 }, added: { n: 3 } },
    });
    expect(fetched).toEqual([]);
  });

  test("a rolled back keyed write leaves the cached store as committed", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: { n: 1 } });
    const committed = db.readStore("records");
    expect(() =>
      db.transaction(() => {
        db.updateStoreRow("records", "a", () => ({ result: undefined, value: { n: 2 } }));
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(db.readStore("records")).toEqual(committed);
    expect(db.readStoreRow("records", "a")).toEqual({ n: 1 });
  });

  test("a keyed write after another connection's commit does not keep the stale cache", async () => {
    const directory = await dataDir();
    const db = database(directory);
    db.writeStore("records", { a: { n: 1 } });
    db.readStore("records");
    database(directory).writeStore("records", { a: { n: 1 }, b: { n: 2 } });
    db.updateStoreRow("records", "a", () => ({ result: undefined, value: { n: 3 } }));
    expect(db.readStore("records")?.value).toEqual({ a: { n: 3 }, b: { n: 2 } });
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

describe("StorageDatabase failure logging", () => {
  const SENTINEL = "SENTINEL-SQLITE-MESSAGE";
  const failure = () => Object.assign(new Error(SENTINEL), { code: "SQLITE_IOERR" });

  test("a scrub checkpoint a reader blocks is logged, and recovers on the next success", async () => {
    const directory = await dataDir();
    const writer = database(directory, { busyTimeoutMs: 0 });
    const reader = database(directory, { busyTimeoutMs: 0 });
    writer.writeStore("records", { first: "value" });
    reader.db.exec("BEGIN");
    reader.db.query("SELECT count(*) FROM store_rows").get();
    writer.writeStore("records", { first: "changed" });
    const logs = captureLogs();
    try {
      writer.scrubDeletedContent();
      writer.scrubDeletedContent();
      expect(logs.records()).toMatchObject([
        {
          level: "warn",
          area: "storage",
          event: "scrub.checkpoint-failed",
          fields: { scope: "scrub", kind: "busy" },
        },
      ]);
      reader.db.exec("COMMIT");
      writer.scrubDeletedContent();
      expect(logs.records().at(-1)).toMatchObject({
        level: "warn",
        event: "throttle.recovered",
        fields: { site: "scrub.checkpoint-failed", scope: "scrub", failures: 2 },
      });
    } finally {
      logs.restore();
    }
  });

  test("a scrub checkpoint that throws is logged without its message and never throws", async () => {
    const db = database(await dataDir());
    const logs = captureLogs();
    const original = db.db.query.bind(db.db);
    const exec = spyOn(db.db, "query").mockImplementation((sql) => {
      if (sql.includes("wal_checkpoint")) throw failure();
      return original(sql);
    });
    try {
      expect(() => db.scrubDeletedContent()).not.toThrow();
      expect(() => db.scrubDeletedContent()).not.toThrow();
      exec.mockRestore();
      db.scrubDeletedContent();
      const records = logs.records();
      expect(records).toMatchObject([
        {
          level: "warn",
          event: "scrub.checkpoint-failed",
          fields: { scope: "scrub", kind: "SQLITE_IOERR", error: { code: "SQLITE_IOERR" } },
        },
        { event: "throttle.recovered", fields: { site: "scrub.checkpoint-failed", failures: 2 } },
      ]);
      expect(JSON.stringify(records)).not.toContain(SENTINEL);
    } finally {
      exec.mockRestore();
      logs.restore();
    }
  });

  test("vacuum faults are throttled separately from successful checkpoints", async () => {
    const db = database(await dataDir());
    const original = db.db.exec.bind(db.db);
    const exec = spyOn(db.db, "exec").mockImplementation((sql) => {
      if (sql.includes("incremental_vacuum")) throw failure();
      return original(sql);
    });
    const logs = captureLogs();
    try {
      db.scrubDeletedContent();
      db.scrubDeletedContent();
      expect(logs.records()).toMatchObject([
        { event: "scrub.vacuum-failed", fields: { error: { code: "SQLITE_IOERR" } } },
      ]);
      expect(logs.records()).toHaveLength(1);
      expect(JSON.stringify(logs.records())).not.toContain(SENTINEL);
      exec.mockRestore();
      db.scrubDeletedContent();
      expect(logs.records().at(-1)).toMatchObject({
        event: "throttle.recovered",
        fields: { site: "scrub.vacuum-failed", failures: 2 },
      });
    } finally {
      exec.mockRestore();
      logs.restore();
    }
  });

  test.each(["SQLITE_BUSY", "SQLITE_LOCKED"])(
    "vacuum %s stops promptly without a warning",
    async (code) => {
      const db = database(await dataDir());
      const original = db.db.exec.bind(db.db);
      const exec = spyOn(db.db, "exec").mockImplementation((sql) => {
        if (sql.includes("incremental_vacuum")) throw Object.assign(new Error(SENTINEL), { code });
        return original(sql);
      });
      const logs = captureLogs();
      try {
        expect(db.releaseFreePages()).toBe(-1);
        db.scrubDeletedContent();
        expect(db.db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 10000 });
        expect(logs.records()).toEqual([]);
      } finally {
        exec.mockRestore();
        logs.restore();
      }
    },
  );

  test("a successful scrub with no fault writes nothing", async () => {
    const db = database(await dataDir());
    const logs = captureLogs();
    try {
      db.scrubDeletedContent();
      expect(logs.records()).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  test("a heartbeat cannot report recovery after another connection reclaims the lease", async () => {
    const directory = await dataDir();
    const first = database(directory);
    const second = database(directory);
    jest.useFakeTimers();
    const logs = captureLogs();
    const releaseFirst = await first.acquireLease("reclaimed-heartbeat", "test");
    const realQuery = first.db.query.bind(first.db);
    const failHeartbeats = spyOn(first.db, "query").mockImplementation(((sql: string) => {
      if (sql.startsWith("UPDATE leases")) throw failure();
      return realQuery(sql);
    }) as typeof first.db.query);
    let releaseSecond: (() => Promise<void>) | undefined;
    try {
      jest.advanceTimersByTime(5_000);
      // Offset the new holder's timer so this assertion observes only the
      // original holder's next beat, not a successful renewal by its successor.
      jest.advanceTimersByTime(1);
      second.db.query("UPDATE leases SET heartbeat_at = 0").run();
      releaseSecond = await second.acquireLease("reclaimed-heartbeat", "test");
      failHeartbeats.mockRestore();
      jest.advanceTimersByTime(4_999);
      expect(logs.records()).toMatchObject([
        {
          level: "warn",
          event: "lease.heartbeat-failed",
          fields: { scope: "reclaimed-heartbeat" },
        },
      ]);
      await releaseFirst();
      expect(second.db.query("SELECT name FROM leases").all()).toHaveLength(1);
    } finally {
      failHeartbeats.mockRestore();
      await releaseFirst();
      await releaseSecond?.();
      jest.useRealTimers();
      logs.restore();
    }
  });

  test("a failed lease heartbeat is logged once per lease, and recovers on the next beat", async () => {
    const db = database(await dataDir());
    jest.useFakeTimers();
    const logs = captureLogs();
    const release = await db.acquireLease("store-a", "test");
    const realQuery = db.db.query.bind(db.db);
    const failHeartbeats = spyOn(db.db, "query").mockImplementation(((sql: string) => {
      if (sql.startsWith("UPDATE leases")) throw failure();
      return realQuery(sql);
    }) as typeof db.db.query);
    try {
      jest.advanceTimersByTime(5_000);
      jest.advanceTimersByTime(5_000);
      failHeartbeats.mockRestore();
      jest.advanceTimersByTime(5_000);
      jest.advanceTimersByTime(5_000);
      const records = logs.records();
      expect(records).toMatchObject([
        {
          level: "warn",
          area: "storage",
          event: "lease.heartbeat-failed",
          fields: { scope: "store-a", kind: "SQLITE_IOERR", error: { code: "SQLITE_IOERR" } },
        },
        {
          level: "warn",
          event: "throttle.recovered",
          fields: { site: "lease.heartbeat-failed", scope: "store-a", failures: 2 },
        },
      ]);
      expect(JSON.stringify(records)).not.toContain(SENTINEL);
    } finally {
      failHeartbeats.mockRestore();
      jest.useRealTimers();
      logs.restore();
      await release();
    }
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

  test("an unparsable row refuses a write unless the caller replaces it", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: { n: 1 }, b: { n: 2 } });
    db.db
      .query("UPDATE store_rows SET value = '{ torn' WHERE store = 'records' AND key = 'a'")
      .run();
    const seen: unknown[] = [];
    const replace = { unreadableRow: "replace" as const };

    expect(() =>
      db.updateStoreRow("records", "a", () => ({ result: null, value: { n: 3 } })),
    ).toThrow(StoreCorruptError);

    db.updateStoreRow(
      "records",
      "a",
      (current) => {
        seen.push(current);
        return { result: null };
      },
      replace,
    );
    expect(seen).toEqual([undefined]);

    db.updateStoreRow("records", "a", () => ({ result: null, value: { n: 3 } }), replace);
    expect(db.readStore("records")?.value).toEqual({ a: { n: 3 }, b: { n: 2 } });

    db.db
      .query("UPDATE store_rows SET value = '{ torn' WHERE store = 'records' AND key = 'a'")
      .run();
    db.updateStoreRow("records", "a", () => ({ result: null, delete: true }), replace);
    expect(db.db.query("SELECT key FROM store_rows WHERE store = 'records'").all()).toEqual([
      { key: "b" },
    ]);
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

  test("refuses stores that are not keyed", async () => {
    const db = database(await dataDir());
    expect(() => db.updateStoreRow("plain", "a", () => ({ result: null }))).toThrow(
      "requires a record store",
    );
    expect(() =>
      db.updateStoreRow("items", "a", () => ({ result: null }), { collection: "c" }),
    ).toThrow("requires a record store");
  });
});

describe("StorageDatabase.updateStoreRow on a keyed array store", () => {
  const item = (id: string, n = 0, owner = "o1") => ({ id, n, owner });

  test("inserts last, updates in place and deletes, keeping the order", async () => {
    const db = database(await dataDir());
    db.writeStore("items", [item("c"), item("a"), item("b")]);
    db.updateStoreRow("items", "d", () => ({ result: null, value: item("d") }));
    db.updateStoreRow("items", "a", (current) => ({
      result: null,
      value: { ...(current as object), n: 7 },
    }));
    db.updateStoreRow("items", "c", () => ({ result: null, delete: true }));
    db.updateStoreRow("items", "e", () => ({ result: null, value: item("e") }));
    expect(db.readStore("items")?.value).toEqual([item("a", 7), item("b"), item("d"), item("e")]);
    // A connection with no cached copy assembles the same order from the rows.
    const fresh = database(path.dirname(db.path));
    const ids = (fresh.readStore("items")!.value as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual(["a", "b", "d", "e"]);
  });

  test("touches only its own row and keeps the owner column current", async () => {
    const db = database(await dataDir());
    db.writeStore("items", [item("a"), item("b")]);
    const rows = () =>
      db.db
        .query("SELECT key, position, owner, value FROM store_rows WHERE store = 'items'")
        .all() as Array<{ key: string; position: number; owner: string; value: string }>;
    const before = rows();
    const whole = spyOn(db, "writeStoreInTransaction");
    try {
      db.updateStoreRow("items", "a", () => ({ result: null, value: item("a", 1, "o2") }));
      expect(whole).not.toHaveBeenCalled();
    } finally {
      whole.mockRestore();
    }
    const after = rows();
    expect(after.find((row) => row.key === "b")).toEqual(before.find((row) => row.key === "b")!);
    expect(after.find((row) => row.key === "a")).toMatchObject({ position: 0, owner: "o2" });
    expect(db.readStoreRowsByOwner("items", "o2")).toEqual([item("a", 1, "o2")]);
  });

  test("reads the current item, skips no-ops and writes nothing for a missing delete", async () => {
    const db = database(await dataDir());
    db.writeStore("items", [item("a", 1)]);
    const revision = db.storeRevision("items");
    expect(db.updateStoreRow("items", "a", (current) => ({ result: current }))).toEqual(
      item("a", 1),
    );
    expect(db.updateStoreRow("items", "z", (current) => ({ result: current }))).toBeUndefined();
    db.updateStoreRow("items", "a", () => ({ result: null, value: item("a", 1) }));
    db.updateStoreRow("items", "z", () => ({ result: null, delete: true }));
    expect(db.storeRevision("items")).toBe(revision);
  });

  test("refuses a value that does not carry its key, writing nothing", async () => {
    const db = database(await dataDir());
    db.writeStore("items", [item("a")]);
    const revision = db.storeRevision("items");
    for (const value of [item("b"), { n: 1 }, "text"]) {
      expect(() => db.updateStoreRow("items", "a", () => ({ result: null, value }))).toThrow(
        "must equal its non-blank key",
      );
    }
    expect(() => db.updateStoreRow("items", "", () => ({ result: null, value: item("") }))).toThrow(
      "must equal its non-blank key",
    );
    expect(db.storeRevision("items")).toBe(revision);
    expect(db.readStore("items")?.value).toEqual([item("a")]);
  });

  test("creates an absent store as an array", async () => {
    const db = database(await dataDir());
    db.updateStoreRow("items", "a", () => ({ result: null, value: item("a") }));
    expect(db.readStore("items")?.value).toEqual([item("a")]);
    expect(db.readStoreHeader("items")).toMatchObject({ layout: "array", mode: "rows" });
    expect(db.readStoreRow("items", "a")).toEqual(item("a"));
  });

  test("falls back to the whole value for a store held as a document", async () => {
    const db = database(await dataDir());
    // A repeated key cannot be held as rows.
    const repeated = [item("a", 1), item("b"), item("a", 2)];
    db.writeStore("items", repeated);
    expect(db.readStoreHeader("items")?.mode).toBe("document");
    expect(db.updateStoreRow("items", "a", (current) => ({ result: current }))).toEqual(
      item("a", 1),
    );
    db.updateStoreRow("items", "b", () => ({ result: null, value: item("b", 5) }));
    db.updateStoreRow("items", "n", () => ({ result: null, value: item("n") }));
    expect(db.readStore("items")?.value).toEqual([
      item("a", 1),
      item("b", 5),
      item("a", 2),
      item("n"),
    ]);
    // Deleting the key removes every item that carries it, so the rows fit again.
    db.updateStoreRow("items", "a", () => ({ result: null, delete: true }));
    expect(db.readStore("items")?.value).toEqual([item("b", 5), item("n")]);
    expect(db.readStoreHeader("items")?.mode).toBe("rows");
  });

  test("replaces an unreadable store only when allowed", async () => {
    const { StoreCorruptError } = await import("./storage-database.js");
    const db = database(await dataDir());
    db.transaction(() => db.writeRawDocumentInTransaction("items", "{ torn"));
    expect(() =>
      db.updateStoreRow("items", "a", () => ({ result: null, value: item("a") }), {
        unreadable: "throw",
      }),
    ).toThrow(StoreCorruptError);
    db.updateStoreRow("items", "a", () => ({ result: null, value: item("a") }));
    expect(db.readStore("items")?.value).toEqual([item("a")]);
  });

  test("a rollback restores the row, the cache and the revision", async () => {
    const directory = await dataDir();
    const db = database(directory);
    const other = database(directory);
    db.writeStore("items", [item("a"), item("b")]);
    other.readStore("items");
    const revision = db.storeRevision("items");
    expect(() =>
      db.transaction(() => {
        db.updateStoreRow("items", "a", () => ({ result: null, value: item("a", 9) }));
        db.updateStoreRow("items", "b", () => ({ result: null, delete: true }));
        db.updateStoreRow("items", "c", () => ({ result: null, value: item("c") }));
        expect(db.readStore("items")?.value).toEqual([item("a", 9), item("c")]);
        throw new Error("roll back");
      }),
    ).toThrow("roll back");
    expect(db.storeRevision("items")).toBe(revision);
    expect(db.readStore("items")?.value).toEqual([item("a"), item("b")]);
    db.updateStoreRow("items", "a", () => ({ result: null, value: item("a", 3) }));
    expect(other.readStore("items")?.value).toEqual([item("a", 3), item("b")]);
  });

  test("whole-value writes and row writes share one row layout", async () => {
    const db = database(await dataDir());
    db.writeStore("items", [item("a"), item("b"), item("c")]);
    db.updateStoreRow("items", "b", () => ({ result: null, delete: true }));
    db.updateStoreRow("items", "d", () => ({ result: null, value: item("d") }));
    // The gap the delete left does not disturb a whole-value write after it.
    const current = db.readStore("items")!.value as Array<{ id: string }>;
    db.writeStore("items", [...current, item("e")]);
    const ids = (db.readStore("items")!.value as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual(["a", "c", "d", "e"]);
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

describe("StorageDatabase position index", () => {
  const nextPositionQuery =
    "SELECT coalesce(max(position) + 1, 0) AS next FROM store_rows WHERE store = ? AND collection = ?";

  function plan(db: StorageDatabase, sql: string): string {
    return (
      db.db.query(`EXPLAIN QUERY PLAN ${sql}`).all("records", "") as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join("\n");
  }

  test("an insert's next position is an index lookup, not a scan of the collection", async () => {
    const db = database(await dataDir());
    db.writeStore("records", { a: 1, b: 2 });
    expect(plan(db, nextPositionQuery)).toContain("store_rows_position");
    db.updateStoreRow("records", "c", () => ({ result: undefined, value: 3 }));
    db.transaction(() => db.rows("records").put("d", "4"));
    expect(db.storeRowStats("records")!.map((row) => [row.key, row.position])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
    ]);
  });

  test("a database opened without the index gains it with its rows, revisions and version unchanged", async () => {
    const directory = await dataDir();
    const first = database(directory);
    first.writeStore("records", { a: 1, b: 2 });
    first.writeStore("items", [{ id: "x" }, { id: "y" }]);
    // A database last opened by a build that predates the index.
    first.db.exec("DROP INDEX store_rows_position");
    const version = first.schemaVersion();
    const dump = (db: StorageDatabase) => ({
      stores: db.db.query("SELECT name, revision, layout, mode, document FROM stores").all(),
      rows: db.db
        .query(
          "SELECT store, collection, key, position, owner, value FROM store_rows ORDER BY 1, 2, 3",
        )
        .all(),
    });
    const before = dump(first);
    first.close();

    const reopened = database(directory);
    expect(
      reopened.db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'store_rows_position'",
        )
        .get(),
    ).toEqual({ name: "store_rows_position" });
    expect(reopened.schemaVersion()).toBe(version);
    expect(dump(reopened)).toEqual(before);
    expect(reopened.readStore("records")).toMatchObject({ value: { a: 1, b: 2 } });
  });
});
