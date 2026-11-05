import { afterEach, describe, expect, test } from "bun:test";
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
  test("a daily copy of change-tracking.sqlite, sound, private and only when the ledger changed", async () => {
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

    // Within the day: nothing. A day on but unchanged: nothing.
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
    ).toBeNull();
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

  test("upkeep on a closed database does nothing and never throws", async () => {
    const directory = await dataDir();
    const main = openBackendDatabase(directory);
    main.close();
    await expect(runDatabaseUpkeep(main)).resolves.toBeUndefined();
  });
});
