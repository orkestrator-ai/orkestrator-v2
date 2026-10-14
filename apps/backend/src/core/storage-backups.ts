import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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
 * - `hourly-<stamp>.sqlite`, taken when the newest one is at least
 *   {@link HOURLY_INTERVAL_MS} old and the database content changed since it
 *   (checked a minute after start-up and every {@link BACKUP_CHECK_INTERVAL_MS}).
 *   The newest {@link KEEP_HOURLY} stay, and so does one a day as it ages
 *   ({@link retainedHourlySnapshots}), so there is always a copy about a day
 *   old and one about {@link OLDEST_DAILY_AGE_MS} old.
 *
 * Every snapshot older than {@link MAX_BACKUP_AGE_MS} is deleted regardless.
 * That bound is also the privacy cost: content deleted from the live database
 * can survive in a snapshot until it ages out.
 *
 * Restore: stop the app, replace `orkestrator.sqlite` with a snapshot and
 * delete `orkestrator.sqlite-wal` and `-shm`.
 */

export const BACKUP_DIRECTORY = "backups";
const DAY_MS = 24 * 60 * 60 * 1000;
export const HOURLY_INTERVAL_MS = 60 * 60 * 1000;
/** Short against the interval, so a snapshot is at most this late. */
export const BACKUP_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const KEEP_HOURLY = 6;
/** Spacing of the hourly snapshots kept as they age. */
export const DAILY_SPACING_MS = DAY_MS;
/** The oldest daily copy kept: the youngest at least this old. */
export const OLDEST_DAILY_AGE_MS = 3 * DAY_MS;
export const KEEP_PRE_MIGRATION = 2;
export const MAX_BACKUP_AGE_MS = 7 * DAY_MS;

const SNAPSHOT =
  /^(hourly|pre-migration-v\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.sqlite$/;

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
  kind: "hourly" | "pre-migration";
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
      kind: match[1] === "hourly" ? "hourly" : "pre-migration",
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

/**
 * The hourly snapshots to keep, from `snapshots` newest first: the newest
 * {@link KEEP_HOURLY}, plus daily ones. Walking from the oldest, each
 * snapshot taken {@link DAILY_SPACING_MS} or more after the previous daily
 * one is daily, so the dailies stay put as newer snapshots come and go. The
 * dailies are kept from the youngest at least {@link OLDEST_DAILY_AGE_MS} old
 * onwards: that one is the "3 days ago" copy, the youngest at least a day old
 * is the "1 day ago" copy, and the ones between are what age into them.
 */
export function retainedHourlySnapshots(
  snapshots: readonly StorageSnapshot[],
  now: number,
): Set<StorageSnapshot> {
  const kept = new Set(snapshots.slice(0, KEEP_HOURLY));
  const dailies: StorageSnapshot[] = [];
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const entry = snapshots[index]!;
    const previous = dailies.at(-1);
    if (!previous || entry.takenAt - previous.takenAt >= DAILY_SPACING_MS) dailies.push(entry);
  }
  let oldest = 0;
  for (let index = dailies.length - 1; index >= 0; index -= 1) {
    if (now - dailies[index]!.takenAt >= OLDEST_DAILY_AGE_MS) {
      oldest = index;
      break;
    }
  }
  for (const entry of dailies.slice(oldest)) kept.add(entry);
  return kept;
}

/** Deletes snapshots the rotation no longer keeps and every one past the age bound. */
export function purgeStorageSnapshots(dataDir: string, now = Date.now()): void {
  const snapshots = listStorageSnapshots(dataDir);
  const kept = retainedHourlySnapshots(
    snapshots.filter((entry) => entry.kind === "hourly"),
    now,
  );
  for (const entry of snapshots
    .filter((entry) => entry.kind === "pre-migration")
    .slice(0, KEEP_PRE_MIGRATION)) {
    kept.add(entry);
  }
  for (const entry of snapshots) {
    if (!kept.has(entry) || now - entry.takenAt > MAX_BACKUP_AGE_MS) {
      fs.rmSync(entry.file, { force: true });
    }
  }
}

/**
 * Identifies a database's content: every store's revision (each committed
 * change to a store bumps it), the deletion bookkeeping in `storage_meta` and
 * the schema version. Leases are coordination, not content, so a heartbeat
 * does not count as a change. A snapshot keeps all three, so its fingerprint
 * is the live database's at the moment it was taken.
 */
function contentFingerprint(db: Database): string {
  const hash = createHash("sha256");
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  hash.update(`schema\0${user_version}`);
  const stores = db.query("SELECT name, revision FROM stores ORDER BY name").all() as Array<{
    name: string;
    revision: number;
  }>;
  for (const { name, revision } of stores) hash.update(`\0store\0${name}\0${revision}`);
  const meta = db.query("SELECT key, value FROM storage_meta ORDER BY key").all() as Array<{
    key: string;
    value: string;
  }>;
  for (const { key, value } of meta) hash.update(`\0meta\0${key}\0${value}`);
  return hash.digest("hex");
}

/** The snapshot's content fingerprint, or `null` when it cannot be read. */
function snapshotFingerprint(file: string): string | null {
  try {
    const copy = new Database(file, { readonly: true });
    try {
      return contentFingerprint(copy);
    } finally {
      copy.close();
    }
  } catch {
    return null;
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
 * Takes an hourly snapshot if the newest is at least an hour old and the
 * database changed since it, then purges. Serialized across backends sharing
 * the directory by a lease, and never throws: a missed backup must not take
 * the backend down.
 */
export async function takeHourlySnapshotIfDue(
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
    const at = now();
    // Purge first: a snapshot past the age bound must not stand in for a new one.
    purgeStorageSnapshots(dataDir, at);
    const newest = listStorageSnapshots(dataDir).find((entry) => entry.kind === "hourly");
    if (newest) {
      if (at - newest.takenAt < HOURLY_INTERVAL_MS) return null;
      // An unreadable newest snapshot never matches, so it is replaced.
      if (snapshotFingerprint(newest.file) === contentFingerprint(database.db)) return null;
    }
    const file = snapshot(database, dataDir, `hourly-${stampOf(at)}`);
    purgeStorageSnapshots(dataDir, at);
    return file;
  } catch (error) {
    console.warn(
      "[Storage] Hourly database snapshot failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  } finally {
    await release?.().catch(() => undefined);
  }
}
