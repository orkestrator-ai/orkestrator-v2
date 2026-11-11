import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { STORAGE_TIMING_BUCKETS_MS } from "@orkestrator/protocol/backend-diagnostics";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_STORAGE_READ_SERIES,
  StorageActivityMetrics,
  readSeriesForStore,
  readSeriesForTable,
} from "./storage-activity-metrics.js";
import { BackendDiagnostics } from "./backend-diagnostics.js";
import {
  CHANGE_LEDGER_DATABASE_FILE,
  STORAGE_DATABASE_FILE,
  StorageDatabase,
} from "./storage-database.js";
import { classifyStatement, instrumentSqliteConnection } from "./storage-slow-operations.js";

const directories: string[] = [];
const open: Array<{ close(): void }> = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-activity-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
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

function database(
  directory: string,
  activity: StorageActivityMetrics,
  options: { file?: string } = {},
): StorageDatabase {
  const db = new StorageDatabase(directory, {
    activity,
    file: options.file,
    layoutFor: () => ({ kind: "record" }),
  });
  open.push(db);
  return db;
}

describe("StorageActivityMetrics", () => {
  test("counts into fixed buckets and keeps totals, maxima and the start time", () => {
    const metrics = new StorageActivityMetrics(() => Date.parse("2026-11-11T10:00:00.000Z"));
    metrics.connectionOpened("main");
    metrics.commit("main", 0.05);
    metrics.commit("main", 3.21234);
    metrics.commit("main", 5_000);
    metrics.checkpoint("ledger", 2);
    metrics.read("main", "records", 0.5);

    const snapshot = metrics.snapshot();
    expect(snapshot.since).toBe("2026-11-11T10:00:00.000Z");
    expect(snapshot.bucketsMs).toEqual(STORAGE_TIMING_BUCKETS_MS);
    const commits = snapshot.files.main!.commits;
    expect(commits.count).toBe(3);
    expect(commits.maxMs).toBe(5_000);
    expect(commits.totalMs).toBe(5_003.262);
    expect(commits.buckets).toHaveLength(STORAGE_TIMING_BUCKETS_MS.length + 1);
    // 0.05 ≤ 0.1, 3.2 ≤ 4, 5 000 past the last bound.
    expect(commits.buckets[0]).toBe(1);
    expect(commits.buckets[STORAGE_TIMING_BUCKETS_MS.indexOf(4)]).toBe(1);
    expect(commits.buckets.at(-1)).toBe(1);
    expect(snapshot.files.main!.connections).toBe(1);
    expect(snapshot.files.main!.reads).toEqual({
      records: { count: 1, totalMs: 0.5, maxMs: 0.5, buckets: expect.any(Array) },
    });
    expect(snapshot.files.ledger!.checkpoints.count).toBe(1);
    expect(snapshot.files.ledger!.commits.count).toBe(0);
  });

  test("bounds the read series per file and folds the rest into other", () => {
    const metrics = new StorageActivityMetrics();
    for (let index = 0; index < MAX_STORAGE_READ_SERIES + 10; index += 1) {
      metrics.read("main", `family-${index}`, 1);
    }
    const snapshot = metrics.snapshot();
    const reads = snapshot.files.main!.reads;
    expect(Object.keys(reads).length).toBeLessThanOrEqual(MAX_STORAGE_READ_SERIES + 1);
    expect(reads.other!.count).toBe(10);
    expect(snapshot.readsOverflowed).toBe(10);
  });

  test("snapshots are copies, and a non-finite time counts as zero", () => {
    const metrics = new StorageActivityMetrics();
    metrics.commit("main", Number.NaN);
    const first = metrics.snapshot();
    first.files.main!.commits.buckets[0] = 99;
    expect(metrics.snapshot().files.main!.commits).toMatchObject({ count: 1, totalMs: 0 });
    expect(metrics.snapshot().files.main!.commits.buckets[0]).toBe(1);
  });

  test("series names hold a family or a table, never an id", () => {
    expect(readSeriesForStore("web-annotations/123e4567-e89b-12d3-a456-426614174000")).toBe(
      "web-annotations",
    );
    expect(readSeriesForStore("/Users/someone/data")).toBe("outside-data-dir");
    expect(readSeriesForTable("stores")).toBe("table:stores");
    expect(readSeriesForTable(null)).toBe("other");
  });
});

describe("classifyStatement", () => {
  test("separates reads, changes, writes and checkpoints", () => {
    expect(classifyStatement("SELECT revision FROM stores WHERE name = ?")).toEqual({
      effect: "read",
      table: "stores",
    });
    expect(classifyStatement("INSERT INTO store_rows VALUES (?)").effect).toBe("change");
    expect(classifyStatement("UPDATE stores SET revision = 1").effect).toBe("change");
    expect(classifyStatement("DELETE FROM store_rows").effect).toBe("change");
    expect(classifyStatement("CREATE TABLE IF NOT EXISTS t (a)").effect).toBe("write");
    expect(classifyStatement("PRAGMA incremental_vacuum(256)").effect).toBe("write");
    expect(classifyStatement("PRAGMA wal_checkpoint(TRUNCATE)").effect).toBe("checkpoint");
    expect(classifyStatement("PRAGMA busy_timeout = 0").effect).toBe("none");
    expect(classifyStatement("VACUUM INTO ?").effect).toBe("none");
    expect(classifyStatement("BEGIN").effect).toBe("none");
  });
});

describe("commit and read counts on a StorageDatabase", () => {
  test("each write transaction that changed something is one commit on its file", async () => {
    const directory = await dataDir();
    const activity = new StorageActivityMetrics();
    const db = database(directory, activity);
    const opened = activity.snapshot().files.main!;
    expect(opened.connections).toBe(1);

    db.writeStore("records", { a: "one" });
    db.writeStore("records", { a: "two", b: "three" });
    const after = activity.snapshot().files.main!;
    expect(after.commits.count - opened.commits.count).toBe(2);
    expect(after.commits.maxMs).toBeGreaterThan(0);
  });

  test("a write transaction that changed nothing, and a failed one, are not commits", async () => {
    const directory = await dataDir();
    const activity = new StorageActivityMetrics();
    const db = database(directory, activity);
    db.writeStore("records", { a: "one" });
    const before = activity.snapshot().files.main!.commits.count;

    db.transaction(() => {
      db.db.query("UPDATE stores SET revision = revision WHERE name = 'missing'").run();
    });
    expect(() =>
      db.transaction(() => {
        db.db.query("UPDATE stores SET revision = revision + 1 WHERE name = 'records'").run();
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");
    expect(activity.snapshot().files.main!.commits.count).toBe(before);
  });

  test("statements outside a transaction count as commits, reads or checkpoints", async () => {
    const directory = await dataDir();
    const activity = new StorageActivityMetrics();
    const db = database(directory, activity);
    const before = activity.snapshot().files.main!;

    db.db.run("INSERT INTO storage_meta (key, value) VALUES ('activity-test', 'x')");
    db.db.run("DELETE FROM storage_meta WHERE key = 'not-there'");
    db.storeRevision("records");
    db.db.query("PRAGMA wal_checkpoint(PASSIVE)").get();

    const after = activity.snapshot().files.main!;
    expect(after.commits.count - before.commits.count).toBe(1);
    expect(after.reads["table:stores"]!.count).toBeGreaterThanOrEqual(1);
    expect(after.checkpoints.count - before.checkpoints.count).toBe(1);
  });

  test("a store read is timed under its family, whether the cache served it or not", async () => {
    const directory = await dataDir();
    const activity = new StorageActivityMetrics();
    const writer = database(directory, activity);
    const store = "web-annotations/123e4567-e89b-12d3-a456-426614174000";
    writer.writeStore(store, { a: "value" });
    const reader = database(directory, activity);

    expect(reader.readStore(store)?.value).toEqual({ a: "value" });
    expect(reader.readStore(store)?.value).toEqual({ a: "value" });
    const reads = activity.snapshot().files.main!.reads;
    expect(reads["web-annotations"]!.count).toBe(2);
    expect(JSON.stringify(activity.snapshot())).not.toContain("123e4567");
    expect(activity.snapshot().files.main!.connections).toBe(2);
  });

  test("the ledger file counts separately from the main file", async () => {
    const directory = await dataDir();
    const activity = new StorageActivityMetrics();
    database(directory, activity);
    const ledger = database(directory, activity, { file: CHANGE_LEDGER_DATABASE_FILE });
    const before = activity.snapshot();
    ledger.writeStore("records", { a: "one" });
    const after = activity.snapshot();
    expect(after.files.ledger!.commits.count - before.files.ledger!.commits.count).toBe(1);
    expect(after.files.main!.commits.count).toBe(before.files.main!.commits.count);
  });

  test("the deletion scrub's checkpoint is counted", async () => {
    const directory = await dataDir();
    const activity = new StorageActivityMetrics();
    const db = database(directory, activity);
    db.writeStore("records", { a: "one" });
    db.deleteStore("records");
    const before = activity.snapshot().files.main!.checkpoints.count;
    db.scrubDeletedContent();
    expect(activity.snapshot().files.main!.checkpoints.count).toBe(before + 1);
  });

  test("a nested savepoint's write is the outer transaction's one commit", async () => {
    const directory = await dataDir();
    const activity = new StorageActivityMetrics();
    const db = database(directory, activity);
    db.writeStore("records", { a: "one" });
    const before = activity.snapshot().files.main!;

    db.transaction(() => {
      db.transaction(() => {
        db.db.run("INSERT INTO storage_meta (key, value) VALUES ('nested-ok', 'x')");
      });
    });

    const after = activity.snapshot().files.main!;
    expect(after.commits.count - before.commits.count).toBe(1);
    expect(after.reads).toEqual(before.reads);
    expect(db.db.query("SELECT value FROM storage_meta WHERE key = 'nested-ok'").get()).toEqual({
      value: "x",
    });
  });

  test("a caught nested rollback still commits: its COMMIT appends to the WAL", async () => {
    // A savepoint rolled back inside a transaction that then commits leaves no
    // row, but SQLite still writes the touched page to the WAL and syncs it, so
    // it is counted as a commit, not a read. The WAL size pins that premise.
    const directory = await dataDir();
    const file = path.join(directory, STORAGE_DATABASE_FILE);
    const raw = new Database(file);
    open.push(raw);
    raw.run("PRAGMA journal_mode = WAL");
    raw.run("PRAGMA wal_autocheckpoint = 0");
    raw.run("CREATE TABLE t (a)");
    const activity = new StorageActivityMetrics();
    instrumentSqliteConnection(raw, "main", { activity });
    const walBefore = (await fs.stat(`${file}-wal`)).size;

    raw.transaction(() => {
      try {
        raw.transaction(() => {
          raw.run("INSERT INTO t VALUES (1)");
          throw new Error("nested rolled back");
        })();
      } catch {
        // The outer transaction carries on and commits.
      }
    })();

    const main = activity.snapshot().files.main!;
    expect(main.commits.count).toBe(1);
    expect(main.reads).toEqual({});
    expect((await fs.stat(`${file}-wal`)).size).toBeGreaterThan(walBefore);
    expect(raw.query("SELECT a FROM t").all()).toEqual([]);
  });

  test("a store-less read-only transaction is a read of its slowest statement's table", async () => {
    const directory = await dataDir();
    const raw = new Database(path.join(directory, STORAGE_DATABASE_FILE));
    open.push(raw);
    raw.run("CREATE TABLE things (a)");
    raw.run("INSERT INTO things VALUES (1)");
    const activity = new StorageActivityMetrics();
    instrumentSqliteConnection(raw, "main", { activity });

    expect(raw.transaction(() => raw.query("SELECT a FROM things").all())()).toEqual([{ a: 1 }]);

    const main = activity.snapshot().files.main!;
    expect(main.commits.count).toBe(0);
    expect(Object.keys(main.reads)).toEqual(["table:things"]);
    expect(main.reads["table:things"]!.count).toBe(1);
  });

  test("a RETURNING change read through get, all or values counts as a commit", async () => {
    // Only `run` reports `changes`; the other methods count a change statement
    // as a commit whatever it returned, erring towards the higher fsync rate.
    const directory = await dataDir();
    const raw = new Database(path.join(directory, STORAGE_DATABASE_FILE));
    open.push(raw);
    raw.run("CREATE TABLE t (a)");
    const activity = new StorageActivityMetrics();
    instrumentSqliteConnection(raw, "main", { activity });

    expect(raw.query("INSERT INTO t VALUES (1) RETURNING a").get()).toEqual({ a: 1 });
    expect(raw.query("UPDATE t SET a = 2 RETURNING a").all()).toEqual([{ a: 2 }]);
    expect(raw.query("DELETE FROM t WHERE a = 2 RETURNING a").values()).toEqual([[2]]);
    expect(raw.query("DELETE FROM t WHERE a = 99 RETURNING a").all()).toEqual([]);

    const main = activity.snapshot().files.main!;
    expect(main.commits.count).toBe(4);
    expect(main.reads).toEqual({});
  });

  test("a counting fault never fails the call it describes", async () => {
    const directory = await dataDir();
    const raw = new Database(path.join(directory, STORAGE_DATABASE_FILE));
    open.push(raw);
    const activity = new StorageActivityMetrics();
    activity.commit = () => {
      throw new Error("counter failed");
    };
    activity.read = () => {
      throw new Error("counter failed");
    };
    instrumentSqliteConnection(raw, "main", { activity });
    raw.run("CREATE TABLE t (a)");
    raw.run("INSERT INTO t VALUES (1)");
    expect(raw.transaction(() => raw.query("SELECT a FROM t").all())()).toEqual([{ a: 1 }]);
  });
});

describe("BackendDiagnostics", () => {
  test("database stats, and so /metrics, carry the commit and read counts", async () => {
    const directory = await dataDir();
    const diagnostics = new BackendDiagnostics({ dataDir: directory, changeTracking: () => null });
    open.push({ close: () => diagnostics.close({ clean: false }) });
    // A connection that reports to the process-wide counts, as the backend's do.
    const db = new StorageDatabase(directory, { layoutFor: () => ({ kind: "record" }) });
    open.push(db);
    db.writeStore("records", { a: "one" });
    const stats = diagnostics.databaseStats();
    expect(stats.activity?.bucketsMs).toEqual(STORAGE_TIMING_BUCKETS_MS);
    expect(stats.activity?.files.main?.connections).toBeGreaterThanOrEqual(1);
    expect(stats.activity?.files.main?.commits.count).toBeGreaterThanOrEqual(1);
  });
});
