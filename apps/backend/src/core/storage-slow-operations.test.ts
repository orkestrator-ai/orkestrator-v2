import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addEventLoopStallContext,
  startEventLoopStallMonitor,
  type EventLoopStallMonitor,
} from "@orkestrator/protocol/event-loop-stall-monitor";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import {
  CHANGE_LEDGER_DATABASE_FILE,
  STORAGE_DATABASE_FILE,
  StorageDatabase,
} from "./storage-database.js";
import {
  describeStatement,
  instrumentSqliteConnection,
  MAX_SLOW_STORAGE_SERIES,
  SlowStorageOperations,
  STORAGE_CALL_BUCKET_MS,
  STORAGE_CALL_BUCKETS,
  type SlowStorageSample,
} from "./storage-slow-operations.js";

const directories: string[] = [];
const open: Array<{ close(): void }> = [];
const cleanups: Array<() => void> = [];
let capture: LogCapture | null = null;

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-slow-storage-"));
  directories.push(directory);
  return directory;
}

function logs(): LogCapture {
  capture ??= captureLogs();
  return capture;
}

function slowLines() {
  return logs()
    .records()
    .filter((record) => record.area === "storage" && record.event === "operation.slow");
}

/** A second connection holding the write lock, as another process's writer would. */
function holdWriteLock(file: string): Database {
  const holder = new Database(file);
  open.push(holder);
  holder.exec("PRAGMA busy_timeout = 0");
  holder.exec("BEGIN IMMEDIATE");
  return holder;
}

function sample(overrides: Partial<SlowStorageSample> = {}): SlowStorageSample {
  return {
    database: "main",
    op: "select",
    sql: "SELECT value FROM store_rows WHERE store = ?",
    store: null,
    mode: null,
    durationMs: 300,
    beginMs: null,
    sqlMs: null,
    commitMs: null,
    busy: false,
    endedAtMs: 1_000,
    ...overrides,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const handle of open.splice(0).reverse()) {
    try {
      handle.close();
    } catch {
      // Already closed by the test.
    }
  }
  capture?.restore();
  capture = null;
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("describeStatement", () => {
  test("names the kind and the table, never anything a statement carries", () => {
    expect(describeStatement("SELECT revision FROM stores WHERE name = ?")).toEqual({
      op: "select",
      table: "stores",
    });
    expect(
      describeStatement("\n  INSERT OR REPLACE INTO storage_meta (key, value) VALUES (?, ?)"),
    ).toEqual({ op: "insert", table: "storage_meta" });
    expect(describeStatement("UPDATE stores SET revision = ? WHERE name = ?")).toEqual({
      op: "update",
      table: "stores",
    });
    expect(describeStatement("DELETE FROM store_rows WHERE store = ?")).toEqual({
      op: "delete",
      table: "store_rows",
    });
    expect(describeStatement("PRAGMA wal_checkpoint(TRUNCATE)")).toEqual({
      op: "pragma",
      table: "wal_checkpoint",
    });
    expect(describeStatement("PRAGMA busy_timeout = 10000")).toEqual({
      op: "pragma",
      table: "busy_timeout",
    });
    expect(describeStatement("CREATE INDEX IF NOT EXISTS store_rows_position ON x")).toEqual({
      op: "schema",
      table: "store_rows_position",
    });
    expect(describeStatement("VACUUM INTO ?")).toEqual({ op: "vacuum", table: null });
    expect(describeStatement("BEGIN")).toEqual({ op: "other", table: null });
    expect(describeStatement(null)).toEqual({ op: "other", table: null });
  });

  test("keeps no name that could be an id: a literal in a table position is dropped", () => {
    expect(describeStatement("SELECT * FROM t1abc2").table).toBeNull();
    expect(describeStatement("SELECT 'secret' AS x").table).toBeNull();
  });
});

describe("slow SQLite operations on a StorageDatabase", () => {
  test("a write blocked behind another connection's write lock is logged with its store and duration", async () => {
    const directory = await dataDir();
    const recorder = new SlowStorageOperations();
    const database = new StorageDatabase(directory, {
      busyTimeoutMs: 300,
      slowOperations: recorder,
      layoutFor: () => ({ kind: "record" }),
    });
    open.push(database);
    const lines = logs();
    holdWriteLock(path.join(directory, STORAGE_DATABASE_FILE));

    const started = performance.now();
    expect(() => database.writeStore("environments", { private: "PRIVATE-VALUE" })).toThrow();
    const blockedMs = performance.now() - started;
    expect(blockedMs).toBeGreaterThanOrEqual(280);

    const [line] = slowLines();
    expect(line?.level).toBe("warn");
    expect(line?.fields).toMatchObject({
      database: "main",
      op: "transaction",
      store: "environments",
      mode: "immediate",
      busy: true,
    });
    expect(line?.fields).not.toHaveProperty("commitMs");
    const fields = line!.fields as Record<string, number>;
    expect(fields.durationMs).toBeGreaterThanOrEqual(280);
    // The whole wait was for the write lock: the body never ran.
    expect(fields.beginMs).toBe(fields.durationMs);
    // Opening may have recorded a slow migration commit first.
    expect(recorder.snapshot()).toMatchObject({
      thresholdMs: 250,
      series: { "main:transaction:-": { count: 1 } },
    });
    expect(recorder.snapshot().recent.at(-1)).toMatchObject({
      database: "main",
      op: "transaction",
      store: "environments",
      busy: true,
    });
    // Content-free: the value written is in neither the line nor the snapshot.
    expect(JSON.stringify(lines.records())).not.toContain("PRIVATE-VALUE");
    expect(JSON.stringify(recorder.snapshot())).not.toContain("PRIVATE-VALUE");
  });

  test("the event-loop stall line names the blocking store operation and its duration", async () => {
    const directory = await dataDir();
    const recorder = new SlowStorageOperations();
    const database = new StorageDatabase(directory, {
      busyTimeoutMs: 300,
      slowOperations: recorder,
      layoutFor: () => ({ kind: "record" }),
    });
    open.push(database);
    holdWriteLock(path.join(directory, STORAGE_DATABASE_FILE));
    const lines = logs();
    cleanups.push(addEventLoopStallContext((window) => recorder.stallContext(window)));
    let monitor: EventLoopStallMonitor | null = startEventLoopStallMonitor({
      intervalMs: 20,
      thresholdMs: 200,
    });
    cleanups.push(() => monitor?.stop());
    // Let the monitor take an on-time tick, so the stall starts after it.
    await Bun.sleep(30);

    expect(() => database.writeStore("kanban", { a: 1 })).toThrow();
    const deadline = performance.now() + 2_000;
    const stalled = () =>
      lines.records().find((record) => record.area === "event-loop" && record.event === "stalled");
    while (!stalled() && performance.now() < deadline) await Bun.sleep(10);
    monitor.stop();
    monitor = null;

    const fields = stalled()?.fields as Record<string, unknown> | undefined;
    expect(fields).toMatchObject({
      storageDatabase: "main",
      storageOp: "transaction",
      storageStore: "kanban",
      storageBusy: true,
    });
    expect(fields?.storageLongestMs as number).toBeGreaterThanOrEqual(280);
    expect(fields?.lagMs as number).toBeGreaterThanOrEqual(200);
  });

  test("a slow autocommit statement is recorded as a statement, with its table", async () => {
    const directory = await dataDir();
    const recorder = new SlowStorageOperations();
    const database = new StorageDatabase(directory, {
      file: CHANGE_LEDGER_DATABASE_FILE,
      busyTimeoutMs: 300,
      slowOperations: recorder,
    });
    open.push(database);
    holdWriteLock(path.join(directory, CHANGE_LEDGER_DATABASE_FILE));
    logs();
    expect(() =>
      database.db
        .query("INSERT OR REPLACE INTO storage_meta (key, value) VALUES (?, ?)")
        .run("k", "PRIVATE-VALUE"),
    ).toThrow();
    expect(slowLines()[0]?.fields).toMatchObject({
      database: "ledger",
      op: "insert",
      table: "storage_meta",
      busy: true,
    });
    expect(slowLines()[0]?.fields).not.toHaveProperty("mode");
  });
});

describe("instrumentSqliteConnection with a virtual clock", () => {
  function connection(recorder = new SlowStorageOperations()) {
    let clock = 0;
    const db = new Database(":memory:");
    open.push(db);
    db.exec("CREATE TABLE stores (name TEXT)");
    db.function("timed_value", (ms: number) => {
      clock += ms;
      return "PRIVATE-VALUE";
    });
    const timing = instrumentSqliteConnection(db, "main", { recorder, now: () => clock });
    return {
      db,
      timing,
      recorder,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  test("an outermost transaction accumulates slow statements and nested savepoints once", () => {
    const { db, timing, recorder, advance } = connection();
    logs();
    timing.store = "native-agent-sessions/0123456789abcdef0123456789abcdef";
    db.transaction(() => {
      db.query("INSERT INTO stores (name) VALUES (timed_value(?))").run(300);
      advance(100);
      // A nested transaction is a savepoint of the same one, never a second record.
      db.transaction(() => db.query("SELECT timed_value(50) FROM stores").get())();
    }).immediate();
    expect(recorder.snapshot().recent).toEqual([
      expect.objectContaining({
        op: "transaction",
        mode: "immediate",
        table: "stores",
        // A store is kept by family: ids are folded away.
        store: "native-agent-sessions",
        durationMs: 450,
        beginMs: 0,
        sqlMs: 350,
        commitMs: 0,
        busy: false,
      }),
    ]);
    // The store applies to one transaction only.
    expect(timing.store).toBeNull();
    expect(JSON.stringify(logs().records())).not.toContain("PRIVATE-VALUE");
  });

  test("every outermost call is counted once, slow or not", () => {
    const { db, recorder, advance } = connection();
    logs();
    advance(1_000);
    // Two statements outside a transaction, each far under the threshold.
    db.query("SELECT timed_value(?)").get(40);
    db.query("SELECT timed_value(?)").get(60);
    // A transaction is one call however many statements it runs.
    db.transaction(() => {
      db.query("INSERT INTO stores (name) VALUES (timed_value(?))").run(30);
      db.query("SELECT timed_value(?) FROM stores").get(20);
    })();
    expect(recorder.snapshot().recent).toEqual([]);
    expect(recorder.stallContext({ fromMs: 1_000, toMs: 1_150 })).toEqual({
      storageCalls: 3,
      storageCallMs: 150,
      storageMainCallMs: 150,
      storageLedgerCallMs: 0,
    });
  });

  for (const throws of [false, true]) {
    test(`transaction phases include begin, multiple statements and ${throws ? "rollback" : "commit"}`, () => {
      let clock = 0;
      const recorder = new SlowStorageOperations();
      // Controlled driver boundaries: the clock advances inside the begin,
      // statement and commit/rollback calls, rather than between statements.
      const driver = {
        query: (_sql: string) => ({ run: (ms: number) => (clock += ms) }),
        prepare: (_sql: string) => ({ run: (ms: number) => (clock += ms) }),
        transaction: (body: () => unknown) => {
          const invoke = () => {
            clock += 30;
            try {
              return body();
            } finally {
              clock += throws ? 80 : 60;
            }
          };
          return Object.assign(invoke, {
            deferred: invoke,
            immediate: invoke,
            exclusive: invoke,
          });
        },
      };
      const db = driver as unknown as Database;
      const timing = instrumentSqliteConnection(db, "main", { recorder, now: () => clock });
      logs();
      timing.store = "kanban";
      const failure = new Error("PRIVATE-REASON");
      const run = db.transaction(() => {
        db.query("UPDATE stores SET name = ?").run(70);
        db.prepare("INSERT INTO store_rows (value) VALUES (?)").run(300);
        clock += 40;
        if (throws) throw failure;
        return "done";
      });
      if (throws) expect(() => run.immediate()).toThrow(failure);
      else expect(run.immediate()).toBe("done");
      expect(recorder.snapshot().recent).toEqual([
        expect.objectContaining({
          op: "transaction",
          mode: "immediate",
          table: "store_rows",
          store: "kanban",
          durationMs: throws ? 520 : 500,
          beginMs: 30,
          sqlMs: 370,
          commitMs: throws ? 80 : 60,
          busy: false,
        }),
      ]);
      // No per-statement double recording, and throwing resets transaction state.
      expect(slowLines()).toHaveLength(1);
      expect(timing.store).toBeNull();
      db.query("UPDATE stores SET name = ?").run(350);
      expect(recorder.snapshot().recent.at(-1)).toMatchObject({
        op: "update",
        table: "stores",
        durationMs: 350,
        mode: null,
        store: null,
        sqlMs: null,
      });
      expect(JSON.stringify(logs().records())).not.toContain("PRIVATE-REASON");
    });
  }

  test("a throwing transaction rolls back its writes and retains slow-statement attribution", () => {
    const { db, timing, recorder } = connection();
    logs();
    timing.store = "kanban";
    expect(() =>
      db
        .transaction(() => {
          db.query("INSERT INTO stores (name) VALUES (timed_value(?))").run(400);
          throw new Error("rollback");
        })
        .immediate(),
    ).toThrow("rollback");
    expect(db.query("SELECT * FROM stores").all()).toEqual([]);
    expect(recorder.snapshot().recent).toEqual([
      expect.objectContaining({
        op: "transaction",
        table: "stores",
        store: "kanban",
        durationMs: 400,
        sqlMs: 400,
        busy: false,
      }),
    ]);
  });

  test("calls under the threshold record nothing", () => {
    const { db, recorder, advance } = connection();
    db.transaction(() => {
      advance(249);
      db.query("SELECT name FROM stores").all();
    })();
    db.query("SELECT name FROM stores").all();
    expect(recorder.snapshot().recent).toEqual([]);
  });
});

describe("SlowStorageOperations", () => {
  test("folds repeats of one series into the next line, but always writes a long one", () => {
    const recorder = new SlowStorageOperations(250, { logIntervalMs: 10_000, alwaysLogMs: 5_000 });
    logs();
    recorder.record(sample({ endedAtMs: 1_000, durationMs: 300 }));
    recorder.record(sample({ endedAtMs: 2_000, durationMs: 900 }));
    recorder.record(sample({ endedAtMs: 3_000, durationMs: 400 }));
    recorder.record(sample({ endedAtMs: 4_000, durationMs: 6_000 }));
    recorder.record(sample({ endedAtMs: 20_000, durationMs: 260 }));
    expect(slowLines().map((line) => line.fields)).toEqual([
      expect.objectContaining({ durationMs: 300 }),
      expect.objectContaining({ durationMs: 6_000, folded: 2, foldedMaxMs: 900 }),
      expect.not.objectContaining({ folded: expect.anything() }),
    ]);
    expect(recorder.snapshot().series["main:select:store_rows"]).toEqual({
      count: 5,
      totalMs: 7_860,
      maxMs: 6_000,
    });
  });

  test("caps its series and its recent list", () => {
    const recorder = new SlowStorageOperations();
    logs();
    const tables = Array.from({ length: MAX_SLOW_STORAGE_SERIES + 5 }, (_, index) =>
      "t".concat("_", String.fromCharCode(97 + (index % 26)).repeat(1 + Math.floor(index / 26))),
    );
    for (const [index, table] of tables.entries()) {
      recorder.record(sample({ sql: `SELECT * FROM ${table}`, endedAtMs: index * 20_000 }));
    }
    const snapshot = recorder.snapshot();
    expect(Object.keys(snapshot.series).length).toBe(MAX_SLOW_STORAGE_SERIES + 1);
    expect(snapshot.overflowed).toBe(5);
    expect(snapshot.recent.length).toBe(32);
  });

  test("a stall's context is the longest slow operation overlapping its window", () => {
    const recorder = new SlowStorageOperations();
    logs();
    recorder.record(sample({ endedAtMs: 1_000, durationMs: 300 }));
    recorder.record(
      sample({
        op: "transaction",
        store: "kanban",
        mode: "immediate",
        endedAtMs: 5_000,
        durationMs: 2_000,
      }),
    );
    recorder.record(sample({ endedAtMs: 5_400, durationMs: 400 }));
    expect(recorder.stallContext({ fromMs: 2_500, toMs: 5_500 })).toEqual({
      storageMs: 2_400,
      storageDatabase: "main",
      storageOp: "transaction",
      storageTable: "store_rows",
      storageStore: "kanban",
      storageLongestMs: 2_000,
      storageBusy: false,
    });
    expect(recorder.stallContext({ fromMs: 6_000, toMs: 7_000 })).toBeUndefined();
  });

  test("a stall also counts every call under the threshold, by database", () => {
    const recorder = new SlowStorageOperations();
    logs();
    recorder.recordCall("main", 40, 10_010);
    recorder.recordCall("ledger", 120, 10_300);
    recorder.recordCall("ledger", 90, 11_900);
    recorder.recordCall("other", 5, 11_950);
    // Outside the window, beyond the bucket at either edge.
    recorder.recordCall("main", 500, 9_600);
    recorder.recordCall("main", 500, 12_400);
    expect(recorder.stallContext({ fromMs: 10_000, toMs: 12_000 })).toEqual({
      storageCalls: 4,
      storageCallMs: 255,
      storageMainCallMs: 40,
      storageLedgerCallMs: 210,
    });
    // A slow operation in the window adds its own fields beside the counts.
    recorder.record(sample({ endedAtMs: 11_000, durationMs: 300 }));
    expect(recorder.stallContext({ fromMs: 10_000, toMs: 12_000 })).toMatchObject({
      storageCalls: 4,
      storageMs: 300,
      storageLongestMs: 300,
    });
    expect(recorder.stallContext({ fromMs: 20_000, toMs: 21_000 })).toBeUndefined();
  });

  test("call buckets from an older lap of the ring read as empty", () => {
    const recorder = new SlowStorageOperations();
    const lap = STORAGE_CALL_BUCKET_MS * STORAGE_CALL_BUCKETS;
    recorder.recordCall("main", 70, 1_000);
    // The same slot one lap later: the old total is not carried into it.
    recorder.recordCall("main", 30, 1_000 + lap);
    expect(recorder.stallContext({ fromMs: 1_000, toMs: 1_100 })).toBeUndefined();
    expect(recorder.stallContext({ fromMs: 1_000 + lap, toMs: 1_100 + lap })).toMatchObject({
      storageCalls: 1,
      storageCallMs: 30,
    });
    // A window longer than the ring sums only its newest lap.
    expect(recorder.stallContext({ fromMs: 0, toMs: 1_100 + lap })).toMatchObject({
      storageCalls: 1,
    });
  });

  test("a stall counts only storage time inside either edge of its window", () => {
    const recorder = new SlowStorageOperations();
    logs();
    recorder.record(sample({ endedAtMs: 1_000, durationMs: 600 })); // 400–1,000
    recorder.record(sample({ endedAtMs: 1_400, durationMs: 300 })); // 1,100–1,400
    recorder.record(sample({ endedAtMs: 2_000, durationMs: 500 })); // 1,500–2,000
    expect(recorder.stallContext({ fromMs: 800, toMs: 1_700 })).toMatchObject({
      storageMs: 700, // 200 + 300 + 200
      storageLongestMs: 600,
    });
    expect(recorder.stallContext({ fromMs: 500, toMs: 700 })).toMatchObject({
      storageMs: 200,
      storageLongestMs: 600,
    });
    expect(recorder.stallContext({ fromMs: 1_000, toMs: 1_100 })).toMatchObject({
      storageMs: 0,
    });
    expect(recorder.stallContext({ fromMs: 2_100, toMs: 2_500 })).toBeUndefined();
  });
});
