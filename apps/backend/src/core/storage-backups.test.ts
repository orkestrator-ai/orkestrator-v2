import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_DIRECTORY,
  BACKUP_FAILURE_BACKOFF_MS,
  HOURLY_INTERVAL_MS,
  KEEP_HOURLY,
  MAX_BACKUP_AGE_MS,
  MAX_BACKUP_FAILURE_BACKOFF_MS,
  MIN_FREE_BYTES_AFTER_BACKUP,
  STALE_TEMPORARY_MS,
  copyDatabaseInChildProcess,
  enforceBackupBudget,
  failureBackoffMs,
  listStorageSnapshots,
  purgeStorageSnapshots,
  removeStaleBackupTemporaries,
  requiredFreeBytes,
  retainedHourlySnapshots,
  takeHourlySnapshotIfDue,
  type StorageSnapshot,
} from "./storage-backups.js";
import { STORAGE_DATABASE_FILE, StorageDatabase } from "./storage-database.js";
import { openBackendDatabase, storeLayout } from "./storage-stores.js";

const BACKOFF_FILE = ".hourly-backoff.json";
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
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await takeHourlySnapshotIfDue(database, directory, Date.now, {
        copy: async (_source, target) => {
          await fs.writeFile(target, "partial");
          await fs.writeFile(`${target}-journal`, "journal");
          throw new Error("disk full");
        },
      });
      expect(result).toBeNull();
    } finally {
      warn.mockRestore();
    }
    const left = await fs.readdir(path.join(directory, BACKUP_DIRECTORY));
    expect(left.filter((entry) => entry !== BACKOFF_FILE)).toEqual([]);
  });

  test("copies in a child process, so the event loop keeps running", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    database.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Off thread" }]);
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 1);
    try {
      const target = path.join(directory, "copy.sqlite");
      expect(await copyDatabaseInChildProcess(database.path, target)).toBe(true);
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
    await expect(
      copyDatabaseInChildProcess(path.join(directory, "missing", "db.sqlite"), "/nonexistent/x"),
    ).rejects.toThrow("Database copy failed");
  });

  test("skips a copy the disk cannot hold, and backs off after failures", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    let free = 0;
    let copies = 0;
    const options = {
      availableBytes: () => free,
      copy: async (source: string, target: string) => {
        copies += 1;
        return copyDatabaseInChildProcess(source, target);
      },
    };
    const take = () => takeHourlySnapshotIfDue(database, directory, () => now, options);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await take()).toBeNull();
      expect(copies).toBe(0);
      expect(warn.mock.calls[0]?.[0]).toContain("Skipped the hourly database snapshot");

      // Space freed, but the next attempt waits out the backoff.
      free = Number.MAX_SAFE_INTEGER;
      now += BACKUP_CHECK_INTERVAL_MS;
      expect(await take()).toBeNull();
      now += failureBackoffMs(1);
      expect(await take()).not.toBeNull();
      expect(copies).toBe(1);
    } finally {
      warn.mockRestore();
    }
    // Success clears the backoff.
    expect(await fs.readdir(path.join(directory, BACKUP_DIRECTORY))).not.toContain(BACKOFF_FILE);
  });

  test.each(["recent", "unchanged", "backoff"])(
    "enforces the existing budget on %s checks",
    async (reason) => {
      const directory = await dataDir();
      const database = backend(directory);
      const at = Date.parse("2026-10-27T12:00:00.000Z");
      const newest = (await takeHourlySnapshotIfDue(database, directory, () => at))!;
      const older = newest.replace("12-00-00", "11-00-00");
      await fs.copyFile(newest, older);
      const bytes = (await fs.stat(newest)).size;
      if (reason === "backoff") {
        database.writeStore("kanban", [{ id: "changed" }]);
        await fs.writeFile(
          path.join(directory, BACKUP_DIRECTORY, BACKOFF_FILE),
          JSON.stringify({ failures: 1, retryAt: at + 10 * HOURLY_INTERVAL_MS }),
        );
      }
      let copies = 0;
      expect(
        await takeHourlySnapshotIfDue(
          database,
          directory,
          () => at + (reason === "recent" ? 1 : HOURLY_INTERVAL_MS),
          {
            maxBytes: bytes,
            copy: async () => {
              copies++;
              return true;
            },
          },
        ),
      ).toBeNull();
      expect(copies).toBe(0);
      expect(listStorageSnapshots(directory).map((entry) => entry.file)).toEqual([newest]);
    },
  );

  test("does not evict recovery history for an incoming copy that is skipped or fails", async () => {
    const directory = await dataDir();
    const database = backend(directory);
    const at = Date.parse("2026-10-27T12:00:00.000Z");
    const newest = (await takeHourlySnapshotIfDue(database, directory, () => at))!;
    const older = newest.replace("12-00-00", "11-00-00");
    await fs.copyFile(newest, older);
    database.writeStore("kanban", [{ id: "changed" }]);
    const files = listStorageSnapshots(directory);
    const budget = 2 * (await fs.stat(newest)).size;
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        await takeHourlySnapshotIfDue(database, directory, () => at + HOURLY_INTERVAL_MS, {
          maxBytes: budget,
          availableBytes: () => 0,
          copy: async () => {
            throw new Error("copy must not start");
          },
        }),
      ).toBeNull();
      expect(listStorageSnapshots(directory)).toEqual(files);
      const retry = at + 2 * HOURLY_INTERVAL_MS;
      expect(
        await takeHourlySnapshotIfDue(database, directory, () => retry, {
          maxBytes: budget,
          availableBytes: () => Number.MAX_SAFE_INTEGER,
          copy: async (_source, target) => {
            await fs.writeFile(target, "unsound");
            await fs.writeFile(`${target}-wal`, "partial");
            return false;
          },
        }),
      ).toBeNull();
      expect(listStorageSnapshots(directory)).toEqual(files);
      expect(
        (await fs.readdir(path.join(directory, BACKUP_DIRECTORY))).some((entry) =>
          entry.includes(".tmp"),
        ),
      ).toBe(false);
      const backoff = JSON.parse(
        await fs.readFile(path.join(directory, BACKUP_DIRECTORY, BACKOFF_FILE), "utf8"),
      );
      expect(backoff.failures).toBe(2);
      expect(backoff.retryAt).toBe(retry + failureBackoffMs(2));
      expect(
        await takeHourlySnapshotIfDue(database, directory, () => retry + HOURLY_INTERVAL_MS, {
          maxBytes: budget,
          availableBytes: () => Number.MAX_SAFE_INTEGER,
        }),
      ).not.toBeNull();
      expect(listStorageSnapshots(directory).length).toBeLessThan(files.length + 1);
    } finally {
      warn.mockRestore();
    }
  });

  test("backs up a hollow legacy database using live pages for headroom", async () => {
    const directory = await dataDir();
    const legacy = new Database(path.join(directory, STORAGE_DATABASE_FILE), { create: true });
    legacy.exec(
      "CREATE TABLE old_data (body BLOB); INSERT INTO old_data VALUES (zeroblob(8388608)); DELETE FROM old_data;",
    );
    legacy.close();
    const database = backend(directory);
    expect(database.db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
    const allocated = (await fs.stat(database.path)).size;
    const live = database.livePageBytes();
    expect(live).toBeLessThan(allocated / 2);
    expect(database.releaseFreePages()).toBe(0);
    const file = await takeHourlySnapshotIfDue(database, directory, Date.now, {
      availableBytes: () => requiredFreeBytes(live) + 1024 * 1024,
    });
    expect(file).not.toBeNull();
    expect((await fs.stat(file!)).size).toBeLessThan(allocated / 2);
  });

  test("the supervisor kills a blocked SQLite worker at its independent deadline", async () => {
    const directory = await dataDir();
    const source = path.join(directory, "locked.sqlite");
    const locked = new Database(source, { create: true });
    locked.exec("CREATE TABLE t (v); BEGIN EXCLUSIVE");
    try {
      await expect(
        copyDatabaseInChildProcess(source, path.join(directory, "copy.sqlite"), { timeoutMs: 200 }),
      ).rejects.toThrow("Database copy failed");
    } finally {
      locked.exec("ROLLBACK");
      locked.close();
    }
  });

  test("abrupt backend death terminates the supervisor and its blocked copy before restart cleanup", async () => {
    const directory = await dataDir();
    const source = path.join(directory, "locked.sqlite");
    const locked = new Database(source, { create: true });
    locked.exec("CREATE TABLE t (v); BEGIN EXCLUSIVE");
    const target = path.join(directory, BACKUP_DIRECTORY, ".hourly-2026-10-27T12-00-00-000Z.");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const moduleUrl = new URL("./storage-backups.ts", import.meta.url).href;
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `import { copyDatabaseInChildProcess } from ${JSON.stringify(moduleUrl)};
      await copyDatabaseInChildProcess(${JSON.stringify(source)}, ${JSON.stringify(target)} + process.pid + ".tmp");`,
      ],
      { stdio: "ignore" },
    );
    let descendants: number[] = [];
    const children = (pid: number) =>
      execFileSync("ps", ["-axo", "pid=,ppid=,stat="])
        .toString()
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => Number(parts[1]) === pid && !parts[2]?.startsWith("Z"))
        .map((parts) => Number(parts[0]));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const supervisors = children(parent.pid!);
        descendants = [...supervisors, ...supervisors.flatMap(children)];
        if (descendants.length === 2) break;
        await Bun.sleep(20);
      }
      expect(descendants).toHaveLength(2);
      parent.kill("SIGKILL");
      for (let attempt = 0; attempt < 100 && descendants.some(alive); attempt++)
        await Bun.sleep(20);
      expect(descendants.some(alive)).toBe(false);
      removeStaleBackupTemporaries(directory);
      expect(await fs.readdir(path.dirname(target))).toEqual([]);
    } finally {
      parent.kill("SIGKILL");
      for (const pid of descendants) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      locked.exec("ROLLBACK");
      locked.close();
    }
  });

  test("the backoff doubles per consecutive failure, up to a ceiling", () => {
    expect(failureBackoffMs(1)).toBe(BACKUP_FAILURE_BACKOFF_MS);
    expect(failureBackoffMs(2)).toBe(2 * BACKUP_FAILURE_BACKOFF_MS);
    expect(failureBackoffMs(3)).toBe(4 * BACKUP_FAILURE_BACKOFF_MS);
    expect(failureBackoffMs(100)).toBe(MAX_BACKUP_FAILURE_BACKOFF_MS);
  });

  test("needs room for the copy and as much again, at least the minimum", () => {
    expect(requiredFreeBytes(1024)).toBe(1024 + MIN_FREE_BYTES_AFTER_BACKUP);
    const large = 30 * MIN_FREE_BYTES_AFTER_BACKUP;
    expect(requiredFreeBytes(large)).toBe(2 * large);
  });

  test("removes temporary copies of dead processes and its own, keeps a live one", async () => {
    const directory = await dataDir();
    const backups = path.join(directory, BACKUP_DIRECTORY);
    await fs.mkdir(backups, { recursive: true });
    // A pid that cannot be running: above every platform's pid limit.
    const dead = 2 ** 30;
    const live = process.ppid;
    const stamp = "2026-10-27T22-52-07-362Z";
    const files = {
      dead: `.hourly-${stamp}.${dead}.tmp`,
      deadJournal: `.hourly-${stamp}.${dead}.tmp-journal`,
      own: `.hourly-${stamp}.${process.pid}.tmp`,
      live: `.hourly-${stamp}.${live}.tmp`,
      liveJournal: `.pre-migration-v3-${stamp}.${live}.tmp-journal`,
      unrelated: "notes.txt",
    };
    for (const name of Object.values(files)) await fs.writeFile(path.join(backups, name), "x");

    const now = Date.now();
    expect(removeStaleBackupTemporaries(directory, now)).toBe(3);
    expect((await fs.readdir(backups)).sort()).toEqual(
      [files.live, files.liveJournal, files.unrelated].sort(),
    );

    // A live pid's copy left untouched for long is abandoned (the pid was reused).
    expect(removeStaleBackupTemporaries(directory, now + STALE_TEMPORARY_MS + 60_000)).toBe(2);
    expect(await fs.readdir(backups)).toEqual([files.unrelated]);
  });

  test("keeps all snapshots under the size cap, oldest hourly first, newest always", async () => {
    const directory = await dataDir();
    const backups = path.join(directory, BACKUP_DIRECTORY);
    await fs.mkdir(backups, { recursive: true });
    const write = async (name: string, bytes: number) => {
      await fs.writeFile(path.join(backups, name), Buffer.alloc(bytes));
      return name;
    };
    await write("hourly-2026-10-27T08-00-00-000Z.sqlite", 400);
    const middle = await write("hourly-2026-10-27T09-00-00-000Z.sqlite", 300);
    const newest = await write("hourly-2026-10-27T10-00-00-000Z.sqlite", 300);
    const migration = await write("pre-migration-v3-2026-10-21T12-04-55-370Z.sqlite", 100);

    enforceBackupBudget(directory, 0, 1_000);
    expect((await fs.readdir(backups)).sort()).toEqual([middle, newest, migration].sort());

    // Room for an incoming copy: the older hourly ones give way.
    enforceBackupBudget(directory, 500, 1_000);
    expect((await fs.readdir(backups)).sort()).toEqual([newest, migration].sort());

    // The newest hourly one stays even when it alone exceeds the cap.
    enforceBackupBudget(directory, 5_000, 1_000);
    expect((await fs.readdir(backups)).sort()).toEqual([newest, migration].sort());
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
