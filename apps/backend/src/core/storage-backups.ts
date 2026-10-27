import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
 *   (checked {@link BACKUP_FIRST_CHECK_DELAY_MS} after start-up and every
 *   {@link BACKUP_CHECK_INTERVAL_MS}). The newest {@link KEEP_HOURLY} stay, and
 *   so does one a day as it ages ({@link retainedHourlySnapshots}), so there is
 *   always a copy about a day old and one about {@link OLDEST_DAILY_AGE_MS} old.
 *
 * Every snapshot older than {@link MAX_BACKUP_AGE_MS} is deleted regardless.
 * That bound is also the privacy cost: content deleted from the live database
 * can survive in a snapshot until it ages out.
 *
 * An hourly copy of a large database takes minutes of disk I/O, so it runs in
 * a child process ({@link copyDatabaseInChildProcess}) and never blocks the
 * backend's event loop. It is skipped when the disk could not hold it with
 * room to spare ({@link requiredFreeBytes}), older hourly copies give way so
 * all snapshots together stay under {@link MAX_BACKUP_BYTES}, and a failed or
 * skipped copy backs off ({@link failureBackoffMs}) instead of being retried
 * at every check. Temporary copies that an interrupted process left behind
 * are removed ({@link removeStaleBackupTemporaries}).
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
/** Off the start-up path, so a restart does not start a copy straight away. */
export const BACKUP_FIRST_CHECK_DELAY_MS = 10 * 60 * 1000;
const GIB = 1024 * 1024 * 1024;
/**
 * All snapshots together, the next copy included. The oldest hourly copies
 * give way first; the newest hourly one always stays.
 */
export const MAX_BACKUP_BYTES = 16 * GIB;
/** Free space a copy must leave behind at the least ({@link requiredFreeBytes}). */
export const MIN_FREE_BYTES_AFTER_BACKUP = 2 * GIB;
/** The wait after the first failed or skipped copy; it doubles per failure. */
export const BACKUP_FAILURE_BACKOFF_MS = 15 * 60 * 1000;
export const MAX_BACKUP_FAILURE_BACKOFF_MS = 6 * HOURLY_INTERVAL_MS;
/** A temporary copy this long untouched is abandoned even if its pid is alive (reused). */
export const STALE_TEMPORARY_MS = HOURLY_INTERVAL_MS;
/** A copy still running after this long is killed. */
const COPY_TIMEOUT_MS = 2 * HOURLY_INTERVAL_MS;
/** Consecutive failures and the earliest next attempt, kept across restarts. */
const BACKOFF_FILE = ".hourly-backoff.json";

const SNAPSHOT =
  /^(hourly|pre-migration-v\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.sqlite$/;
/** `.<name>.<pid>.tmp`, and the journal, WAL and shared memory SQLite puts beside it. */
const TEMPORARY =
  /^\.(?:hourly|pre-migration-v\d+)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(\d+)\.tmp(?:-journal|-wal|-shm)?$/;
const TEMPORARY_SIDECARS = ["-journal", "-wal", "-shm"] as const;

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
  const temporary = temporaryFor(directory, name);
  removeTemporary(temporary);
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
    removeTemporary(temporary);
  }
}

function temporaryFor(directory: string, name: string): string {
  return path.join(directory, `.${name}.${process.pid}.tmp`);
}

/** Removes a temporary copy and every SQLite sidecar file beside it. */
function removeTemporary(temporary: string): void {
  fs.rmSync(temporary, { force: true });
  for (const suffix of TEMPORARY_SIDECARS) fs.rmSync(`${temporary}${suffix}`, { force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes temporary copies (and their journals) left by a process that died
 * mid-copy, and this process's own leftovers. A live process's copy stays
 * unless it has not been written for {@link STALE_TEMPORARY_MS}, which also
 * covers a dead process's pid being reused. Call only while this process is
 * not copying. Returns the bytes freed.
 */
export function removeStaleBackupTemporaries(dataDir: string, now = Date.now()): number {
  const directory = path.join(dataDir, BACKUP_DIRECTORY);
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return 0;
  }
  let freed = 0;
  for (const entry of entries) {
    const match = TEMPORARY.exec(entry);
    if (!match) continue;
    const file = path.join(directory, entry);
    try {
      const stat = fs.statSync(file);
      const pid = Number(match[1]);
      const live = pid !== process.pid && processAlive(pid);
      if (live && now - stat.mtimeMs < STALE_TEMPORARY_MS) continue;
      fs.rmSync(file, { force: true });
      freed += stat.size;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return freed;
}

/**
 * Copies the database at `source` to `target` with `VACUUM INTO` and checks
 * the copy with `quick_check`, in a child process at low priority. Resolves
 * whether the copy is sound; rejects when the copy fails. Both steps read
 * the whole file; in-process they would block every request for minutes on
 * a large database.
 */
export function copyDatabaseInChildProcess(source: string, target: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", DATABASE_COPY_HELPER, "--", source, target], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // Best effort: priority only keeps the copy out of the way.
    }
    // A backend that exits mid-copy takes its copy along.
    const kill = () => child.kill("SIGKILL");
    process.once("exit", kill);
    const timeout = setTimeout(kill, COPY_TIMEOUT_MS);
    timeout.unref?.();
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    const settle = () => {
      clearTimeout(timeout);
      process.removeListener("exit", kill);
    };
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code, signal) => {
      settle();
      if (code === 0 && stdout.trim() === "sound") resolve(true);
      else if (code === 0 && stdout.trim() === "unsound") resolve(false);
      else {
        const reason =
          stderr.trim().split("\n").at(-1) || (signal ? `killed by ${signal}` : `exit ${code}`);
        reject(new Error(`Database copy failed: ${reason}`));
      }
    });
  });
}

/** Run by {@link copyDatabaseInChildProcess}: `-- <source> <target>`. Prints `sound` or `unsound`. */
const DATABASE_COPY_HELPER = String.raw`
const { Database } = require("bun:sqlite");
const fs = require("node:fs");
const [source, target] = process.argv.slice(1);
try {
  const db = new Database(source, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.query("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  fs.chmodSync(target, 0o600);
  const copy = new Database(target, { readonly: true });
  let sound = false;
  try {
    const rows = copy.query("PRAGMA quick_check").all();
    sound = rows.length === 1 && Object.values(rows[0])[0] === "ok";
  } finally {
    copy.close();
  }
  process.stdout.write(sound ? "sound" : "unsound");
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error).split("\n")[0]);
  process.exit(1);
}
`;

/** Bytes of the live database: the main file and its WAL. */
function databaseBytes(file: string): number {
  let bytes = 0;
  for (const name of [file, `${file}-wal`]) {
    try {
      bytes += fs.statSync(name).size;
    } catch {
      // No WAL yet.
    }
  }
  return bytes;
}

/**
 * Free space a copy of `bytes` needs: the copy itself, plus as much again
 * (at least {@link MIN_FREE_BYTES_AFTER_BACKUP}) left over, so a backup never
 * fills the disk the database and everything else live on.
 */
export function requiredFreeBytes(bytes: number): number {
  return bytes + Math.max(bytes, MIN_FREE_BYTES_AFTER_BACKUP);
}

function availableDiskBytes(directory: string): number {
  const stat = fs.statfsSync(directory);
  return Number(stat.bavail) * Number(stat.bsize);
}

function snapshotBytes(entry: StorageSnapshot): number {
  try {
    return fs.statSync(entry.file).size;
  } catch {
    return 0;
  }
}

/**
 * Deletes the oldest hourly snapshots until every snapshot together, plus
 * `incomingBytes` for a copy about to be taken, fits {@link MAX_BACKUP_BYTES}.
 * The newest hourly snapshot always stays (until a newer one replaces it), as
 * do pre-migration ones, which have their own count bound.
 */
export function enforceBackupBudget(
  dataDir: string,
  incomingBytes = 0,
  maxBytes = MAX_BACKUP_BYTES,
): void {
  const snapshots = listStorageSnapshots(dataDir);
  let total = incomingBytes;
  for (const entry of snapshots) if (entry.kind === "pre-migration") total += snapshotBytes(entry);
  let over = false;
  const hourly = snapshots.filter((entry) => entry.kind === "hourly");
  hourly.forEach((entry, index) => {
    const bytes = snapshotBytes(entry);
    if (!over && (index === 0 || total + bytes <= maxBytes)) {
      total += bytes;
      return;
    }
    // Once one does not fit, every older one goes too: the oldest give way.
    over = true;
    fs.rmSync(entry.file, { force: true });
  });
}

interface BackupBackoff {
  failures: number;
  retryAt: number;
}

/** The wait after `failures` consecutive failed or skipped copies. */
export function failureBackoffMs(failures: number): number {
  return Math.min(
    BACKUP_FAILURE_BACKOFF_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)),
    MAX_BACKUP_FAILURE_BACKOFF_MS,
  );
}

function readBackoff(directory: string): BackupBackoff | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(directory, BACKOFF_FILE), "utf8"),
    ) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      Number.isFinite((value as BackupBackoff).failures) &&
      Number.isFinite((value as BackupBackoff).retryAt)
    ) {
      return value as BackupBackoff;
    }
  } catch {
    // None yet, or unreadable: no backoff.
  }
  return null;
}

function recordFailure(directory: string, at: number): BackupBackoff {
  const failures = (readBackoff(directory)?.failures ?? 0) + 1;
  const backoff = { failures, retryAt: at + failureBackoffMs(failures) };
  try {
    fs.writeFileSync(path.join(directory, BACKOFF_FILE), JSON.stringify(backoff), { mode: 0o600 });
  } catch {
    // Not recorded: the next check simply tries again.
  }
  return backoff;
}

function clearBackoff(directory: string): void {
  fs.rmSync(path.join(directory, BACKOFF_FILE), { force: true });
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
  removeStaleBackupTemporaries(dataDir, now);
  // A migration must not run without its safety copy: a failure here aborts
  // the open rather than migrating unprotected.
  const file = snapshot(database, dataDir, `pre-migration-v${from}-${stampOf(now)}`);
  if (!file) throw new Error("Could not take a sound database snapshot before migrating");
  purgeStorageSnapshots(dataDir, now);
}

export interface HourlySnapshotOptions {
  /** Copies and verifies the database; {@link copyDatabaseInChildProcess} by default. */
  copy?: (source: string, target: string) => Promise<boolean>;
  /** Bytes free on the backups' filesystem. */
  availableBytes?: (directory: string) => number;
}

/**
 * Takes an hourly snapshot if the newest is at least an hour old and the
 * database changed since it, then purges. Serialized across backends sharing
 * the directory by a lease, and never throws: a missed backup must not take
 * the backend down. The copy runs in a child process; a copy that fails, or
 * is skipped for lack of disk space, backs off before the next attempt.
 */
export async function takeHourlySnapshotIfDue(
  database: StorageDatabase,
  dataDir: string,
  now: () => number = Date.now,
  options: HourlySnapshotOptions = {},
): Promise<string | null> {
  const copy = options.copy ?? copyDatabaseInChildProcess;
  const availableBytes = options.availableBytes ?? availableDiskBytes;
  let release: (() => Promise<void>) | undefined;
  let directory: string | undefined;
  try {
    release = await database.acquireLease("storage-backup", "database backup", {
      acquireTimeoutMs: 5_000,
      staleMs: 120_000,
    });
    const at = now();
    directory = backupDirectory(dataDir);
    removeStaleBackupTemporaries(dataDir, at);
    // Purge first: a snapshot past the age bound must not stand in for a new one.
    purgeStorageSnapshots(dataDir, at);
    const newest = listStorageSnapshots(dataDir).find((entry) => entry.kind === "hourly");
    if (newest) {
      if (at - newest.takenAt < HOURLY_INTERVAL_MS) return null;
      // An unreadable newest snapshot never matches, so it is replaced.
      if (snapshotFingerprint(newest.file) === contentFingerprint(database.db)) return null;
    }
    const backoff = readBackoff(directory);
    if (backoff && at < backoff.retryAt) return null;

    const bytes = databaseBytes(database.path);
    enforceBackupBudget(dataDir, bytes);
    const available = availableBytes(directory);
    if (available < requiredFreeBytes(bytes)) {
      const { retryAt } = recordFailure(directory, at);
      console.warn(
        `[Storage] Skipped the hourly database snapshot: ${formatBytes(available)} free, ${formatBytes(requiredFreeBytes(bytes))} needed for a ${formatBytes(bytes)} database; next attempt after ${new Date(retryAt).toISOString()}`,
      );
      return null;
    }

    const name = `hourly-${stampOf(at)}`;
    const target = path.join(directory, `${name}.sqlite`);
    const temporary = temporaryFor(directory, name);
    removeTemporary(temporary);
    try {
      if (!(await copy(database.path, temporary))) {
        recordFailure(directory, at);
        console.warn("[Storage] A database snapshot failed its integrity check and was discarded");
        return null;
      }
      fs.renameSync(temporary, target);
    } finally {
      removeTemporary(temporary);
    }
    clearBackoff(directory);
    purgeStorageSnapshots(dataDir, at);
    enforceBackupBudget(dataDir);
    return target;
  } catch (error) {
    const backoff = directory ? recordFailure(directory, now()) : null;
    console.warn(
      "[Storage] Hourly database snapshot failed:",
      error instanceof Error ? error.message : "unknown error",
      ...(backoff ? [`(next attempt after ${new Date(backoff.retryAt).toISOString()})`] : []),
    );
    return null;
  } finally {
    await release?.().catch(() => undefined);
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}
