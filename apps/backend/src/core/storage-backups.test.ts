import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_DIRECTORY,
  HOURLY_INTERVAL_MS,
  KEEP_HOURLY,
  MAX_BACKUP_AGE_MS,
  listStorageSnapshots,
  purgeStorageSnapshots,
  retainedHourlySnapshots,
  takeHourlySnapshotIfDue,
  type StorageSnapshot,
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
  test("an hourly snapshot is a private, sound, restorable copy", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    database.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Snapshot me" }]);

    const file = await takeHourlySnapshotIfDue(database, directory);
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

  test("takes a snapshot at most hourly, and only when the content changed", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const take = () => takeHourlySnapshotIfDue(database, directory, () => now);
    expect(await take()).not.toBeNull();

    database.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Changed" }]);
    now += HOURLY_INTERVAL_MS / 2;
    expect(await take()).toBeNull();
    now += HOURLY_INTERVAL_MS / 2;
    expect(await take()).not.toBeNull();

    // Unchanged content, a write that changes nothing and a lease heartbeat
    // are not changes.
    now += HOURLY_INTERVAL_MS;
    expect(await take()).toBeNull();
    database.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Changed" }]);
    const release = await database.acquireLease("unrelated", "test", {
      acquireTimeoutMs: 1_000,
      staleMs: 60_000,
    });
    await release();
    now += HOURLY_INTERVAL_MS;
    expect(await take()).toBeNull();

    // Deleting a store is.
    database.deleteStore("kanban");
    expect(await take()).not.toBeNull();
    expect(listStorageSnapshots(directory)).toHaveLength(3);
  });

  test("keeps the newest six, one about a day old and one about three days old", () => {
    const start = Date.parse("2026-10-01T00:00:00.000Z");
    const day = 24 * HOURLY_INTERVAL_MS;
    let pool: StorageSnapshot[] = [];
    // A change every hour for two weeks; each check lands up to 5 minutes late.
    let now = start;
    for (let hour = 0; hour < 14 * 24; hour += 1) {
      now += HOURLY_INTERVAL_MS + (hour % 6) * 60_000;
      pool = [{ file: `hourly-${now}`, kind: "hourly" as const, takenAt: now }, ...pool];
      const kept = retainedHourlySnapshots(pool, now);
      pool = pool.filter((entry) => kept.has(entry));
      if (now - start < 4 * day) continue;
      const ages = pool.map((entry) => now - entry.takenAt);
      expect(pool.slice(0, KEEP_HOURLY).every((entry) => kept.has(entry))).toBe(true);
      expect(ages.some((age) => age >= day && age < 2 * day + 2 * HOURLY_INTERVAL_MS)).toBe(true);
      expect(ages.some((age) => age >= 3 * day && age < 4 * day + 2 * HOURLY_INTERVAL_MS)).toBe(
        true,
      );
      expect(pool.length).toBeLessThanOrEqual(KEEP_HOURLY + 4);
    }
  });

  test("ages snapshots out, then replaces them even when nothing changed", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    expect(await takeHourlySnapshotIfDue(database, directory, () => now)).not.toBeNull();

    purgeStorageSnapshots(directory, now + MAX_BACKUP_AGE_MS + 1);
    expect(listStorageSnapshots(directory)).toEqual([]);

    expect(await takeHourlySnapshotIfDue(database, directory, () => now)).not.toBeNull();
    now += MAX_BACKUP_AGE_MS + 1;
    const fresh = await takeHourlySnapshotIfDue(database, directory, () => now);
    expect(fresh).not.toBeNull();
    expect(listStorageSnapshots(directory).map((entry) => entry.file)).toEqual([fresh!]);
  });

  test("an unreadable newest snapshot is replaced", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const first = await takeHourlySnapshotIfDue(database, directory, () => now);
    await fs.writeFile(first!, "not a database");
    now += HOURLY_INTERVAL_MS;
    expect(await takeHourlySnapshotIfDue(database, directory, () => now)).not.toBeNull();
  });

  test("a failed snapshot never breaks the backend and leaves no partial file", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    const backup = spyOn(database, "backupTo").mockImplementation(() => {
      throw new Error("disk full");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await takeHourlySnapshotIfDue(database, directory)).toBeNull();
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
