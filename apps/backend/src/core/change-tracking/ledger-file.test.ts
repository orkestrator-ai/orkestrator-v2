import {
  snapshotQualificationLedger,
  classifyQualificationChanges,
  LEDGER_MOVE_CHANGES,
} from "../../../../../scripts/qualification-ledger.js";
import { afterEach, describe, expect, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { Database } from "bun:sqlite";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBackendChangeTracking } from "./backend-wiring.js";
import { listStorageSnapshots } from "../storage-backups.js";
import {
  STORAGE_DATABASE_FILE,
  StorageDatabase,
  StorageDatabaseVersionError,
} from "../storage-database.js";
import { STORAGE_MIGRATIONS, openBackendDatabase, storeLayout } from "../storage-stores.js";
import {
  CHANGE_LEDGER_DATABASE_FILE,
  CHANGE_LEDGER_FILE_SCHEMA_VERSION,
  CHANGE_LEDGER_MOVE_MIGRATION_VERSION,
  CHANGE_LEDGER_TABLES,
  openChangeLedgerDatabase,
} from "./ledger-schema.js";

const directories: string[] = [];
const open: Array<{ close(): void }> = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-ledger-file-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const handle of open.splice(0).reverse()) handle.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

/** A database as the build before the move left it: schema 6, ledger inside. */
function openBeforeMove(directory: string): StorageDatabase {
  return new StorageDatabase(directory, {
    layoutFor: storeLayout,
    migrations: STORAGE_MIGRATIONS.filter(
      (migration) => migration.version < CHANGE_LEDGER_MOVE_MIGRATION_VERSION,
    ),
  });
}

/** Writes ledger rows the way the old build did, into `orkestrator.sqlite`. */
function seedLedger(db: Database, outboxRows: number): void {
  db.exec("BEGIN IMMEDIATE");
  db.query("INSERT INTO change_ledger_meta (key, value) VALUES ('seq', '42')").run();
  db.query(
    "INSERT INTO change_bindings (id, source_key, environment_id, provider, conversation_id, created_at) VALUES ('b1', 's1', 'env-1', 'claude', 'c1', 'now')",
  ).run();
  const outbox = db.query(
    "INSERT INTO change_outbox (resource_key, revision, event_kind, created_at) VALUES (?, 1, 'changed', 'now')",
  );
  for (let index = 0; index < outboxRows; index += 1) outbox.run(`resource-${index}`);
  // A deleted newest row: its id must still never be reused after the move.
  db.query("DELETE FROM change_outbox WHERE sequence = ?").run(outboxRows);
  db.exec("COMMIT");
}

function tables(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("the change ledger's own file (report 0760)", () => {
  test("only the ledger uses NORMAL; the main store stays FULL on every open", async () => {
    const directory = await dataDir();
    for (let attempt = 0; attempt < 2; attempt++) {
      const main = openBackendDatabase(directory);
      const ledger = openChangeLedgerDatabase(directory);
      try {
        expect(main.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
        expect(ledger.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
        expect(ledger.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(ledger.db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
      } finally {
        ledger.close();
        main.close();
      }
    }
  });

  test("migration scrubs old non-incremental pages and production wiring preserves rows before writing", async () => {
    const directory = await dataDir();
    const raw = new Database(path.join(directory, STORAGE_DATABASE_FILE));
    raw.exec("PRAGMA auto_vacuum = NONE; CREATE TABLE legacy (id INTEGER)");
    raw.close();
    const before = openBeforeMove(directory);
    seedLedger(before.db, 10);
    const marker = "UNIQUE-LEGACY-LEDGER-SECRET-93483";
    before.db.query("INSERT INTO change_ledger_meta VALUES ('secret', ?)").run(marker);
    before.close();
    const service = createBackendChangeTracking({
      dataDir: directory,
      storage: {
        getEnvironment: async () => {
          throw new Error("unused");
        },
        loadConfig: async () => {
          throw new Error("unused");
        },
        loadEnvironmentIdsForCleanup: async () => {
          throw new Error("unused");
        },
      },
      emit: () => {},
      diffStats: { service: { refresh: () => {} }, refreshExplicitly: () => {} },
    });
    try {
      // First ledger write must migrate before it can replace the old rows.
      service.ledger.setMeta("new", "written");
      expect(service.ledger.meta("seq")).toBe("42");
      expect(service.ledger.meta("secret")).toBe(marker);
    } finally {
      service.shutdown();
    }
    const main = openBackendDatabase(directory);
    open.push(main);
    expect(main.db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
    const ledger = openChangeLedgerDatabase(directory);
    open.push(ledger);
    ledger.db.exec("DELETE FROM change_ledger_meta WHERE key = 'secret'");
    main.scrubDeletedContent();
    ledger.scrubDeletedContent();
    for (const file of [STORAGE_DATABASE_FILE, CHANGE_LEDGER_DATABASE_FILE]) {
      for (const suffix of ["", "-wal"]) {
        const location = path.join(directory, file + suffix);
        if (existsSync(location))
          expect((await fs.readFile(location)).includes(Buffer.from(marker))).toBe(false);
      }
    }
  });

  test("migration 7 moves every ledger row out of orkestrator.sqlite, after a safety copy", async () => {
    const directory = await dataDir();
    const before = openBeforeMove(directory);
    seedLedger(before.db, 50);
    before.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Kept" }]);
    before.close();

    const main = openBackendDatabase(directory);
    open.push(main);
    expect(main.schemaVersion()).toBeGreaterThanOrEqual(CHANGE_LEDGER_MOVE_MIGRATION_VERSION);
    expect(tables(main.db).filter((name) => name.startsWith("change_"))).toEqual([]);
    expect(main.readStore("kanban")?.value).toEqual([{ id: "t1", projectId: "p1", title: "Kept" }]);

    const ledger = openChangeLedgerDatabase(directory);
    open.push(ledger);
    expect(ledger.schemaVersion()).toBe(CHANGE_LEDGER_FILE_SCHEMA_VERSION);
    for (const table of CHANGE_LEDGER_TABLES) expect(tables(ledger.db)).toContain(table);
    expect(count(ledger.db, "change_outbox")).toBe(49);
    expect(count(ledger.db, "change_bindings")).toBe(1);
    expect(ledger.db.query("SELECT value FROM change_ledger_meta WHERE key = 'seq'").get()).toEqual(
      {
        value: "42",
      },
    );
    const next = ledger.db
      .query(
        "INSERT INTO change_outbox (resource_key, revision, event_kind, created_at) VALUES ('new', 1, 'changed', 'now') RETURNING sequence",
      )
      .get() as { sequence: number };
    expect(next.sequence).toBe(51);

    // The pre-migration copy still holds the ledger as it was.
    const [safety] = listStorageSnapshots(directory);
    expect(safety?.kind).toBe("pre-migration");
    const copy = new Database(safety!.file, { readonly: true });
    try {
      expect(count(copy, "change_outbox")).toBe(49);
    } finally {
      copy.close();
    }
  });

  test("a move interrupted before its commit is repeated and replaces the partial copy", async () => {
    const directory = await dataDir();
    const before = openBeforeMove(directory);
    seedLedger(before.db, 10);
    before.close();
    // A crash after the copy committed but before migration 7 did: the ledger
    // file holds rows while orkestrator.sqlite still has its tables.
    const stale = openChangeLedgerDatabase(directory);
    stale.db
      .query(
        "INSERT INTO change_outbox (resource_key, revision, event_kind, created_at) VALUES ('partial', 1, 'changed', 'now')",
      )
      .run();
    stale.close();

    open.push(openBackendDatabase(directory));
    const ledger = openChangeLedgerDatabase(directory);
    open.push(ledger);
    expect(
      ledger.db
        .query("SELECT resource_key FROM change_outbox WHERE resource_key = 'partial'")
        .get(),
    ).toBeNull();
    expect(count(ledger.db, "change_outbox")).toBe(9);
  });

  test("a new data directory gets the ledger in its own file and none in the main one", async () => {
    const directory = await dataDir();
    const main = openBackendDatabase(directory);
    open.push(main);
    expect(tables(main.db).filter((name) => name.startsWith("change_"))).toEqual([]);
    expect(listStorageSnapshots(directory)).toEqual([]);
    const ledger = openChangeLedgerDatabase(directory);
    open.push(ledger);
    expect(count(ledger.db, "change_outbox")).toBe(0);
    expect(existsSync(path.join(directory, CHANGE_LEDGER_DATABASE_FILE))).toBe(true);
    expect((await fs.stat(path.join(directory, CHANGE_LEDGER_DATABASE_FILE))).mode & 0o777).toBe(
      0o600,
    );
  });

  test("only a move that carried rows logs ledger.moved", async () => {
    const movedEvents = (capture: ReturnType<typeof captureLogs>) =>
      capture.records().filter((record) => record.event === "ledger.moved");
    const capture = captureLogs();
    try {
      const fresh = await dataDir();
      open.push(openBackendDatabase(fresh));
      expect(movedEvents(capture)).toEqual([]);

      const empty = await dataDir();
      openBeforeMove(empty).close();
      open.push(openBackendDatabase(empty));
      expect(movedEvents(capture)).toEqual([]);

      const populated = await dataDir();
      const before = openBeforeMove(populated);
      seedLedger(before.db, 3);
      before.close();
      open.push(openBackendDatabase(populated));
      const [moved, ...others] = movedEvents(capture);
      expect(others).toEqual([]);
      expect(moved?.fields?.rows).toBeGreaterThan(0);
    } finally {
      capture.restore();
    }
  });

  test("an hourly snapshot of the main database no longer copies the ledger", async () => {
    const directory = await dataDir();
    const main = openBackendDatabase(directory);
    open.push(main);
    const ledger = openChangeLedgerDatabase(directory);
    open.push(ledger);
    ledger.db.exec("INSERT INTO change_ledger_meta (key, value) VALUES ('marker', 'LEDGER-ONLY')");
    const copy = path.join(directory, "copy.sqlite");
    main.backupTo(copy);
    const bytes = await fs.readFile(copy);
    expect(bytes.includes(Buffer.from("LEDGER-ONLY"))).toBe(false);
    expect(path.basename(main.path)).toBe(STORAGE_DATABASE_FILE);
  });

  test("a ledger file newer than this build refuses to open", async () => {
    const directory = await dataDir();
    openChangeLedgerDatabase(directory).close();
    const raw = new Database(path.join(directory, CHANGE_LEDGER_DATABASE_FILE));
    raw.exec(`PRAGMA user_version = ${CHANGE_LEDGER_FILE_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openChangeLedgerDatabase(directory)).toThrow(StorageDatabaseVersionError);
  });
});

test("qualification accepts the actual schema-6 to schema-7 move and rejects ledger loss", async () => {
  const directory = await dataDir();
  const old = openBeforeMove(directory);
  seedLedger(old.db, 3);
  const before = snapshotQualificationLedger(old.path, true);
  old.close();
  const main = openBackendDatabase(directory);
  open.push(main);
  const file = path.join(directory, CHANGE_LEDGER_DATABASE_FILE);
  const differences = () => {
    const after = snapshotQualificationLedger(file);
    return classifyQualificationChanges(
      [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => before[key] !== after[key])
        .map((key) => `${!(key in before) ? "+" : !(key in after) ? "-" : "~"} ${key}`),
      LEDGER_MOVE_CHANGES,
    );
  };
  expect(differences().unexplained).toEqual([]);
  const ledger = new Database(file);
  try {
    ledger.exec("UPDATE change_bindings SET conversation_id='altered'");
    expect(differences().unexplained.length).toBeGreaterThan(0);
    ledger.exec("UPDATE change_bindings SET conversation_id='c1'; DELETE FROM change_outbox");
    expect(differences().unexplained.length).toBeGreaterThan(0);
  } finally {
    ledger.close();
  }
});
