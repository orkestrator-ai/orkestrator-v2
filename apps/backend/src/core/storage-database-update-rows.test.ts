import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageDatabase, StoreTooLargeError, type StoreLayout } from "./storage-database.js";

/**
 * `StorageDatabase.updateStoreRows`: several rows of a store and an envelope's
 * document in one commit, without assembling or reserializing the store
 * (todo 6120 task 6), and `rows().list({ owner: null })`.
 */

const directories: string[] = [];
const open: StorageDatabase[] = [];

const layouts: Record<string, StoreLayout> = {
  mail: { kind: "envelope", collections: ["mailboxes", "idempotency", "counterparts"] },
  owned: { kind: "record", owner: (value) => (value as { owner?: string }).owner },
  items: { kind: "array" },
};

async function database(directory?: string): Promise<StorageDatabase> {
  const dataDir = directory ?? (await fs.mkdtemp(path.join(tmpdir(), "ork-update-rows-")));
  if (!directory) directories.push(dataDir);
  const db = new StorageDatabase(dataDir, {
    layoutFor: (store) => layouts[store] ?? { kind: "document" },
  });
  open.push(db);
  return db;
}

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function seedMail(db: StorageDatabase): void {
  db.writeStore("mail", {
    version: 1,
    revision: 4,
    pendingInject: [{ mailboxId: "a", messageId: "m1" }],
    mailboxes: { a: { n: 1 }, b: { n: 2 }, c: { n: 3 } },
    idempotency: { i1: { scope: "a" } },
  });
}

/** Store row writes by statement, from temporary triggers. */
function countRowWrites(db: StorageDatabase): () => string[] {
  db.db.exec("CREATE TEMP TABLE row_writes (event TEXT NOT NULL, key TEXT NOT NULL)");
  for (const [event, row] of [
    ["INSERT", "new"],
    ["UPDATE", "new"],
    ["DELETE", "old"],
  ] as const) {
    db.db.exec(`CREATE TEMP TRIGGER row_write_${event} AFTER ${event} ON main.store_rows
      BEGIN INSERT INTO row_writes VALUES ('${event}', ${row}.key); END`);
  }
  return () =>
    (
      db.db.query("SELECT event, key FROM row_writes").all() as Array<{
        event: string;
        key: string;
      }>
    )
      .map(({ event, key }) => `${event} ${key}`)
      .sort();
}

describe("updateStoreRows", () => {
  test("writes and deletes only the named rows and changes the envelope document", async () => {
    const db = await database();
    seedMail(db);
    const writes = countRowWrites(db);
    const before = db.storeRevision("mail")!;

    expect(
      db.updateStoreRows(
        "mail",
        [
          { collection: "mailboxes", key: "a", value: undefined },
          { collection: "mailboxes", key: "b", value: { n: 20 } },
          { collection: "mailboxes", key: "c", value: { n: 3 } },
          { collection: "idempotency", key: "i1", value: undefined },
          { collection: "counterparts", key: "m1", value: { id: "m1" } },
        ],
        {
          document: (envelope) => {
            envelope.revision = 5;
            envelope.pendingInject = [];
          },
        },
      ),
    ).toBe(true);

    // `c` is unchanged, so it is not written.
    expect(writes()).toEqual(["DELETE a", "DELETE i1", "INSERT m1", "UPDATE b"]);
    expect(db.storeRevision("mail")).toBe(before + 1);
    expect(db.readStore("mail")?.value).toEqual({
      version: 1,
      revision: 5,
      pendingInject: [],
      mailboxes: { b: { n: 20 }, c: { n: 3 } },
      idempotency: {},
      counterparts: { m1: { id: "m1" } },
    });
  });

  test("carries the cached store forward, so the next reader fetches no rows", async () => {
    const db = await database();
    seedMail(db);
    db.readStoreSerialized("mail");
    db.updateStoreRows("mail", [{ collection: "mailboxes", key: "b", value: { n: 9 } }]);

    const query = spyOn(db.db, "query");
    try {
      const serialized = db.readStoreSerialized("mail")!;
      expect(serialized.revision).toBe(db.storeRevision("mail")!);
      expect(
        query.mock.calls.some(([sql]) => String(sql).includes("FROM store_rows WHERE store")),
      ).toBe(false);
      const rows = [...serialized.rows].map((row) => [row.key, row.value]);
      expect(rows).toContainEqual(["b", JSON.stringify({ n: 9 })]);
    } finally {
      query.mockRestore();
    }
    // Another connection reads the same committed value.
    const other = await database(path.dirname(db.path));
    expect((other.readStore("mail")!.value as { mailboxes: unknown }).mailboxes).toEqual({
      a: { n: 1 },
      b: { n: 9 },
      c: { n: 3 },
    });
  });

  test("a write that changes nothing commits nothing", async () => {
    const db = await database();
    seedMail(db);
    const before = db.storeRevision("mail");
    expect(
      db.updateStoreRows("mail", [
        { collection: "mailboxes", key: "a", value: { n: 1 } },
        { collection: "idempotency", key: "absent", value: undefined },
      ]),
    ).toBe(true);
    expect(db.storeRevision("mail")).toBe(before);
  });

  test("refuses growth past maxBytes but always commits a write that shrinks the store", async () => {
    const db = await database();
    seedMail(db);
    const big = { body: "x".repeat(4096) };
    db.updateStoreRows("mail", [{ collection: "mailboxes", key: "big", value: big }]);
    const before = db.storeRevision("mail");

    expect(() =>
      db.updateStoreRows("mail", [{ collection: "mailboxes", key: "c", value: big }], {
        maxBytes: 1024,
      }),
    ).toThrow(StoreTooLargeError);
    expect(db.storeRevision("mail")).toBe(before);
    expect((db.readStore("mail")!.value as { mailboxes: object }).mailboxes).not.toHaveProperty(
      "c.body",
    );

    // Still over the limit afterwards, but smaller: a removal must not be refused.
    expect(
      db.updateStoreRows("mail", [{ collection: "mailboxes", key: "a", value: undefined }], {
        maxBytes: 1024,
      }),
    ).toBe(true);
    expect(db.storeRevision("mail")).toBe(before! + 1);
  });

  test("sets a record row's indexed owner", async () => {
    const db = await database();
    db.writeStore("owned", { x: { owner: "env-1" } });
    db.updateStoreRows("owned", [
      { key: "y", value: { owner: "env-2" } },
      { key: "x", value: { owner: "env-2" } },
    ]);
    expect(
      db
        .rows("owned")
        .list({ owner: "env-2", values: false })
        .map((row) => row.key),
    ).toEqual(["x", "y"]);
    expect(db.rows("owned").list({ owner: "env-1" })).toEqual([]);
  });

  test("leaves an absent store, or one held whole, to the caller's whole-value write", async () => {
    const db = await database();
    expect(db.updateStoreRows("mail", [{ collection: "mailboxes", key: "a", value: 1 }])).toBe(
      false,
    );
    expect(db.hasStore("mail")).toBe(false);
    db.writeStore("mail", [1, 2]);
    expect(db.readStoreHeader("mail")?.mode).toBe("document");
    const before = db.storeRevision("mail");
    expect(db.updateStoreRows("mail", [{ collection: "mailboxes", key: "a", value: 1 }])).toBe(
      false,
    );
    expect(db.storeRevision("mail")).toBe(before);
  });

  test("rejects a collection or document the layout does not have", async () => {
    const db = await database();
    seedMail(db);
    expect(() => db.updateStoreRows("mail", [{ collection: "other", key: "a", value: 1 }])).toThrow(
      "has no collection other",
    );
    expect(() => db.updateStoreRows("mail", [{ key: "a", value: 1 }])).toThrow("has no collection");
    expect(() => db.updateStoreRows("owned", [], { document: () => undefined })).toThrow(
      "has no envelope document",
    );
    expect(() => db.updateStoreRows("items", [])).toThrow("record or envelope store");
  });

  test("rolls back every row when one write throws", async () => {
    const db = await database();
    seedMail(db);
    const before = db.readStore("mail")?.value;
    expect(() =>
      db.updateStoreRows("mail", [
        { collection: "mailboxes", key: "a", value: undefined },
        { collection: "mailboxes", key: "b", value: 1n },
      ]),
    ).toThrow();
    expect(db.readStore("mail")?.value).toEqual(before);
  });
});

describe("listUnownedRows", () => {
  test("lists a store's rows that have no owner, walking the store without an index", async () => {
    const db = await database();
    db.writeStore("owned", { x: { owner: "env-1" }, y: {}, z: { other: "env-1" } });
    expect(db.listUnownedRows("owned").map((row) => row.key)).toEqual(["y", "z"]);
  });

  test("reads them through the store's partial index, which holds only those rows", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-update-rows-"));
    directories.push(dataDir);
    const options = {
      layoutFor: (store: string) => layouts[store] ?? { kind: "document" as const },
      unownedRowIndexes: ["owned"],
    };
    const db = new StorageDatabase(dataDir, options);
    open.push(db);
    db.writeStore("owned", { x: { owner: "env-1" }, y: {}, z: { other: "env-1" } });
    db.writeStore("other", { a: 1 });
    const index = "store_rows_unowned_owned";
    expect(db.listUnownedRows("owned")).toEqual([
      { key: "y", position: 1, value: "{}" },
      { key: "z", position: 2, value: JSON.stringify({ other: "env-1" }) },
    ]);
    const counted = db.db
      .query(
        `SELECT count(*) AS n FROM store_rows INDEXED BY ${index} WHERE store = 'owned' AND collection = '' AND owner IS NULL`,
      )
      .get() as { n: number };
    expect(counted.n).toBe(2);
    // A row given an owner leaves the index.
    db.updateStoreRows("owned", [{ key: "y", value: { owner: "env-2" } }]);
    expect(db.listUnownedRows("owned").map((row) => row.key)).toEqual(["z"]);
    // Created on open, with no schema version of its own: reopening keeps one copy.
    const version = db.schemaVersion();
    const reopened = new StorageDatabase(dataDir, options);
    open.push(reopened);
    expect(reopened.schemaVersion()).toBe(version);
    expect(
      reopened.db.query("SELECT count(*) AS n FROM sqlite_master WHERE name = ?").get(index),
    ).toEqual({ n: 1 });
  });

  test("refuses an index for a store that is not a plainly named record store", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-update-rows-"));
    directories.push(dataDir);
    for (const store of ["mail", "owned'; DROP TABLE store_rows; --"]) {
      expect(
        () =>
          new StorageDatabase(dataDir, {
            layoutFor: (name) => layouts[name] ?? { kind: "record" },
            unownedRowIndexes: [store],
          }),
      ).toThrow("needs a record store with a plain name");
    }
  });
});
