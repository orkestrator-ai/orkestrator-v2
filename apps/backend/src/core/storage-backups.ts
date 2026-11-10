import { Database } from "bun:sqlite";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANGE_LEDGER_DATABASE_FILE, type StorageDatabase } from "./storage-database.js";
import type {
  DatabaseBackupSummary,
  DatabaseStoreFamily,
  DatabaseTopTable,
  DatabaseTopTables,
} from "@orkestrator/protocol/backend-diagnostics";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { openCaptureFile, readCaptureFile } from "@orkestrator/protocol/node/command-capture";
import { reapAfterLostExit } from "@orkestrator/protocol/node/lost-exit-reaper";
import { watchForLostExit } from "@orkestrator/protocol/node/shell-process-state";
import { HEALTH_SUMMARY_STORE } from "./health-summary-layout.js";
import { FAMILY_RULES } from "./storage-lease-metrics.js";

const log = createLogger("storage");

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
 * The change-tracking ledger has its own file, `change-tracking.sqlite`, so
 * hourly snapshots no longer copy it. It is copied separately and as best
 * effort:
 *
 * - `change-tracking-daily-<stamp>.sqlite`, taken by the same check when the
 *   newest is at least {@link LEDGER_INTERVAL_MS} old. The newest
 *   {@link KEEP_LEDGER} stay. These give way first to the
 *   snapshot budget, and one that does not fit beside the others is skipped.
 * - `change-tracking-pre-migration-v<from>-<stamp>.sqlite`, before the ledger
 *   file's own schema is migrated. The newest {@link KEEP_PRE_MIGRATION} stay.
 *
 * Neither holds `<dataDir>/change-tracking/` (objects and evidence bodies), so
 * a restored ledger can name bodies that are gone; readers report those as
 * expired.
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
 * Restore: stop the app, replace `orkestrator.sqlite` with an hourly or
 * pre-migration snapshot and delete `orkestrator.sqlite-wal` and `-shm`. The
 * ledger is restored the same way, separately: `change-tracking.sqlite` from a
 * `change-tracking-*` snapshot, deleting its `-wal` and `-shm`.
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
/** Spacing of the change-tracking ledger's snapshots. */
export const LEDGER_INTERVAL_MS = DAY_MS;
export const KEEP_LEDGER = 2;
export const MAX_BACKUP_AGE_MS = 7 * DAY_MS;
/** Off the start-up path, so a restart does not start a copy straight away. */
export const BACKUP_FIRST_CHECK_DELAY_MS = 10 * 60 * 1000;
const GIB = 1024 * 1024 * 1024;
/**
 * Retained snapshots together. A temporary replacement can exceed this
 * budget while copying, subject to the free-space gate. The oldest hourly
 * copies give way after success; the newest hourly one always stays.
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
/**
 * The copy's own supervisor enforces the timeout. This is how much longer the
 * backend waits to hear from it before treating the result as unknown.
 */
const COPY_SETTLE_GRACE_MS = 30_000;
/**
 * A verdict, a line of at most {@link MAX_TOP_TABLES} names and sizes, and a
 * line of at most {@link MAX_TOP_STORE_FAMILIES} store families and sizes.
 */
const MAX_COPY_OUTPUT_BYTES = 64 * 1024;
/** Consecutive failures and the earliest next attempt, kept across restarts. */
const BACKOFF_FILE = ".hourly-backoff.json";
/** The same for the ledger's copies, so neither kind's failures delay the other. */
const LEDGER_BACKOFF_FILE = ".ledger-backoff.json";
/** The latest sampled table sizes for each database; see {@link readTopTables}. */
const TOP_TABLES_FILE = ".top-tables.json";
/** Enough to show what dominates a file. Bounds the child's reply too. */
export const MAX_TOP_TABLES = 12;
const MAX_TABLE_NAME_CHARS = 128;
/** Store families reported beside the tables; bounds the child's reply the same way. */
export const MAX_TOP_STORE_FAMILIES = 12;
const STORE_FAMILY = new RegExp(FAMILY_RULES.safeFamily);

const SNAPSHOT =
  /^(hourly|pre-migration-v\d+|change-tracking-daily|change-tracking-pre-migration-v\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.sqlite$/;
/** `.<name>.<pid>.tmp`, and the journal, WAL and shared memory SQLite puts beside it. */
const TEMPORARY =
  /^\.(?:hourly|pre-migration-v\d+|change-tracking-daily|change-tracking-pre-migration-v\d+)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(\d+)\.tmp(?:-journal|-wal|-shm)?$/;
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
  /** `ledger` and `ledger-pre-migration` copy `change-tracking.sqlite`; the others the main file. */
  kind: "hourly" | "pre-migration" | "ledger" | "ledger-pre-migration";
  takenAt: number;
}

function snapshotKind(prefix: string): StorageSnapshot["kind"] {
  if (prefix === "hourly") return "hourly";
  if (prefix === "change-tracking-daily") return "ledger";
  if (prefix.startsWith("change-tracking-pre-migration")) return "ledger-pre-migration";
  return "pre-migration";
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
      kind: snapshotKind(match[1]!),
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
      log.warn("snapshot.integrity-failed");
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
 * a large database. A sound copy is also sized by table through `dbstat`, which
 * scans it too, and by store family inside `store_rows`, the table nearly every
 * store shares, with one more pass; `onTopTables` receives both. Those scans
 * touch only the finished copy, never the live file or this event loop, and
 * SQLite without `dbstat` (Bun on macOS loads the system library) simply
 * reports no tables.
 *
 * The verdict comes back through unlinked files, so no pipe reader has to see
 * the end of a stream (docs/tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md).
 * `runCommand` does not fit: stdin here stays open as the liveness pipe, and
 * closing it tells the supervisor the backend died. A child that never reports
 * its exit fails at a deadline: without an exit status the verdict is not read.
 */
export function copyDatabaseInChildProcess(
  source: string,
  target: string,
  options: {
    timeoutMs?: number;
    /** Tables by size (empty without `dbstat`), and store families when there is a `store_rows`. */
    onTopTables?: (tables: DatabaseTopTable[], stores: DatabaseStoreFamily[] | null) => void;
    /** Starts the supervisor. Tests use this to withhold what the runtime reports. */
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    settleGraceMs?: number;
  } = {},
): Promise<boolean> {
  return runSqliteHelperInChildProcess("Database copy", DATABASE_COPY_HELPER, [source, target], {
    timeoutMs: options.timeoutMs ?? COPY_TIMEOUT_MS,
    spawn: options.spawn,
    settleGraceMs: options.settleGraceMs,
  }).then(({ code, signal, stdout, stderr }) => {
    const [verdict, tables, stores] = stdout.trim().split("\n", 3);
    if (code === 0 && verdict === "sound") {
      const parsedTables = parseTopTables(tables);
      const parsedStores = parseStoreFamilies(stores);
      if (parsedTables || parsedStores) options.onTopTables?.(parsedTables ?? [], parsedStores);
      return true;
    }
    if (code === 0 && verdict === "unsound") return false;
    throw new Error(`Database copy failed: ${childFailureReason(code, signal, stderr)}`);
  });
}

/** The helper's last line of stderr, or how it ended. Never content: helpers print only error names. */
function childFailureReason(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  return stderr.trim().split("\n").at(-1) || (signal ? `killed by ${signal}` : `exit ${code}`);
}

/**
 * Runs `helper` (a `bun -e` script) with `args` under
 * {@link DATABASE_COPY_SUPERVISOR}, at low priority, and resolves with how it
 * exited and its bounded output. Shared by the snapshot copy and the upkeep's
 * free-page release, which both hold SQLite for longer than the event loop
 * may wait. Rejects only when the child cannot be started or never reports an
 * exit; reading the result is the caller's.
 */
function runSqliteHelperInChildProcess(
  label: string,
  helper: string,
  args: string[],
  options: {
    timeoutMs: number;
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    settleGraceMs?: number;
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs;
    const captureFds: number[] = [];
    const releaseCapture = () => {
      for (const fd of captureFds.splice(0)) {
        try {
          fs.closeSync(fd);
        } catch {
          // Continue releasing the other stream.
        }
      }
    };
    let child: ChildProcess;
    try {
      captureFds.push(openCaptureFile());
      captureFds.push(openCaptureFile());
      child = (options.spawn ?? spawn)(
        process.execPath,
        ["-e", DATABASE_COPY_SUPERVISOR, "--", String(timeoutMs), helper, ...args],
        {
          // Only this backend owns the write end. Abrupt death closes it too.
          stdio: ["pipe", captureFds[0]!, captureFds[1]!],
        },
      );
    } catch (error) {
      releaseCapture();
      reject(error);
      return;
    }
    const [stdoutFd, stderrFd] = captureFds as [number, number];
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // Best effort: priority only keeps the child out of the way.
    }
    // Ask the responsive supervisor to kill and reap its synchronous worker.
    const kill = () => child.stdin?.destroy();
    process.once("exit", kill);

    let settled = false;
    let stopExitWatch = () => {};
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      stopExitWatch();
      process.removeListener("exit", kill);
      child.stdin?.destroy();
      // A lost exit leaves the supervisor a zombie on macOS unless it is reaped.
      const exitReported = () => child.exitCode !== null || child.signalCode !== null;
      if (!exitReported()) reapAfterLostExit(child.pid, exitReported);
      return true;
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!settle()) return;
      try {
        resolve({
          code,
          signal,
          stdout: readCaptureFile(stdoutFd, MAX_COPY_OUTPUT_BYTES).toString(),
          stderr: readCaptureFile(stderrFd, MAX_COPY_OUTPUT_BYTES).toString(),
        });
      } catch (error) {
        reject(error);
      } finally {
        releaseCapture();
      }
    };
    const deadline = setTimeout(
      () => {
        if (!settle()) return;
        child.kill("SIGKILL");
        releaseCapture();
        reject(new Error(`${label} failed: its process never reported an exit`));
      },
      timeoutMs + (options.settleGraceMs ?? COPY_SETTLE_GRACE_MS),
    );
    deadline.unref();
    child.on("error", (error) => {
      if (!settle()) return;
      releaseCapture();
      reject(error);
    });
    child.once("exit", onExit);
    stopExitWatch = watchForLostExit(child.pid, ({ code, signal }) => onExit(code, signal));
  });
}

/**
 * Stays responsive while SQLite blocks the worker. EOF survives SIGKILL of
 * the backend; the independent deadline also survives its event-loop stalls.
 * Waits for the worker's exit, so no open copy allocation survives, but not
 * forever once it has had SIGKILL: a lost exit event must still end this process.
 */
export const DATABASE_COPY_SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");
const [timeoutMs, helper, ...args] = process.argv.slice(1);
const worker = spawn(process.execPath, ["-e", helper, "--", ...args], {
  stdio: ["ignore", "inherit", "inherit"],
});
let stopped = false;
const stop = () => {
  stopped = true;
  worker.kill("SIGKILL");
  setTimeout(() => process.exit(1), 5000);
};
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdin.resume();
const timer = setTimeout(stop, Number(timeoutMs));
worker.on("error", () => { clearTimeout(timer); process.exit(1); });
worker.on("exit", (code) => { clearTimeout(timer); process.exit(stopped ? 1 : code ?? 1); });
`;

/**
 * Run by {@link copyDatabaseInChildProcess}: `-- <source> <target>`. Prints
 * `sound` or `unsound`, and after `sound` a line of JSON holding the largest
 * tables and indexes by bytes, when this SQLite has `dbstat`, then a line of
 * JSON holding the largest store families in `store_rows` by value bytes.
 * Store names can hold ids, so they are folded to families here, with
 * `leaseFamily`'s rules ({@link FAMILY_RULES}), before anything leaves the
 * child. `octet_length` arrived in SQLite 3.43; an older library measures the
 * same bytes through a cast to a blob. A failed scan never fails the copy.
 */
export const DATABASE_COPY_HELPER = String.raw`
const { Database } = require("bun:sqlite");
const fs = require("node:fs");
const [source, target] = process.argv.slice(1);
const ID_LIKE = new RegExp(${JSON.stringify(FAMILY_RULES.idLike)}, "gi");
const SAFE_FAMILY = new RegExp(${JSON.stringify(FAMILY_RULES.safeFamily)});
function storeFamily(name) {
  if (typeof name !== "string") return ${JSON.stringify(FAMILY_RULES.other)};
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
    return ${JSON.stringify(FAMILY_RULES.outsideDataDir)};
  }
  const first = (name.split("/", 1)[0] || "").replace(ID_LIKE, "*");
  return SAFE_FAMILY.test(first) ? first : ${JSON.stringify(FAMILY_RULES.other)};
}
function storeFamilies(copy) {
  const table = copy
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_rows'")
    .get();
  if (!table) return "";
  let rows;
  try {
    rows = copy
      .query("SELECT store, SUM(octet_length(value)) AS bytes, COUNT(*) AS count FROM store_rows GROUP BY store")
      .all();
  } catch {
    rows = copy
      .query("SELECT store, SUM(length(CAST(value AS BLOB))) AS bytes, COUNT(*) AS count FROM store_rows GROUP BY store")
      .all();
  }
  const families = new Map();
  for (const row of rows) {
    const family = storeFamily(row.store);
    const total = families.get(family) || { family, bytes: 0, rows: 0 };
    total.bytes += Number(row.bytes) || 0;
    total.rows += Number(row.count) || 0;
    families.set(family, total);
  }
  return JSON.stringify(
    [...families.values()]
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, ${MAX_TOP_STORE_FAMILIES}),
  );
}
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
  let tables = "";
  let stores = "";
  try {
    const rows = copy.query("PRAGMA quick_check").all();
    sound = rows.length === 1 && Object.values(rows[0])[0] === "ok";
    if (sound) {
      try {
        tables = JSON.stringify(
          copy
            .query("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT ${MAX_TOP_TABLES}")
            .all(),
        );
      } catch {
        // No dbstat in this SQLite: the copy still counts.
      }
      try {
        stores = storeFamilies(copy);
      } catch {
        // A store scan that fails says nothing, and the copy still counts.
      }
    }
  } finally {
    copy.close();
  }
  process.stdout.write(sound ? "sound\n" + tables + "\n" + stores : "unsound");
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error).split("\n")[0]);
  process.exit(1);
}
`;

/** The child's second line: only well-formed names and sizes get past here. */
function parseTopTables(line: string | undefined): DatabaseTopTable[] | null {
  if (!line) return null;
  try {
    const rows = JSON.parse(line) as unknown;
    if (!Array.isArray(rows)) return null;
    return rows
      .filter(
        (row): row is DatabaseTopTable =>
          typeof row?.name === "string" &&
          row.name.length <= MAX_TABLE_NAME_CHARS &&
          Number.isSafeInteger(row?.bytes),
      )
      .slice(0, MAX_TOP_TABLES)
      .map(({ name, bytes }) => ({ name, bytes }));
  } catch {
    return null;
  }
}

/** The child's third line: only family names and whole sizes get past here. */
function parseStoreFamilies(line: string | undefined): DatabaseStoreFamily[] | null {
  if (!line) return null;
  try {
    const rows = JSON.parse(line) as unknown;
    if (!Array.isArray(rows)) return null;
    return rows
      .filter(
        (row): row is DatabaseStoreFamily =>
          typeof row?.family === "string" &&
          STORE_FAMILY.test(row.family) &&
          Number.isSafeInteger(row?.bytes) &&
          Number.isSafeInteger(row?.rows),
      )
      .slice(0, MAX_TOP_STORE_FAMILIES)
      .map(({ family, bytes, rows }) => ({ family, bytes, rows }));
  } catch {
    return null;
  }
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
 * Deletes snapshots until every snapshot together, plus `incomingBytes` for a
 * copy about to be taken, fits {@link MAX_BACKUP_BYTES}. The newest hourly
 * snapshot always stays (until a newer one replaces it), as do pre-migration
 * ones, which have their own count bound. Then the other hourly snapshots,
 * newest first; the ledger's daily copies, which are best effort, give way
 * first.
 */
export function enforceBackupBudget(
  dataDir: string,
  incomingBytes = 0,
  maxBytes = MAX_BACKUP_BYTES,
): void {
  const snapshots = listStorageSnapshots(dataDir);
  let total = incomingBytes;
  for (const entry of snapshots) if (isPreMigration(entry)) total += snapshotBytes(entry);
  for (const kind of ["hourly", "ledger"] as const) {
    let over = false;
    snapshots
      .filter((entry) => entry.kind === kind)
      .forEach((entry, index) => {
        const bytes = snapshotBytes(entry);
        if (!over && ((kind === "hourly" && index === 0) || total + bytes <= maxBytes)) {
          total += bytes;
          return;
        }
        // Once one does not fit, every older one goes too: the oldest give way.
        over = true;
        fs.rmSync(entry.file, { force: true });
      });
  }
}

type TopTablesFile = { main?: DatabaseTopTables; ledger?: DatabaseTopTables };

/** The table sizes the last copies of each database reported; empty before the first. */
export function readTopTables(dataDir: string): TopTablesFile {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(dataDir, BACKUP_DIRECTORY, TOP_TABLES_FILE), "utf8"),
    ) as unknown;
    return typeof value === "object" && value !== null ? (value as TopTablesFile) : {};
  } catch {
    return {};
  }
}

/** Never fails the snapshot it describes. */
function recordTopTables(
  directory: string,
  database: keyof TopTablesFile,
  at: number,
  tables: DatabaseTopTable[],
  stores: DatabaseStoreFamily[] | null,
): void {
  try {
    const file = path.join(directory, TOP_TABLES_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    const current = readTopTables(path.dirname(directory));
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        ...current,
        [database]: { takenAt: new Date(at).toISOString(), tables, ...(stores ? { stores } : {}) },
      }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } catch (error) {
    log.warn("snapshot.top-tables-failed", { error: formatLogError(error, { message: false }) });
  }
}

/** Count and bytes of every retained snapshot. A stat per snapshot, of which few are kept. */
export function summarizeStorageSnapshots(dataDir: string): DatabaseBackupSummary {
  const summary: DatabaseBackupSummary = {
    count: 0,
    bytes: 0,
    newestAt: null,
    kinds: {
      hourly: { count: 0, bytes: 0 },
      "pre-migration": { count: 0, bytes: 0 },
      ledger: { count: 0, bytes: 0 },
      "ledger-pre-migration": { count: 0, bytes: 0 },
    },
  };
  for (const entry of listStorageSnapshots(dataDir)) {
    const bytes = snapshotBytes(entry);
    summary.count += 1;
    summary.bytes += bytes;
    summary.kinds[entry.kind].count += 1;
    summary.kinds[entry.kind].bytes += bytes;
    summary.newestAt ??= new Date(entry.takenAt).toISOString();
  }
  return summary;
}

function isPreMigration(entry: StorageSnapshot): boolean {
  return entry.kind === "pre-migration" || entry.kind === "ledger-pre-migration";
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

function readBackoff(directory: string, file = BACKOFF_FILE): BackupBackoff | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as unknown;
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

function recordFailure(directory: string, at: number, file = BACKOFF_FILE): BackupBackoff {
  const failures = (readBackoff(directory, file)?.failures ?? 0) + 1;
  const backoff = { failures, retryAt: at + failureBackoffMs(failures) };
  try {
    fs.writeFileSync(path.join(directory, file), JSON.stringify(backoff), { mode: 0o600 });
  } catch {
    // Not recorded: the next check simply tries again.
  }
  return backoff;
}

function clearBackoff(directory: string, file = BACKOFF_FILE): void {
  fs.rmSync(path.join(directory, file), { force: true });
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
  const newest = (kind: StorageSnapshot["kind"], count: number) =>
    snapshots.filter((entry) => entry.kind === kind).slice(0, count);
  for (const entry of [
    ...newest("pre-migration", KEEP_PRE_MIGRATION),
    ...newest("ledger-pre-migration", KEEP_PRE_MIGRATION),
    ...newest("ledger", KEEP_LEDGER),
  ]) {
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
 * is the live database's at the moment it was taken. The health summary gets a
 * row every few minutes on an idle machine, so counting it would take an hourly
 * copy of a database nothing else had changed.
 */
function contentFingerprint(db: Database): string {
  const hash = createHash("sha256");
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  hash.update(`schema\0${user_version}`);
  const stores = db
    .query("SELECT name, revision FROM stores WHERE name != ? ORDER BY name")
    .all(HEALTH_SUMMARY_STORE) as Array<{
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
  prefix: "pre-migration" | "change-tracking-pre-migration" = "pre-migration",
): void {
  removeStaleBackupTemporaries(dataDir, now);
  // A migration must not run without its safety copy: a failure here aborts
  // the open rather than migrating unprotected.
  const file = snapshot(database, dataDir, `${prefix}-v${from}-${stampOf(now)}`);
  if (!file) throw new Error("Could not take a sound database snapshot before migrating");
  purgeStorageSnapshots(dataDir, now);
}

export interface HourlySnapshotOptions {
  /** Aggregate snapshot budget, defaults to MAX_BACKUP_BYTES. */
  maxBytes?: number;
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
    const backups = directory;
    const copy =
      options.copy ??
      ((from: string, to: string) =>
        copyDatabaseInChildProcess(from, to, {
          onTopTables: (tables, stores) => recordTopTables(backups, "main", at, tables, stores),
        }));
    removeStaleBackupTemporaries(dataDir, at);
    // Purge first: a snapshot past the age bound must not stand in for a new one.
    purgeStorageSnapshots(dataDir, at);
    enforceBackupBudget(dataDir, 0, options.maxBytes);
    const newest = listStorageSnapshots(dataDir).find((entry) => entry.kind === "hourly");
    if (newest) {
      if (at - newest.takenAt < HOURLY_INTERVAL_MS) return null;
      // An unreadable newest snapshot never matches, so it is replaced.
      if (snapshotFingerprint(newest.file) === contentFingerprint(database.db)) return null;
    }
    const backoff = readBackoff(directory);
    if (backoff && at < backoff.retryAt) return null;

    const bytes = database.livePageBytes();
    const available = availableBytes(directory);
    if (available < requiredFreeBytes(bytes)) {
      const { retryAt } = recordFailure(directory, at);
      log.warn("snapshot.skipped-low-disk", {
        availableBytes: available,
        requiredBytes: requiredFreeBytes(bytes),
        databaseBytes: bytes,
        retryAt: new Date(retryAt).toISOString(),
      });
      return null;
    }

    const name = `hourly-${stampOf(at)}`;
    const target = path.join(directory, `${name}.sqlite`);
    const temporary = temporaryFor(directory, name);
    removeTemporary(temporary);
    try {
      if (!(await copy(database.path, temporary))) {
        recordFailure(directory, at);
        log.warn("snapshot.integrity-failed");
        return null;
      }
      fs.renameSync(temporary, target);
    } finally {
      removeTemporary(temporary);
    }
    clearBackoff(directory);
    purgeStorageSnapshots(dataDir, at);
    enforceBackupBudget(dataDir, 0, options.maxBytes);
    return target;
  } catch (error) {
    const backoff = directory ? recordFailure(directory, now()) : null;
    log.warn("snapshot.failed", {
      retryAt: backoff ? new Date(backoff.retryAt).toISOString() : null,
      error: formatLogError(error),
    });
    return null;
  } finally {
    await release?.().catch(() => undefined);
  }
}

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Takes a snapshot of the change-tracking ledger (`change-tracking.sqlite`) if
 * the newest is at least {@link LEDGER_INTERVAL_MS} old, then purges. Every due
 * interval copies all writes, including ownership and binding-only changes. Best effort: it holds the same lease as the hourly
 * snapshot (in the main database, so one copy runs at a time across backends),
 * copies in a child process the same way, never throws, and backs off on its
 * own after a failure. A copy that would not fit the snapshot budget beside
 * every other snapshot is skipped rather than displacing one.
 */
export async function takeLedgerSnapshotIfDue(
  database: StorageDatabase,
  dataDir: string,
  now: () => number = Date.now,
  options: HourlySnapshotOptions = {},
): Promise<string | null> {
  const source = path.join(dataDir, CHANGE_LEDGER_DATABASE_FILE);
  if (!fs.existsSync(source)) return null;
  const availableBytes = options.availableBytes ?? availableDiskBytes;
  const maxBytes = options.maxBytes ?? MAX_BACKUP_BYTES;
  let release: (() => Promise<void>) | undefined;
  let directory: string | undefined;
  try {
    release = await database.acquireLease("storage-backup", "database backup", {
      acquireTimeoutMs: 5_000,
      staleMs: 120_000,
    });
    const at = now();
    directory = backupDirectory(dataDir);
    const backups = directory;
    const copy =
      options.copy ??
      ((from: string, to: string) =>
        copyDatabaseInChildProcess(from, to, {
          onTopTables: (tables, stores) => recordTopTables(backups, "ledger", at, tables, stores),
        }));
    removeStaleBackupTemporaries(dataDir, at);
    purgeStorageSnapshots(dataDir, at);
    enforceBackupBudget(dataDir, 0, maxBytes);
    const snapshots = listStorageSnapshots(dataDir);
    const newest = snapshots.find((entry) => entry.kind === "ledger");
    if (newest) {
      if (at - newest.takenAt < LEDGER_INTERVAL_MS) return null;
    }
    const backoff = readBackoff(directory, LEDGER_BACKOFF_FILE);
    if (backoff && at < backoff.retryAt) return null;

    // The copy is compact, so the file plus its WAL is an upper bound.
    const bytes = fileBytes(source) + fileBytes(`${source}-wal`);
    const available = availableBytes(directory);
    // Every other snapshot stays; the ledger copies this one replaces may go.
    const kept = snapshots
      .filter((entry) => entry.kind !== "ledger")
      .reduce((sum, entry) => sum + snapshotBytes(entry), 0);
    if (available < requiredFreeBytes(bytes) || kept + bytes > maxBytes) {
      const { retryAt } = recordFailure(directory, at, LEDGER_BACKOFF_FILE);
      log.warn("snapshot.ledger-skipped", {
        availableBytes: available,
        requiredBytes: requiredFreeBytes(bytes),
        ledgerBytes: bytes,
        budgetBytes: maxBytes - kept,
        retryAt: new Date(retryAt).toISOString(),
      });
      return null;
    }

    const name = `change-tracking-daily-${stampOf(at)}`;
    const target = path.join(directory, `${name}.sqlite`);
    const temporary = temporaryFor(directory, name);
    removeTemporary(temporary);
    try {
      if (!(await copy(source, temporary))) {
        recordFailure(directory, at, LEDGER_BACKOFF_FILE);
        log.warn("snapshot.integrity-failed");
        return null;
      }
      fs.renameSync(temporary, target);
    } finally {
      removeTemporary(temporary);
    }
    clearBackoff(directory, LEDGER_BACKOFF_FILE);
    purgeStorageSnapshots(dataDir, at);
    enforceBackupBudget(dataDir, 0, maxBytes);
    return target;
  } catch (error) {
    const backoff = directory ? recordFailure(directory, now(), LEDGER_BACKOFF_FILE) : null;
    log.warn("snapshot.ledger-failed", {
      retryAt: backoff ? new Date(backoff.retryAt).toISOString() : null,
      error: formatLogError(error),
    });
    return null;
  } finally {
    await release?.().catch(() => undefined);
  }
}

/** Pages one upkeep returns at most: 1 GiB of 4 KiB pages. */
export const UPKEEP_RELEASE_PAGE_BUDGET = 262_144;
/**
 * Pages the release child returns per transaction (1 MiB). Each step holds
 * the write lock, so this bounds how long a backend writer waits behind it.
 */
export const UPKEEP_RELEASE_STEP_PAGES = 256;
/** The child's pause between steps, so the backend's writers get the lock. */
export const UPKEEP_RELEASE_PAUSE_MS = 5;
/**
 * A step (its `incremental_vacuum` and checkpoint) slower than this ends the
 * release until the next check. A slow step means the disk is busy: a step
 * reads the pages it moves while it holds the write lock, and a backend writer
 * waits behind it with the event loop held. With four processes fsyncing beside
 * it, steps of a 1 GiB release held the lock for up to 2.5 s and backend writes
 * waited up to 4.2 s (to-do 7210 task 4). On an idle disk a step takes under
 * 60 ms, so a stop there only moves the rest to the next check.
 */
export const UPKEEP_RELEASE_SLOW_STEP_MS = 100;
/** A release still running after this long is killed; checks come every five minutes. */
const UPKEEP_RELEASE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Why a free-page release stopped: nothing left (`done`), the page budget
 * (`budget`), another connection held the database (`busy`), a step freed
 * nothing (`no-progress`), a step took longer than
 * {@link UPKEEP_RELEASE_SLOW_STEP_MS} (`slow-step`, a busy disk), or the
 * database cannot release pages at all (`not-incremental`, no incremental
 * auto-vacuum).
 */
export const FREE_PAGE_RELEASE_STOPS = [
  "done",
  "budget",
  "busy",
  "no-progress",
  "slow-step",
  "not-incremental",
] as const;
export type FreePageReleaseStop = (typeof FREE_PAGE_RELEASE_STOPS)[number];

/** What the free-page release reported. */
export interface FreePageRelease {
  released: number;
  left: number;
  stop: FreePageReleaseStop;
}

/**
 * Returns up to `maxPages` free pages of the database at `file` to the
 * filesystem, in a child process at low priority with its own connection
 * (to-do 1202 task 7, report finding ST-13). In-process each step of
 * `incremental_vacuum` and the checkpoint that followed it held the event loop
 * for 30–190 ms, seconds under disk load. The child commits
 * {@link UPKEEP_RELEASE_STEP_PAGES} at a time with the backend's durability
 * settings, checkpoints its own frames after each step so the backend's next
 * commit does not pay for them, and pauses between steps. It stops at the
 * budget, when nothing is left, or when a step makes no progress, finds the
 * database busy or is slower than {@link UPKEEP_RELEASE_SLOW_STEP_MS} (the
 * next check tries again). Rejects when the child fails.
 */
export function releaseFreePagesInChildProcess(
  file: string,
  options: {
    maxPages?: number;
    stepPages?: number;
    pauseMs?: number;
    slowStepMs?: number;
    timeoutMs?: number;
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  } = {},
): Promise<FreePageRelease> {
  return runSqliteHelperInChildProcess(
    "Free-page release",
    FREE_PAGE_RELEASE_HELPER,
    [
      file,
      String(options.maxPages ?? UPKEEP_RELEASE_PAGE_BUDGET),
      String(options.stepPages ?? UPKEEP_RELEASE_STEP_PAGES),
      String(options.pauseMs ?? UPKEEP_RELEASE_PAUSE_MS),
      String(options.slowStepMs ?? UPKEEP_RELEASE_SLOW_STEP_MS),
    ],
    { timeoutMs: options.timeoutMs ?? UPKEEP_RELEASE_TIMEOUT_MS, spawn: options.spawn },
  ).then(({ code, signal, stdout, stderr }) => {
    const [releasedText, leftText, stop] = stdout.trim().split(" ");
    const released = Number(releasedText);
    const left = Number(leftText);
    if (
      code === 0 &&
      Number.isSafeInteger(released) &&
      Number.isSafeInteger(left) &&
      (FREE_PAGE_RELEASE_STOPS as readonly string[]).includes(stop ?? "")
    ) {
      return { released, left, stop: stop as FreePageReleaseStop };
    }
    throw new Error(`Free-page release failed: ${childFailureReason(code, signal, stderr)}`);
  });
}

/**
 * Run by {@link releaseFreePagesInChildProcess}:
 * `-- <file> <maxPages> <stepPages> <pauseMs> <slowStepMs>`. Prints
 * `<released> <left> <stop>` ({@link FreePageReleaseStop}). Sets what the
 * backend's connection sets (`storage-database.ts`), so a step here is as
 * durable and as scrubbing as one there. A busy database or a slow step ends
 * the run without an error: the backend's writers come first.
 */
const FREE_PAGE_RELEASE_HELPER = String.raw`
const { Database } = require("bun:sqlite");
const [file, maxPages, stepPages, pauseMs, slowStepMs] = process.argv.slice(1).map((v, i) => (i === 0 ? v : Number(v)));
try {
  const db = new Database(file);
  let released = 0;
  let left = 0;
  let stop = "done";
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA secure_delete = ON");
    db.exec("PRAGMA journal_size_limit = 8388608");
    const freePages = () => db.query("PRAGMA freelist_count").get().freelist_count;
    left = freePages();
    // Without incremental auto-vacuum free pages are only reused, never released.
    if (db.query("PRAGMA auto_vacuum").get().auto_vacuum !== 2) {
      left = 0;
      stop = "not-incremental";
    }
    while (left > 0) {
      if (released >= maxPages) {
        stop = "budget";
        break;
      }
      const pages = Math.max(1, Math.min(stepPages, maxPages - released));
      const started = performance.now();
      try {
        db.exec("PRAGMA incremental_vacuum(" + pages + ")");
      } catch (error) {
        if (error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")) {
          stop = "busy";
          break;
        }
        throw error;
      }
      // This step's frames, so the backend's next commit never checkpoints them.
      db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
      const now = freePages();
      if (now >= left) {
        stop = "no-progress";
        break;
      }
      released += left - now;
      left = now;
      // The disk is busy: stop holding the lock until the next check.
      if (left > 0 && released < maxPages && performance.now() - started > slowStepMs) {
        stop = "slow-step";
        break;
      }
      if (pauseMs > 0) Bun.sleepSync(pauseMs);
    }
  } finally {
    db.close();
  }
  process.stdout.write(released + " " + left + " " + stop);
} catch (error) {
  process.stderr.write(String(error && error.code ? error.code : "error"));
  process.exit(1);
}
`;

/**
 * Periodic upkeep of the main database, run by the snapshot check after its
 * copies: refreshes planner statistics ({@link StorageDatabase.optimize}) on
 * this connection, which is the one whose queries it reads, then, when there
 * are free pages, returns them to the filesystem in a child process
 * ({@link releaseFreePagesInChildProcess}). Moving the ledger out (storage
 * migration 7) leaves its old pages free in `orkestrator.sqlite`; this is
 * what gives that space back. Never throws.
 *
 * Each pass that runs writes one `upkeep.finished` line: how long `optimize`
 * held the event loop, and what the release returned and why it stopped
 * (`stop`: a {@link FreePageReleaseStop}, `no-free-pages` when there was
 * nothing to release, `closed` when the connection closed after optimize,
 * `failed` when the release threw).
 */
export async function runDatabaseUpkeep(
  database: StorageDatabase,
  options: {
    release?: (file: string) => Promise<FreePageRelease>;
    now?: () => number;
  } = {},
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  if (database.isClosed()) return;
  const startedAt = now();
  try {
    database.optimize();
  } catch (error) {
    log.warn("optimize.failed", { error: formatLogError(error, { message: false }) });
  }
  const optimizeMs = Math.round(now() - startedAt);
  let releasable = 0;
  let outcome: { released: number | null; left: number | null; stop: string } = {
    released: null,
    left: null,
    stop: "no-free-pages",
  };
  let releaseMs: number | null = null;
  try {
    if (database.isClosed()) {
      outcome.stop = "closed";
    } else {
      releasable = database.releasableFreePages();
    }
    if (releasable > 0) {
      const releaseStartedAt = now();
      try {
        outcome = await (options.release ?? releaseFreePagesInChildProcess)(database.path);
      } finally {
        releaseMs = Math.round(now() - releaseStartedAt);
      }
    }
  } catch (error) {
    outcome = { released: null, left: null, stop: "failed" };
    log.warn("upkeep.vacuum-failed", { error: formatLogError(error, { message: false }) });
  }
  log.info("upkeep.finished", {
    durationMs: Math.round(now() - startedAt),
    optimizeMs,
    releasable,
    released: outcome.released,
    left: outcome.left,
    releaseMs,
    stop: outcome.stop,
  });
}
