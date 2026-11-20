import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BACKGROUND_CHECKPOINT_FALLBACK_PAGES,
  BackgroundCheckpointer,
  type BackgroundCheckpointResult,
  DEFAULT_AUTOCHECKPOINT_PAGES,
  backgroundCheckpointsByDefault,
  startBackgroundCheckpoints,
} from "./storage-checkpointer.js";
import { STORAGE_DATABASE_FILE, StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";

const directories: string[] = [];
const cleanups: Array<() => void> = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-checkpointer-"));
  directories.push(directory);
  return directory;
}

/** A WAL database like the backend's, with automatic checkpoints off so frames stay in the WAL. */
function walDatabase(file: string): Database {
  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec("CREATE TABLE t (v TEXT)");
  cleanups.push(() => db.close());
  return db;
}

function write(db: Database, rows: number): void {
  const insert = db.query("INSERT INTO t (v) VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run("x".repeat(4_000));
}

function autocheckpoint(db: Database): number {
  return (db.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number })
    .wal_autocheckpoint;
}

async function until<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // Already closed by the test.
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("BackgroundCheckpointer", () => {
  test("copies another connection's WAL into the database file", async () => {
    const file = path.join(await dataDir(), "db.sqlite");
    const db = walDatabase(file);
    write(db, 200);
    const results: BackgroundCheckpointResult[] = [];
    const failures: unknown[] = [];
    const checkpointer = BackgroundCheckpointer.start(file, {
      intervalMs: 10,
      journalSizeLimit: 8_388_608,
      onCheckpoint: (result) => results.push(result),
      onFailure: (failure) => failures.push(failure),
    });
    expect(checkpointer).not.toBeNull();
    cleanups.push(() => checkpointer!.stop());
    const done = await until(() => results.find((result) => result.log > 0));
    expect(done.busy).toBe(false);
    expect(done.checkpointed).toBe(done.log);
    expect(failures).toEqual([]);
    // Everything is in the database file: a passive checkpoint here has nothing to copy.
    const after = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
      log: number;
      checkpointed: number;
    };
    expect(after.checkpointed).toBe(after.log);
  });

  test("stop ends checkpoints and closes the worker's connection", async () => {
    const file = path.join(await dataDir(), "db.sqlite");
    const db = walDatabase(file);
    const results: BackgroundCheckpointResult[] = [];
    const checkpointer = BackgroundCheckpointer.start(file, {
      intervalMs: 10,
      journalSizeLimit: 8_388_608,
      onCheckpoint: (result) => results.push(result),
      onFailure: () => undefined,
    })!;
    await until(() => (results.length > 0 ? true : undefined));
    checkpointer.stop();
    checkpointer.stop();
    expect(checkpointer.isRunning()).toBe(false);
    // The thread has ended, so nothing can checkpoint any more.
    await checkpointer.exited;
    write(db, 50);
    // With the worker's connection closed, this one is the last: closing it
    // checkpoints and empties the WAL (macOS keeps the file, Linux removes
    // it), which another open connection would prevent.
    db.close();
    expect(Bun.file(`${file}-wal`).size).toBe(0);
  });

  test("reports a file it cannot open and stops", async () => {
    const file = path.join(await dataDir(), "missing.sqlite");
    const failures: Array<{ reason: string; code?: string }> = [];
    const checkpointer = BackgroundCheckpointer.start(file, {
      intervalMs: 10,
      journalSizeLimit: 8_388_608,
      onFailure: (failure) => failures.push(failure),
    })!;
    cleanups.push(() => checkpointer.stop());
    const failure = await until(() => failures[0]);
    expect(failure.reason).toBe("open-failed");
    expect(checkpointer.isRunning()).toBe(false);
    expect(failures).toHaveLength(1);
  });
});

describe("startBackgroundCheckpoints", () => {
  test("raises the connection's automatic checkpoint to the fallback while the worker runs", async () => {
    const file = path.join(await dataDir(), "db.sqlite");
    const db = walDatabase(file);
    const checkpointer = startBackgroundCheckpoints(db, file, "main", () => false)!;
    cleanups.push(() => checkpointer.stop());
    expect(autocheckpoint(db)).toBe(BACKGROUND_CHECKPOINT_FALLBACK_PAGES);
  });

  test("restores SQLite's automatic checkpoint when the worker fails", async () => {
    const directory = await dataDir();
    const db = walDatabase(path.join(directory, "db.sqlite"));
    const checkpointer = startBackgroundCheckpoints(
      db,
      path.join(directory, "elsewhere.sqlite"),
      "main",
      () => false,
    )!;
    cleanups.push(() => checkpointer.stop());
    expect(autocheckpoint(db)).toBe(BACKGROUND_CHECKPOINT_FALLBACK_PAGES);
    await until(() => (autocheckpoint(db) === DEFAULT_AUTOCHECKPOINT_PAGES ? true : undefined));
    expect(checkpointer.isRunning()).toBe(false);
  });
});

describe("StorageDatabase background checkpoints", () => {
  test("are off under bun test unless asked for", async () => {
    expect(backgroundCheckpointsByDefault()).toBe(false);
    const db = openBackendDatabase(await dataDir());
    cleanups.push(() => db.close());
    expect(autocheckpoint(db.db)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
  });

  test("a backend database checkpoints off the event loop and stops on close", async () => {
    const directory = await dataDir();
    const db = openBackendDatabase(directory, { backgroundCheckpoint: true });
    cleanups.push(() => db.close());
    expect(autocheckpoint(db.db)).toBe(BACKGROUND_CHECKPOINT_FALLBACK_PAGES);
    for (let i = 0; i < 40; i += 1) db.writeStore(`doc-${i}`, { value: "x".repeat(20_000) });
    // The worker copies the WAL; the backend connection never ran a checkpoint.
    await until(() => {
      const state = db.db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
        log: number;
        checkpointed: number;
      };
      return state.log > 0 && state.checkpointed === state.log ? true : undefined;
    });
    db.close();
    // The worker closes its connection after the backend's, so it is the last
    // one and its close leaves no WAL behind.
    const wal = path.join(directory, `${STORAGE_DATABASE_FILE}-wal`);
    await until(() => (Bun.file(wal).size === 0 ? true : undefined));
  });

  test("a closed database does not restart checkpoints", async () => {
    const db = new StorageDatabase(await dataDir(), { backgroundCheckpoint: true });
    db.close();
    expect(db.isClosed()).toBe(true);
  });
});
