import { afterEach, describe, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openChangeLedgerDatabase } from "./change-tracking/ledger-schema.js";
import {
  SCRUB_RETRY_FIRST_MS,
  SCRUB_RETRY_MAX_MS,
  STORAGE_DATABASE_FILE,
  StorageDatabase,
} from "./storage-database.js";
import { runDatabaseUpkeep } from "./storage-backups.js";
import { openBackendDatabase, storeLayout } from "./storage-stores.js";
import { storageFilesContain } from "./storage-test-support.js";

const directories: string[] = [];
const open: Array<{ close(): void }> = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-upkeep-"));
  directories.push(directory);
  return directory;
}

function database(directory: string, busyTimeoutMs?: number): StorageDatabase {
  const db = new StorageDatabase(directory, {
    layoutFor: (store) => (store === "records" ? { kind: "record" } : storeLayout(store)),
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  });
  open.push(db);
  return db;
}

/** A second connection that holds a read snapshot, as an hourly copy does. */
function holdReader(directory: string): Database {
  const reader = new Database(path.join(directory, STORAGE_DATABASE_FILE));
  open.push(reader);
  reader.exec("BEGIN");
  reader.query("SELECT count(*) FROM store_rows").get();
  return reader;
}

function walBytes(directory: string): number {
  return Bun.file(path.join(directory, `${STORAGE_DATABASE_FILE}-wal`)).size;
}

afterEach(async () => {
  jest.useRealTimers();
  for (const handle of open.splice(0).reverse()) {
    try {
      handle.close();
    } catch {
      // Already closed by the test.
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("scrub checkpoint under a reader (report 0800)", () => {
  test("a truncating checkpoint with a busy handler waits for an older reader", async () => {
    // The mechanism the scrub used to block the event loop on: SQLite calls
    // the busy handler until every reader has moved past the checkpoint.
    const directory = await dataDir();
    const db = database(directory);
    db.writeStore("records", { first: "value" });
    holdReader(directory);
    db.writeStore("records", { first: "changed" });
    db.db.exec("PRAGMA busy_timeout = 300");
    const started = performance.now();
    const result = db.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    expect(result.busy).toBe(1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  });

  test("the scrub never waits for a reader and finishes once the reader leaves", async () => {
    const directory = await dataDir();
    // The default ten-second busy timeout: a blocking checkpoint would show.
    const db = database(directory);
    db.writeStore("records", { kept: "kept", secret: "SCRUB-ME-SECRET" });
    const reader = holdReader(directory);
    db.writeStore("records", { kept: "kept" });
    jest.useFakeTimers();

    const started = performance.now();
    db.scrubDeletedContent();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(db.hasDeferredScrub()).toBe(true);
    // The connection's own busy timeout is back for every other statement.
    expect((db.db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(10_000);

    // Still held: the retry fails fast and waits longer next time.
    jest.advanceTimersByTime(SCRUB_RETRY_FIRST_MS);
    expect(db.hasDeferredScrub()).toBe(true);
    expect(walBytes(directory)).toBeGreaterThan(0);

    reader.exec("COMMIT");
    jest.advanceTimersByTime(SCRUB_RETRY_FIRST_MS * 2);
    expect(db.hasDeferredScrub()).toBe(false);
    expect(walBytes(directory)).toBe(0);
    expect(storageFilesContain(directory, "SCRUB-ME-SECRET")).toBe(false);
  });

  test("retries back off to a ceiling and stop when the connection closes", async () => {
    const directory = await dataDir();
    const db = database(directory);
    db.writeStore("records", { first: "value" });
    holdReader(directory);
    db.writeStore("records", { first: "changed" });
    jest.useFakeTimers();
    db.scrubDeletedContent();
    let waited = 0;
    for (let delay = SCRUB_RETRY_FIRST_MS; waited < SCRUB_RETRY_MAX_MS * 4;) {
      jest.advanceTimersByTime(delay);
      waited += delay;
      expect(db.hasDeferredScrub()).toBe(true);
      delay = Math.min(delay * 2, SCRUB_RETRY_MAX_MS);
    }
    db.close();
    expect(db.hasDeferredScrub()).toBe(false);
    expect(() => jest.advanceTimersByTime(SCRUB_RETRY_MAX_MS)).not.toThrow();
  });

  test("close truncates a deferred WAL once its reader leaves", async () => {
    const directory = await dataDir();
    const db = database(directory);
    db.writeStore("records", { secret: "CLOSE-SECRET" });
    const reader = holdReader(directory);
    db.writeStore("records", {});
    db.scrubDeletedContent();
    expect(db.hasDeferredScrub()).toBe(true);
    expect(walBytes(directory)).toBeGreaterThan(0);
    reader.exec("COMMIT");
    db.close();
    expect(walBytes(directory)).toBe(0);
    expect(storageFilesContain(directory, "CLOSE-SECRET")).toBe(false);
  });

  test("with no reader the scrub truncates at once and schedules nothing", async () => {
    const directory = await dataDir();
    const db = database(directory);
    db.writeStore("records", { secret: "IMMEDIATE-SECRET" });
    db.writeStore("records", {});
    db.scrubDeletedContent();
    expect(db.hasDeferredScrub()).toBe(false);
    expect(walBytes(directory)).toBe(0);
    expect(storageFilesContain(directory, "IMMEDIATE-SECRET")).toBe(false);
  });
});

describe("maintenance settings (report 0910)", () => {
  test("optimize writes planner statistics for the tables this connection queried", async () => {
    const directory = await dataDir();
    const ledger = openChangeLedgerDatabase(directory);
    open.push(ledger);
    const insert = ledger.db.query(
      "INSERT INTO change_outbox (resource_key, revision, event_kind, created_at) VALUES (?, 1, 'changed', '')",
    );
    ledger.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) insert.run(`key-${index % 40}`);
    });
    ledger.db.query("SELECT * FROM change_outbox WHERE delivered = 0 ORDER BY sequence").all();
    await runDatabaseUpkeep(ledger);
    expect(
      ledger.db
        .query("SELECT count(*) AS count FROM sqlite_master WHERE name = 'sqlite_stat1'")
        .get(),
    ).toEqual({ count: 1 });
    expect(ledger.db.query("SELECT * FROM sqlite_stat1").all().length).toBeGreaterThan(0);
  });

  test("optimize never waits for another writer and never throws", async () => {
    const directory = await dataDir();
    const db = database(directory);
    db.writeStore("records", { first: "value" });
    const writer = new Database(path.join(directory, STORAGE_DATABASE_FILE));
    open.push(writer);
    writer.exec("BEGIN IMMEDIATE");
    db.readStore("records");
    const started = performance.now();
    expect(() => db.optimize()).not.toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect((db.db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(10_000);
    writer.exec("ROLLBACK");
  });

  test("checkpoints sync with checkpoint_fullfsync on both files; commits keep fullfsync off", async () => {
    // macOS's system SQLite defaults checkpoint_fullfsync on only through a
    // build option (DEFAULT_CKPTFULLFSYNC); Bun's own build on Linux does not.
    // The connection sets it, so neither the library nor the platform decides.
    const directory = await dataDir();
    const main = openBackendDatabase(directory);
    open.push(main);
    const ledger = openChangeLedgerDatabase(directory);
    open.push(ledger);
    for (const db of [main, ledger]) {
      expect(db.db.query("PRAGMA checkpoint_fullfsync").get()).toEqual({
        checkpoint_fullfsync: 1,
      });
      expect(db.db.query("PRAGMA fullfsync").get()).toEqual({ fullfsync: 0 });
    }
  });

  test("foreign_keys stays off because no table declares a foreign key", async () => {
    const directory = await dataDir();
    const main = openBackendDatabase(directory);
    open.push(main);
    const ledger = openChangeLedgerDatabase(directory);
    open.push(ledger);
    for (const db of [main, ledger]) {
      expect(
        (db.db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
      ).toBe(0);
      // A migration that declares a key must turn the PRAGMA on with it.
      const keys = db.db
        .query(
          "SELECT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) WHERE m.type = 'table'",
        )
        .all();
      expect(keys).toEqual([]);
    }
  });
});
