import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_DIRECTORY,
  DAILY_INTERVAL_MS,
  KEEP_DAILY,
  MAX_BACKUP_AGE_MS,
  listStorageSnapshots,
  purgeStorageSnapshots,
  takeDailySnapshotIfDue,
} from "./storage-backups.js";
import { STORAGE_DATABASE_FILE, StorageDatabase } from "./storage-database.js";
import { openBackendDatabase, storeLayout } from "./storage-stores.js";

const directories: string[] = [];
const open: StorageDatabase[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-backups-"));
  directories.push(directory);
  return directory;
}

function backend(directory: string): StorageDatabase {
  const database = openBackendDatabase(directory);
  open.push(database);
  return database;
}

afterEach(async () => {
  for (const database of open.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("database snapshots", () => {
  test("a daily snapshot is a private, sound, restorable copy", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    database.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Snapshot me" }]);

    const file = await takeDailySnapshotIfDue(database, directory);
    expect(file).not.toBeNull();
    expect((await fs.stat(file!)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(directory, BACKUP_DIRECTORY))).mode & 0o777).toBe(0o700);

    // Restore: the snapshot opens as a complete database.
    const restored = await dataDir();
    await fs.copyFile(file!, path.join(restored, STORAGE_DATABASE_FILE));
    const reopened = backend(restored);
    expect(reopened.readStore("kanban")?.value).toEqual([
      { id: "t1", projectId: "p1", title: "Snapshot me" },
    ]);
  });

  test("takes at most one daily snapshot per interval, then rotates and ages them out", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    expect(await takeDailySnapshotIfDue(database, directory, () => now)).not.toBeNull();
    now += DAILY_INTERVAL_MS / 2;
    expect(await takeDailySnapshotIfDue(database, directory, () => now)).toBeNull();
    for (let day = 0; day < KEEP_DAILY + 2; day += 1) {
      now += DAILY_INTERVAL_MS;
      await takeDailySnapshotIfDue(database, directory, () => now);
    }
    const daily = listStorageSnapshots(directory).filter((entry) => entry.kind === "daily");
    expect(daily).toHaveLength(KEEP_DAILY);
    expect(daily[0]!.takenAt).toBe(now);

    purgeStorageSnapshots(directory, now + MAX_BACKUP_AGE_MS + 1);
    expect(listStorageSnapshots(directory)).toEqual([]);
  });

  test("a failed snapshot never breaks the backend and leaves no partial file", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    const backup = spyOn(database, "backupTo").mockImplementation(() => {
      throw new Error("disk full");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await takeDailySnapshotIfDue(database, directory)).toBeNull();
    } finally {
      backup.mockRestore();
      warn.mockRestore();
    }
    expect(await fs.readdir(path.join(directory, BACKUP_DIRECTORY))).toEqual([]);
  });

  test("snapshots an existing database before migrating it to a newer schema", async () => {
    const directory = await dataDir();
    // A database an older build left at schema version 1, holding data.
    const older = new StorageDatabase(directory, { layoutFor: storeLayout });
    older.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Before" }]);
    older.close();

    const upgraded = backend(directory);
    expect(upgraded.schemaVersion()).toBeGreaterThan(1);
    const [snapshot] = listStorageSnapshots(directory);
    expect(snapshot).toMatchObject({ kind: "pre-migration" });
    expect(path.basename(snapshot!.file)).toStartWith("pre-migration-v1-");
    // The snapshot still has the old schema version and the data.
    const restored = await dataDir();
    await fs.copyFile(snapshot!.file, path.join(restored, STORAGE_DATABASE_FILE));
    const atOldVersion = new StorageDatabase(restored, { layoutFor: storeLayout });
    open.push(atOldVersion);
    expect(atOldVersion.schemaVersion()).toBe(1);
    expect(atOldVersion.readStore("kanban")?.value).toEqual([
      { id: "t1", projectId: "p1", title: "Before" },
    ]);
  });

  test("a fresh database takes no pre-migration snapshot", async () => {
    const directory = await dataDir();
    backend(directory);
    expect(listStorageSnapshots(directory)).toEqual([]);
  });
});
