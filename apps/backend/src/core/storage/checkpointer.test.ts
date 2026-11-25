import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
} from "./checkpointer.js";
import { openBackendDatabase } from "./stores.js";

const directories: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

function trackWorker(checkpointer: BackgroundCheckpointer): BackgroundCheckpointer {
  cleanups.push(async () => {
    checkpointer.stop();
    await checkpointer.exited;
  });
  return checkpointer;
}

function observeWorkers(onCheckpoint?: (result: BackgroundCheckpointResult) => void) {
  const workers: BackgroundCheckpointer[] = [];
  const start = BackgroundCheckpointer.start;
  const spy = spyOn(BackgroundCheckpointer, "start").mockImplementation((file, options) => {
    const worker = start(file, { ...options, intervalMs: 10, onCheckpoint });
    if (worker) workers.push(trackWorker(worker));
    return worker;
  });
  cleanups.push(() => spy.mockRestore());
  return { workers, spy };
}

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

/**
 * Proves no connection to the file is left: SQLite empties the WAL (macOS
 * keeps the file, Linux removes it) only when the last connection closes, so
 * a fresh sole connection's close empties it unless another is still open.
 *
 * The WAL's size straight after the backend and its worker close proves
 * nothing by itself. They close on two threads, and when both ask for the
 * exclusive lock at the same moment each sees the other's connection and
 * neither empties it (flake 10019).
 */
function expectNoOpenConnection(file: string): void {
  const probe = new Database(file);
  probe.query("SELECT count(*) FROM sqlite_master").get();
  probe.close();
  expect(Bun.file(`${file}-wal`).size).toBe(0);
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
      await cleanup();
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
    trackWorker(checkpointer!);
    const done = await until(() => results.find((result) => result.log > 0));
    expect(done.busy).toBe(false);
    expect(done.checkpointed).toBe(done.log);
    expect(failures).toEqual([]);
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
    trackWorker(checkpointer);
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
    trackWorker(checkpointer);
    const failure = await until(() => failures[0]);
    expect(failure.reason).toBe("open-failed");
    expect(checkpointer.isRunning()).toBe(false);
    expect(failures).toHaveLength(1);
  });
});

describe("startBackgroundCheckpoints", () => {
  test("restores SQLite's automatic checkpoint when the worker fails", async () => {
    const directory = await dataDir();
    const db = walDatabase(path.join(directory, "db.sqlite"));
    const { workers } = observeWorkers();
    const release = startBackgroundCheckpoints(
      db,
      path.join(directory, "elsewhere.sqlite"),
      "main",
      () => true,
    );
    cleanups.push(release);
    expect(autocheckpoint(db)).toBe(BACKGROUND_CHECKPOINT_FALLBACK_PAGES);
    await workers[0]!.exited;
    expect(autocheckpoint(db)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
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
    const copied = Promise.withResolvers<BackgroundCheckpointResult>();
    const { workers } = observeWorkers((result) => {
      if (!result.busy && result.log > 0 && result.checkpointed === result.log)
        copied.resolve(result);
    });
    const db = openBackendDatabase(directory, { backgroundCheckpoint: true });
    cleanups.push(() => db.close());
    expect(autocheckpoint(db.db)).toBe(BACKGROUND_CHECKPOINT_FALLBACK_PAGES);
    for (let i = 0; i < 40; i += 1) db.writeStore(`doc-${i}`, { value: "x".repeat(20_000) });
    expect((await copied.promise).checkpointed).toBeGreaterThan(0);
    db.close();
    await workers[0]!.exited;
    expectNoOpenConnection(db.path);
  });

  test("connections to the same resolved file share a worker until the last close", async () => {
    const directory = await dataDir();
    const alias = path.join(await dataDir(), "alias");
    await fs.symlink(directory, alias);
    const { workers, spy } = observeWorkers();
    const first = openBackendDatabase(directory, { backgroundCheckpoint: true });
    const second = openBackendDatabase(alias, { backgroundCheckpoint: true });
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(autocheckpoint(first.db)).toBe(BACKGROUND_CHECKPOINT_FALLBACK_PAGES);
    expect(autocheckpoint(second.db)).toBe(BACKGROUND_CHECKPOINT_FALLBACK_PAGES);
    first.close();
    expect(workers[0]!.isRunning()).toBe(true);
    second.writeStore("fixture", { value: "x".repeat(20_000) });
    second.close();
    expect(workers[0]!.isRunning()).toBe(false);
    await workers[0]!.exited;
    expectNoOpenConnection(second.path);
  });

  test("the shared worker retries after an independent checkpoint holds the lock", async () => {
    const directory = await dataDir();
    const busy = Promise.withResolvers<void>();
    const copied = Promise.withResolvers<void>();
    let sawBusy = false;
    const { spy } = observeWorkers((result) => {
      if (result.busy) {
        sawBusy = true;
        busy.resolve();
      } else if (sawBusy && result.log > 0 && result.checkpointed === result.log) {
        copied.resolve();
      }
    });
    const writer = openBackendDatabase(directory, { backgroundCheckpoint: true });
    const second = openBackendDatabase(directory, { backgroundCheckpoint: true });
    const reader = new Database(writer.path);
    cleanups.push(
      () => writer.close(),
      () => second.close(),
      () => reader.close(),
    );
    writer.writeStore("fixture", { version: 1 });
    reader.exec("BEGIN");
    reader.query("SELECT revision FROM stores WHERE name = 'fixture'").get();
    second.writeStore("fixture", { version: 2 });

    // RESTART holds the checkpoint lock while its busy handler waits for
    // the old reader. The production PASSIVE worker must report busy. Taking
    // that lock never waits, so a RESTART that meets a PASSIVE pass already
    // running returns busy at once (flake 10017): ask again until the reader
    // is gone and one completes.
    const source = URL.createObjectURL(
      new Blob(
        [
          `
      const { Database } = require("bun:sqlite");
      self.onmessage = ({ data: file }) => {
        const db = new Database(file);
        db.exec("PRAGMA busy_timeout = 10000");
        db.query("SELECT revision FROM stores WHERE name = 'fixture'").get();
        while (db.query("PRAGMA wal_checkpoint(RESTART)").get().busy) {}
        db.close();
        process.exit(0);
      };
    `,
        ],
        { type: "application/javascript" },
      ),
    );
    const competing = new Worker(source);
    const exited = new Promise<void>((resolve) =>
      competing.addEventListener("close", () => resolve()),
    );
    try {
      competing.postMessage(writer.path);
      await busy.promise;
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      reader.exec("ROLLBACK");
      await exited;
      URL.revokeObjectURL(source);
    }
    await copied.promise;
  });

  test("post-open failure restores each live connection and leaves closed ones alone", async () => {
    const directory = await dataDir();
    const postMessage = Worker.prototype.postMessage;
    const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      message: { type: string },
    ) {
      // The checkpointer only requests a checkpoint after it receives 'opened'.
      if (message.type === "checkpoint") throw new Error("fixture worker transport failed");
      postMessage.call(this, message);
    });
    cleanups.push(() => post.mockRestore());
    const { workers, spy } = observeWorkers();
    const first = openBackendDatabase(directory, { backgroundCheckpoint: true });
    const second = openBackendDatabase(directory, { backgroundCheckpoint: true });
    const closing = openBackendDatabase(directory, { backgroundCheckpoint: true });
    cleanups.push(
      () => first.close(),
      () => second.close(),
      () => closing.close(),
    );
    const exec = spyOn(closing.db, "exec");
    cleanups.push(() => exec.mockRestore());
    closing.close();
    const callsAtClose = exec.mock.calls.length;
    expect(autocheckpoint(first.db)).toBe(BACKGROUND_CHECKPOINT_FALLBACK_PAGES);
    expect(autocheckpoint(second.db)).toBe(BACKGROUND_CHECKPOINT_FALLBACK_PAGES);

    await workers[0]!.exited;
    expect(post.mock.calls.some(([message]) => message.type === "checkpoint")).toBe(true);
    expect(autocheckpoint(first.db)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
    expect(autocheckpoint(second.db)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
    expect(exec).toHaveBeenCalledTimes(callsAtClose);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(workers[0]!.isRunning()).toBe(false);
  });

  test("an immediate close stops the sole worker without touching the closed connection", async () => {
    const { workers, spy } = observeWorkers();
    const db = openBackendDatabase(await dataDir(), { backgroundCheckpoint: true });
    cleanups.push(() => db.close());
    const exec = spyOn(db.db, "exec");
    cleanups.push(() => exec.mockRestore());
    db.close();
    const callsAtClose = exec.mock.calls.length;
    await workers[0]!.exited;
    expect(db.isClosed()).toBe(true);
    expect(workers[0]!.isRunning()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(callsAtClose);
  });
});
