import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { StorageDatabase } from "./storage-database.js";

/**
 * Snapshots of the backend database.
 *
 * WAL with full sync already survives crashes and torn writes, so these exist
 * for what it cannot undo: a bad migration, a bug that deletes or corrupts
 * data, damage to the file itself. Two kinds, both under `<dataDir>/backups/`
 * (0700, files 0600):
 *
 * - `pre-migration-v<from>-<stamp>.sqlite`, taken before an existing database
 *   is migrated to a newer schema. The newest {@link KEEP_PRE_MIGRATION} stay.
 * - `daily-<stamp>.sqlite`, taken at most once per {@link DAILY_INTERVAL_MS}
 *   (checked at start-up and every few hours). The newest {@link KEEP_DAILY}
 *   stay.
 *
 * Every snapshot older than {@link MAX_BACKUP_AGE_MS} is deleted regardless.
 * That bound is also the privacy cost: content deleted from the live database
 * can survive in a snapshot until it ages out.
 *
 * Restore: stop the app, replace `orkestrator.sqlite` with a snapshot and
 * delete `orkestrator.sqlite-wal` and `-shm`.
 */

export const BACKUP_DIRECTORY = "backups";
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BACKUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const KEEP_DAILY = 3;
export const KEEP_PRE_MIGRATION = 2;
export const MAX_BACKUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SNAPSHOT =
  /^(daily|pre-migration-v\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.sqlite$/;

function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

function timeOfStamp(stamp: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : NaN;
}

function backupDirectory(dataDir: string): string {
  const directory = path.join(dataDir, BACKUP_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

export interface StorageSnapshot {
  file: string;
  kind: "daily" | "pre-migration";
  takenAt: number;
}

export function listStorageSnapshots(dataDir: string): StorageSnapshot[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(dataDir, BACKUP_DIRECTORY));
  } catch {
    return [];
  }
  const snapshots: StorageSnapshot[] = [];
  for (const entry of entries) {
    const match = SNAPSHOT.exec(entry);
    if (!match) continue;
    const takenAt = timeOfStamp(match[2]!);
    if (!Number.isFinite(takenAt)) continue;
    snapshots.push({
      file: path.join(dataDir, BACKUP_DIRECTORY, entry),
      kind: match[1] === "daily" ? "daily" : "pre-migration",
      takenAt,
    });
  }
  return snapshots.sort((a, b) => b.takenAt - a.takenAt);
}

/**
 * Takes one snapshot: copy to a temporary name, verify it with `quick_check`,
 * then rename into place, so a listed snapshot is always complete and sound.
 * Returns `null` (and removes the copy) when verification fails.
 */
function snapshot(database: StorageDatabase, dataDir: string, name: string): string | null {
  const directory = backupDirectory(dataDir);
  const target = path.join(directory, `${name}.sqlite`);
  const temporary = path.join(directory, `.${name}.${process.pid}.tmp`);
  fs.rmSync(temporary, { force: true });
  try {
    database.backupTo(temporary);
    fs.chmodSync(temporary, 0o600);
    const copy = new Database(temporary, { readonly: true });
    let sound = false;
    try {
      const result = copy.query("PRAGMA quick_check").all() as Array<Record<string, string>>;
      sound = result.length === 1 && Object.values(result[0]!)[0] === "ok";
    } finally {
      copy.close();
    }
    if (!sound) {
      console.warn("[Storage] A database snapshot failed its integrity check and was discarded");
      return null;
    }
    fs.renameSync(temporary, target);
    return target;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Deletes snapshots beyond the per-kind counts and every one past the age bound. */
export function purgeStorageSnapshots(dataDir: string, now = Date.now()): void {
  const kept = { daily: 0, "pre-migration": 0 };
  for (const entry of listStorageSnapshots(dataDir)) {
    const limit = entry.kind === "daily" ? KEEP_DAILY : KEEP_PRE_MIGRATION;
    const expired = now - entry.takenAt > MAX_BACKUP_AGE_MS;
    if (expired || kept[entry.kind] >= limit) {
      fs.rmSync(entry.file, { force: true });
      continue;
    }
    kept[entry.kind] += 1;
  }
}

/** The `beforeMigrate` hook: snapshot the database as the older schema left it. */
export function snapshotBeforeMigration(
  database: StorageDatabase,
  dataDir: string,
  from: number,
  now = Date.now(),
): void {
  // A migration must not run without its safety copy: a failure here aborts
  // the open rather than migrating unprotected.
  const file = snapshot(database, dataDir, `pre-migration-v${from}-${stampOf(now)}`);
  if (!file) throw new Error("Could not take a sound database snapshot before migrating");
  purgeStorageSnapshots(dataDir, now);
}

/**
 * Takes the daily snapshot if the newest one is at least a day old, then
 * purges. Serialized across backends sharing the directory by a lease, and
 * never throws: a missed backup must not take the backend down.
 */
export async function takeDailySnapshotIfDue(
  database: StorageDatabase,
  dataDir: string,
  now: () => number = Date.now,
): Promise<string | null> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await database.acquireLease("storage-backup", "database backup", {
      acquireTimeoutMs: 5_000,
      staleMs: 120_000,
    });
    const newest = listStorageSnapshots(dataDir).find((entry) => entry.kind === "daily");
    const at = now();
    const file =
      newest && at - newest.takenAt < DAILY_INTERVAL_MS
        ? null
        : snapshot(database, dataDir, `daily-${stampOf(at)}`);
    purgeStorageSnapshots(dataDir, at);
    return file;
  } catch (error) {
    console.warn(
      "[Storage] Daily database snapshot failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  } finally {
    await release?.().catch(() => undefined);
  }
}
