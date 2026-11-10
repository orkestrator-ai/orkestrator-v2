import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSummaryCache } from "./database-summary.js";
import { BACKUP_DIRECTORY } from "./storage-backups.js";
import { CHANGE_LEDGER_DATABASE_FILE, type StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";

const directories: string[] = [];
const open: StorageDatabase[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-database-summary-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const database of open.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("DatabaseSummaryCache", () => {
  test("reports both databases, backups, retention and top tables", async () => {
    const directory = await dataDir();
    const main = openBackendDatabase(directory);
    open.push(main);
    main.writeStore("kanban", [{ id: "t1", projectId: "p1" }]);
    await fs.writeFile(path.join(directory, CHANGE_LEDGER_DATABASE_FILE), "ledger-bytes");
    await fs.mkdir(path.join(directory, BACKUP_DIRECTORY), { recursive: true });
    await fs.writeFile(
      path.join(directory, BACKUP_DIRECTORY, "hourly-2026-11-05T10-00-00-000Z.sqlite"),
      "1234",
    );
    await fs.writeFile(
      path.join(
        directory,
        BACKUP_DIRECTORY,
        "change-tracking-daily-2026-11-04T10-00-00-000Z.sqlite",
      ),
      "12",
    );
    await fs.writeFile(
      path.join(directory, BACKUP_DIRECTORY, ".top-tables.json"),
      JSON.stringify({
        main: {
          takenAt: "2026-11-05T10:00:00.000Z",
          tables: [{ name: "store_rows", bytes: 8192 }],
        },
      }),
    );
    const retention = {
      at: "2026-11-05T10:00:00.000Z",
      outcome: "failed" as const,
      failedPasses: 1,
      report: null,
    };
    const summary = new DatabaseSummaryCache({
      dataDir: directory,
      main: () => main,
      ledger: () => null,
      retention: () => retention,
    }).read();

    expect(summary.main?.fileBytes).toBeGreaterThan(0);
    expect(summary.main?.pageBytes).toBeGreaterThan(0);
    expect(summary.main?.pageCount).toBeGreaterThan(0);
    expect(summary.main?.freelistPages).toBeGreaterThanOrEqual(0);
    // No connection: sizes still answer, page figures say they are unknown.
    expect(summary.ledger).toEqual({
      fileBytes: 12,
      walBytes: 0,
      pageBytes: null,
      pageCount: null,
      freelistPages: null,
      freelistBytes: null,
    });
    expect(summary.backups.count).toBe(2);
    expect(summary.backups.bytes).toBe(6);
    expect(summary.backups.kinds.hourly).toEqual({ count: 1, bytes: 4 });
    expect(summary.backups.kinds.ledger).toEqual({ count: 1, bytes: 2 });
    expect(summary.backups.newestAt).toBe("2026-11-05T10:00:00.000Z");
    expect(summary.retention).toEqual(retention);
    expect(summary.topTables.main?.tables).toEqual([{ name: "store_rows", bytes: 8192 }]);
    // An older backend's file has no store families, and none are made up.
    expect(summary.topTables.main).not.toHaveProperty("stores");
    expect(summary.topTables.ledger).toBeNull();
  });

  test("store families the backup child left are read beside the tables", async () => {
    const directory = await dataDir();
    await fs.mkdir(path.join(directory, BACKUP_DIRECTORY), { recursive: true });
    const stores = [
      { family: "change-tracking", bytes: 9_000, rows: 30 },
      { family: "web-annotations", bytes: 400, rows: 2 },
    ];
    await fs.writeFile(
      path.join(directory, BACKUP_DIRECTORY, ".top-tables.json"),
      JSON.stringify({
        main: {
          takenAt: "2026-11-05T10:00:00.000Z",
          tables: [{ name: "store_rows", bytes: 8192 }],
          stores,
        },
      }),
    );
    const summary = new DatabaseSummaryCache({
      dataDir: directory,
      main: () => null,
      ledger: () => null,
      retention: () => null,
    }).read();
    expect(summary.topTables.main).toEqual({
      takenAt: "2026-11-05T10:00:00.000Z",
      tables: [{ name: "store_rows", bytes: 8192 }],
      stores,
    });
  });

  test("a ledger that does not exist yet is null and is never opened", async () => {
    const directory = await dataDir();
    let opened = 0;
    const summary = new DatabaseSummaryCache({
      dataDir: directory,
      main: () => null,
      ledger: () => {
        opened += 1;
        return null;
      },
      retention: () => null,
    }).read();
    expect(summary.main).toBeNull();
    expect(summary.ledger).toBeNull();
    expect(opened).toBe(0);
    expect(summary.backups).toMatchObject({ count: 0, bytes: 0, newestAt: null });
    expect(summary.topTables).toEqual({ main: null, ledger: null });
  });

  test("refreshes at most once a minute however often it is read", async () => {
    const directory = await dataDir();
    await fs.writeFile(path.join(directory, CHANGE_LEDGER_DATABASE_FILE), "x");
    let now = 1_000_000;
    let reads = 0;
    const cache = new DatabaseSummaryCache({
      dataDir: directory,
      main: () => null,
      ledger: () => {
        reads += 1;
        return null;
      },
      retention: () => null,
      now: () => now,
    });
    const first = cache.read();
    now += 59_000;
    expect(cache.read()).toBe(first);
    expect(reads).toBe(1);
    now += 2_000;
    expect(cache.read()).not.toBe(first);
    expect(reads).toBe(2);
    // A clock stepping backwards does not pin the old figures.
    now -= 500_000;
    cache.read();
    expect(reads).toBe(3);
  });

  test("a connection that fails leaves the file sizes", async () => {
    const directory = await dataDir();
    await fs.writeFile(path.join(directory, CHANGE_LEDGER_DATABASE_FILE), "x");
    const summary = new DatabaseSummaryCache({
      dataDir: directory,
      main: () => null,
      ledger: () => {
        throw new Error("busy");
      },
      retention: () => null,
    }).read();
    expect(summary.ledger).toMatchObject({ fileBytes: 1, pageCount: null });
  });
});
