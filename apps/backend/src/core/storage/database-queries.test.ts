import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageDatabase, type StoreLayout } from "./database.js";

/**
 * `StorageDatabase.readStoreRowsSerialized`: the rows a request names, by key
 * or key range, with the committed revision and envelope document, without
 * reading or caching the rest of the store.
 */

const directories: string[] = [];
const open: StorageDatabase[] = [];

const layouts: Record<string, StoreLayout> = {
  mail: { kind: "envelope", collections: ["mailboxes", "idempotency", "counterparts"] },
};

async function database(fetched: number[] = []): Promise<StorageDatabase> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-selected-rows-"));
  directories.push(dataDir);
  const db = new StorageDatabase(dataDir, {
    layoutFor: (store) => layouts[store] ?? { kind: "document" },
    observeFetch: (length) => fetched.push(length),
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

const mailboxes = {
  "e1\0agent": { environmentId: "e1", tab: "agent" },
  "e10\0agent": { environmentId: "e10", tab: "agent" },
  "e1\0review": { environmentId: "e1", tab: "review" },
  "e2\0agent": { environmentId: "e2", tab: "agent" },
};

function seed(db: StorageDatabase): void {
  db.writeStore("mail", { version: 1, revision: 3, pendingInject: [], mailboxes, idempotency: {} });
}

/** Drops this connection's cached copy, as a write by another connection would. */
function forgetCache(dataDir: string, db: StorageDatabase): StorageDatabase {
  const other = new StorageDatabase(dataDir, {
    layoutFor: (store) => layouts[store] ?? { kind: "document" },
  });
  open.push(other);
  const revision = other.storeRevision("mail");
  other.db.query("UPDATE stores SET revision = revision + 1 WHERE name = 'mail'").run();
  expect(db.storeRevision("mail")).toBe(revision! + 1);
  return other;
}

describe("readStoreRowsSerialized", () => {
  test("selects named keys in stored order with the revision and envelope", async () => {
    const db = await database();
    seed(db);
    const selected = db.readStoreRowsSerialized("mail", "mailboxes", {
      keys: ["e2\0agent", "missing", "e1\0agent", "e2\0agent"],
    })!;
    expect(selected.mode).toBe("rows");
    expect(selected.revision).toBe(db.storeRevision("mail")!);
    expect(JSON.parse(selected.document!)).toMatchObject({ version: 1, revision: 3 });
    expect(selected.rows.map((row) => [row.key, JSON.parse(row.value)])).toEqual([
      ["e1\0agent", mailboxes["e1\0agent"]],
      ["e2\0agent", mailboxes["e2\0agent"]],
    ]);
  });

  test("leaves out the document only at the revision the caller already knows", async () => {
    const db = await database();
    seed(db);
    const revision = db.storeRevision("mail")!;
    const select = (documentKnownAt?: number) =>
      db.readStoreRowsSerialized(
        "mail",
        "mailboxes",
        { keys: ["e1\0agent"] },
        { documentKnownAt },
      )!;
    expect(select(revision).document).toBeUndefined();
    expect(select(revision).rows).toHaveLength(1);
    expect(select(revision - 1).document).toBeString();
    expect(select().document).toBeString();
  });

  test("a NUL-terminated prefix selects one environment and not one it prefixes", async () => {
    const db = await database();
    seed(db);
    const keys = (prefix: string) =>
      db
        .readStoreRowsSerialized("mail", "mailboxes", { keyPrefix: prefix })!
        .rows.map((row) => row.key);
    expect(keys("e1\0")).toEqual(["e1\0agent", "e1\0review"]);
    expect(keys("e10\0")).toEqual(["e10\0agent"]);
    expect(keys("e3\0")).toEqual([]);
    expect(() => keys("e1")).toThrow("A key prefix must end in NUL");
  });

  test("answers the same from the cache and from SQLite, fetching only selected rows", async () => {
    const fetched: number[] = [];
    const db = await database(fetched);
    seed(db);
    // Cached at the committed revision by the write: nothing is fetched.
    fetched.length = 0;
    const cachedPrefix = db.readStoreRowsSerialized("mail", "mailboxes", { keyPrefix: "e1\0" })!;
    const cachedKeys = db.readStoreRowsSerialized("mail", "mailboxes", { keys: ["e2\0agent"] })!;
    expect(fetched).toEqual([]);

    forgetCache(directories.at(-1)!, db);
    const prefix = db.readStoreRowsSerialized("mail", "mailboxes", { keyPrefix: "e1\0" })!;
    const keys = db.readStoreRowsSerialized("mail", "mailboxes", { keys: ["e2\0agent"] })!;
    expect(prefix.rows).toEqual(cachedPrefix.rows);
    expect(keys.rows).toEqual(cachedKeys.rows);
    const selectedLength = [...prefix.rows, ...keys.rows].reduce(
      (length, row) => length + row.value.length,
      0,
    );
    expect(fetched.reduce((sum, length) => sum + length, 0)).toBe(selectedLength);
    // A selection never fills the whole-store cache.
    fetched.length = 0;
    db.readStoreRowsSerialized("mail", "mailboxes", { keys: ["e2\0agent"] });
    expect(fetched.length).toBe(1);
  });

  test("reports an absent store and a store held whole", async () => {
    const db = await database();
    expect(db.readStoreRowsSerialized("mail", "mailboxes", { keys: ["e1\0agent"] })).toBeNull();
    seed(db);
    db.transaction(() => {
      db.writeRawDocumentInTransaction("mail", JSON.stringify({ version: 1, mailboxes }));
    });
    const whole = db.readStoreRowsSerialized("mail", "mailboxes", { keyPrefix: "e1\0" })!;
    expect(whole.mode).toBe("document");
    expect(whole.rows).toEqual([]);
    expect(JSON.parse(whole.document!)).toMatchObject({ version: 1 });
  });
});
