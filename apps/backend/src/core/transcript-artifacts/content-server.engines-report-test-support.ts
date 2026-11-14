/**
 * The optional qualification report (`ARTIFACT_ENGINE_REPORT`) the
 * `content-server.engines-<engine>-<n>` parts write. Every part reports only its
 * own engine and lane, and `bun test --parallel` runs the parts in separate
 * worker processes, so each one merges into the file its siblings wrote. The
 * merge is a read-modify-write, so it holds an interprocess lock for its
 * duration and publishes through a rename: an unlocked merge let two parts read
 * the same prior report and the later write erase the other's results.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

export type EngineReport = Record<string, Record<string, unknown>>;

/** How long a merge waits for the lock before giving up. Each holder keeps it for one small read and write. */
const LOCK_WAIT_MS = 30_000;
/**
 * A lock older than this was left by a part that died while holding it. Well under
 * `LOCK_WAIT_MS`, so a waiter breaks a dead part's lock before it gives up.
 */
const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 10;

function lockIsStale(lockFile: string): boolean {
  try {
    return Date.now() - statSync(lockFile).mtimeMs > STALE_LOCK_MS;
  } catch {
    // Released between the failed create and this check: try again at once.
    return false;
  }
}

async function acquireLock(lockFile: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockFile, "wx"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (lockIsStale(lockFile)) {
      rmSync(lockFile, { force: true });
      continue;
    }
    if (Date.now() > deadline)
      throw new Error(`engine report lock ${lockFile} still held after ${LOCK_WAIT_MS} ms`);
    await Bun.sleep(LOCK_RETRY_MS);
  }
}

function readReport(reportFile: string): EngineReport {
  let text: string;
  try {
    text = readFileSync(reportFile, "utf8");
  } catch (error) {
    // No sibling has written it yet.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  // Writes are published by rename, so a partial file means something else wrote it: fail loudly
  // rather than overwrite results with an empty report.
  return JSON.parse(text) as EngineReport;
}

/** `additions` merged over `existing`, field by field within each engine. */
export function mergeEngineReports(existing: EngineReport, additions: EngineReport): EngineReport {
  const merged: EngineReport = { ...existing };
  for (const [name, results] of Object.entries(additions))
    merged[name] = { ...merged[name], ...results };
  return merged;
}

/** Merges `additions` into `reportFile` under its lock, publishing the result atomically. */
export async function mergeIntoEngineReport(
  reportFile: string,
  additions: EngineReport,
): Promise<void> {
  const lockFile = `${reportFile}.lock`;
  await acquireLock(lockFile);
  try {
    const merged = mergeEngineReports(readReport(reportFile), additions);
    const temporary = `${reportFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(merged, null, 2));
      renameSync(temporary, reportFile);
    } finally {
      rmSync(temporary, { force: true });
    }
  } finally {
    rmSync(lockFile, { force: true });
  }
}
