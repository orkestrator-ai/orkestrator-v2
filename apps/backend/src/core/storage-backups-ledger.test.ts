import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { Database } from "bun:sqlite";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openChangeLedgerDatabase } from "./change-tracking/ledger-schema.js";
import {
  BACKUP_DIRECTORY,
  HOURLY_INTERVAL_MS,
  KEEP_LEDGER,
  KEEP_PRE_MIGRATION,
  LEDGER_INTERVAL_MS,
  enforceBackupBudget,
  listStorageSnapshots,
  purgeStorageSnapshots,
  releaseFreePagesInChildProcess,
  runDatabaseUpkeep,
  snapshotBeforeMigration,
  takeHourlySnapshotIfDue,
  takeLedgerSnapshotIfDue,
} from "./storage-backups.js";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";

const directories: string[] = [];
const open: StorageDatabase[] = [];
const T0 = Date.parse("2026-11-05T12:00:00.000Z");

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-ledger-backups-"));
  directories.push(directory);
  return directory;
}

function opened(database: StorageDatabase): StorageDatabase {
  open.push(database);
  return database;
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/** A fake snapshot of `bytes`, named as the rotation would name it. */
async function fakeSnapshot(directory: string, prefix: string, at: number, bytes = 10) {
  const backups = path.join(directory, BACKUP_DIRECTORY);
  await fs.mkdir(backups, { recursive: true });
  const file = path.join(backups, `${prefix}-${stamp(at)}.sqlite`);
  await fs.writeFile(file, Buffer.alloc(bytes));
  return file;
}

/** Leaves free pages in `database`: a dropped table of 200 KB. */
function wastePages(database: StorageDatabase): void {
  database.db.exec(
    "CREATE TABLE waste (value BLOB); INSERT INTO waste VALUES (zeroblob(200000)); DROP TABLE waste",
  );
}

function setMarker(ledger: StorageDatabase, value: string): void {
  ledger.db
    .query(
      "INSERT INTO change_ledger_meta (key, value) VALUES ('marker', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
    )
    .run(value);
}

/** Copies in-process, so a test needs no child process. */
async function copyInProcess(source: string, target: string): Promise<boolean> {
  const db = new Database(source, { readonly: true });
  try {
    db.query("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  return true;
}

afterEach(async () => {
  for (const database of open.splice(0).reverse()) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("the change-tracking ledger's snapshots (report 0760)", () => {
  test("a daily copy of change-tracking.sqlite, sound, private at each daily interval", async () => {
    const directory = await dataDir();
    const main = opened(openBackendDatabase(directory));
    const ledger = opened(openChangeLedgerDatabase(directory));
    setMarker(ledger, "FIRST-LEDGER-STATE");

    // The real child-process copy, as the scheduler runs it.
    const first = await takeLedgerSnapshotIfDue(main, directory, () => T0);
    expect(first).not.toBeNull();
    expect(path.basename(first!)).toBe(`change-tracking-daily-${stamp(T0)}.sqlite`);
    expect((await fs.stat(first!)).mode & 0o777).toBe(0o600);
    const copy = new Database(first!, { readonly: true });
    try {
      expect(copy.query("SELECT value FROM change_ledger_meta WHERE key = 'marker'").get()).toEqual(
        {
          value: "FIRST-LEDGER-STATE",
        },
      );
      expect(copy.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      copy.close();
    }
    expect(listStorageSnapshots(directory).map((entry) => entry.kind)).toEqual(["ledger"]);

    // Within the day: nothing. Each elapsed day creates a recovery point.
    const options = { copy: copyInProcess };
    setMarker(ledger, "SECOND-LEDGER-STATE");
    expect(
      await takeLedgerSnapshotIfDue(main, directory, () => T0 + HOURLY_INTERVAL_MS, options),
    ).toBeNull();
    const second = await takeLedgerSnapshotIfDue(
      main,
      directory,
      () => T0 + LEDGER_INTERVAL_MS,
      options,
    );
    expect(second).not.toBeNull();
    expect(
      await takeLedgerSnapshotIfDue(main, directory, () => T0 + 2 * LEDGER_INTERVAL_MS, options),
    ).not.toBeNull();
  });

  test("binding-only edits are captured by the next daily copy", async () => {
    const directory = await dataDir();
    const main = opened(openBackendDatabase(directory));
    const ledger = opened(openChangeLedgerDatabase(directory));
    const options = { copy: copyInProcess };
    await takeLedgerSnapshotIfDue(main, directory, () => T0, options);
    ledger.db.exec(
      "INSERT INTO change_bindings VALUES ('b', 'source', 'env', 'codex', 'thread', NULL, 'now')",
    );
    const file = await takeLedgerSnapshotIfDue(
      main,
      directory,
      () => T0 + LEDGER_INTERVAL_MS,
      options,
    );
    expect(file).not.toBeNull();
    const copy = new Database(file!, { readonly: true });
    try {
      expect(copy.query("SELECT id FROM change_bindings").all()).toEqual([{ id: "b" }]);
    } finally {
      copy.close();
    }
  });

  test("no ledger file, no ledger copy", async () => {
    const directory = await dataDir();
    const main = opened(openBackendDatabase(directory));
    expect(await takeLedgerSnapshotIfDue(main, directory, () => T0)).toBeNull();
    expect(listStorageSnapshots(directory)).toEqual([]);
  });

  test("hourly copies and the ledger copy are separate files with separate backoff", async () => {
    const directory = await dataDir();
    const main = opened(openBackendDatabase(directory));
    main.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Snapshot me" }]);
    const ledger = opened(openChangeLedgerDatabase(directory));
    setMarker(ledger, "LEDGER-MARKER");
    const failing = { copy: async () => false };
    expect(await takeLedgerSnapshotIfDue(main, directory, () => T0, failing)).toBeNull();
    expect(existsSync(path.join(directory, BACKUP_DIRECTORY, ".ledger-backoff.json"))).toBe(true);
    // The ledger's failure does not hold back the hourly copy, which has no ledger in it.
    const hourly = await takeHourlySnapshotIfDue(main, directory, () => T0, {
      copy: copyInProcess,
    });
    expect(hourly).not.toBeNull();
    expect((await fs.readFile(hourly!)).includes(Buffer.from("LEDGER-MARKER"))).toBe(false);
  });

  test("a ledger copy that does not fit beside the other snapshots is skipped, displacing none", async () => {
    const directory = await dataDir();
    const main = opened(openBackendDatabase(directory));
    const ledger = opened(openChangeLedgerDatabase(directory));
    setMarker(ledger, "x");
    const hourly = await fakeSnapshot(directory, "hourly", T0 - HOURLY_INTERVAL_MS, 4096);
    const maxBytes = 4096 + 1024;
    const result = await takeLedgerSnapshotIfDue(main, directory, () => T0, {
      copy: copyInProcess,
      maxBytes,
    });
    expect(result).toBeNull();
    expect(listStorageSnapshots(directory).map((entry) => entry.file)).toEqual([hourly]);
    expect(existsSync(path.join(directory, BACKUP_DIRECTORY, ".ledger-backoff.json"))).toBe(true);
  });

  test("ledger copies give way to the budget before hourly ones", async () => {
    const directory = await dataDir();
    const hourly = [
      await fakeSnapshot(directory, "hourly", T0, 100),
      await fakeSnapshot(directory, "hourly", T0 - HOURLY_INTERVAL_MS, 100),
    ];
    await fakeSnapshot(directory, "change-tracking-daily", T0 - 1_000, 100);
    const migration = await fakeSnapshot(directory, "pre-migration-v6", T0 - 2_000, 100);
    enforceBackupBudget(directory, 0, 300);
    expect(
      listStorageSnapshots(directory)
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([...hourly, migration].sort());
  });

  test("rotation keeps the newest ledger copies and each file's pre-migration copies", async () => {
    const directory = await dataDir();
    for (let day = 0; day < KEEP_LEDGER + 2; day += 1) {
      await fakeSnapshot(directory, "change-tracking-daily", T0 - (day * LEDGER_INTERVAL_MS) / 4);
    }
    for (let index = 0; index < KEEP_PRE_MIGRATION + 1; index += 1) {
      await fakeSnapshot(directory, "pre-migration-v6", T0 - index * 1_000);
      await fakeSnapshot(directory, "change-tracking-pre-migration-v2", T0 - index * 1_000);
    }
    purgeStorageSnapshots(directory, T0);
    const kinds = listStorageSnapshots(directory).map((entry) => entry.kind);
    expect(kinds.filter((kind) => kind === "ledger")).toHaveLength(KEEP_LEDGER);
    expect(kinds.filter((kind) => kind === "pre-migration")).toHaveLength(KEEP_PRE_MIGRATION);
    expect(kinds.filter((kind) => kind === "ledger-pre-migration")).toHaveLength(
      KEEP_PRE_MIGRATION,
    );
  });

  test("the ledger file's own migration takes its own pre-migration copy", async () => {
    const directory = await dataDir();
    const ledger = opened(openChangeLedgerDatabase(directory));
    snapshotBeforeMigration(ledger, directory, 2, T0, "change-tracking-pre-migration");
    const [entry] = listStorageSnapshots(directory);
    expect(entry?.kind).toBe("ledger-pre-migration");
    expect(path.basename(entry!.file)).toBe(`change-tracking-pre-migration-v2-${stamp(T0)}.sqlite`);
  });
});

describe("database upkeep (reports 0760 and 0910)", () => {
  test("upkeep returns free pages to the filesystem and refreshes statistics", async () => {
    const directory = await dataDir();
    const main = opened(openBackendDatabase(directory));
    main.writeStore(
      "kanban",
      Array.from({ length: 300 }, (_, index) => ({
        id: `t${index}`,
        projectId: "p1",
        title: "x".repeat(20_000),
      })),
    );
    main.deleteStore("kanban");
    const pragma = (name: string) =>
      (main.db.query(`PRAGMA ${name}`).get() as Record<string, number>)[name]!;
    const pages = pragma("page_count");
    expect(pragma("freelist_count")).toBeGreaterThan(0);
    await runDatabaseUpkeep(main);
    expect(pragma("freelist_count")).toBe(0);
    expect(pragma("page_count")).toBeLessThan(pages / 2);
  });

  test("upkeep releases in a child, never on the backend's connection (to-do 1202 task 7)", async () => {
    const main = opened(openBackendDatabase(await dataDir()));
    const inProcess = spyOn(main, "releaseFreePages");
    const files: string[] = [];
    const release = async (file: string) => {
      files.push(file);
      return { released: 0, left: 0 };
    };
    try {
      // Nothing free: no child is started.
      await releaseFreePagesInChildProcess(main.path);
      expect(main.releasableFreePages()).toBe(0);
      await runDatabaseUpkeep(main, { release });
      expect(files).toEqual([]);
      wastePages(main);
      await runDatabaseUpkeep(main, { release });
      expect(files).toEqual([main.path]);
      expect(inProcess).not.toHaveBeenCalled();
    } finally {
      inProcess.mockRestore();
    }
  });

  test("a failed release is logged without its message", async () => {
    const main = opened(openBackendDatabase(await dataDir()));
    wastePages(main);
    const logs = captureLogs();
    try {
      await runDatabaseUpkeep(main, {
        release: async () => {
          throw Object.assign(new Error("PRIVATE"), { code: "SQLITE_IOERR" });
        },
      });
      expect(logs.records().some((row) => row.event === "upkeep.vacuum-failed")).toBe(true);
      expect(logs.records().some((row) => row.event === "optimize.failed")).toBe(false);
      expect(JSON.stringify(logs.records())).not.toContain("PRIVATE");
    } finally {
      logs.restore();
    }
    await expect(
      releaseFreePagesInChildProcess(path.join(await dataDir(), "missing", "db.sqlite")),
    ).rejects.toThrow("Free-page release failed:");
  });

  test("the release child keeps to its budget in steps", async () => {
    const main = opened(openBackendDatabase(await dataDir()));
    wastePages(main);
    const before = main.releasableFreePages();
    expect(before).toBeGreaterThan(20);
    expect(
      await releaseFreePagesInChildProcess(main.path, { maxPages: 10, stepPages: 4, pauseMs: 0 }),
    ).toEqual({ released: 10, left: before - 10 });
    expect(main.releasableFreePages()).toBe(before - 10);
  });

  test("the release child gives way to a writer and leaves the backend's timeout alone", async () => {
    const main = opened(openBackendDatabase(await dataDir()));
    wastePages(main);
    const before = main.releasableFreePages();
    const writer = new Database(main.path);
    writer.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      expect(await releaseFreePagesInChildProcess(main.path)).toEqual({
        released: 0,
        left: before,
      });
      // The child's own one-second wait, then it stops; the backend never waits.
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(main.db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 10000 });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  test("upkeep on a closed database does nothing and never throws", async () => {
    const directory = await dataDir();
    const main = openBackendDatabase(directory);
    main.close();
    await expect(runDatabaseUpkeep(main)).resolves.toBeUndefined();
  });
});
