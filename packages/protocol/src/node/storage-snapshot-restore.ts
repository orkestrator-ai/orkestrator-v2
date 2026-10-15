/**
 * Restoring the database snapshot an update's migration took, for the update
 * hosts that roll a failed version back (the headless supervisor and the
 * desktop app). The backend writes `backups/pre-migration-v<from>-<stamp>.sqlite`
 * before it migrates (`storage-backups.ts`); finding one taken during the
 * failed start is the evidence that the database moved and must go back.
 */
import { copyFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
const SNAPSHOT =
  /^pre-migration-v(\d+)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite$/;

export type PreMigrationSnapshot = { file: string; fromVersion: number; takenAt: number };

/** The newest pre-migration snapshot taken at or after `since`, optionally of one schema version. */
export function findPreMigrationSnapshot(
  dataDir: string,
  options: { since: number; fromVersion?: number },
): PreMigrationSnapshot | null {
  let entries: string[];
  try {
    entries = readdirSync(path.join(dataDir, "backups"));
  } catch {
    return null;
  }
  let newest: PreMigrationSnapshot | null = null;
  for (const name of entries) {
    const match = SNAPSHOT.exec(name);
    if (!match) continue;
    const fromVersion = Number(match[1]);
    if (options.fromVersion !== undefined && fromVersion !== options.fromVersion) continue;
    const takenAt = Date.parse(`${match[2]}T${match[3]}:${match[4]}:${match[5]}.${match[6]}Z`);
    // A second of slack: the stamp has millisecond precision but clocks are read separately.
    if (Number.isNaN(takenAt) || takenAt < options.since - 1_000) continue;
    if (!newest || takenAt > newest.takenAt) {
      newest = { file: path.join(dataDir, "backups", name), fromVersion, takenAt };
    }
  }
  return newest;
}

/**
 * Puts a snapshot back as the live database. The backend must be stopped:
 * the WAL and shared-memory files belong to the database being replaced.
 */
export function restoreDatabaseSnapshot(dataDir: string, snapshotFile: string): void {
  const target = path.join(dataDir, STORAGE_DATABASE_FILE);
  const temporary = `${target}.restore-${randomUUID()}`;
  copyFileSync(snapshotFile, temporary);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
  renameSync(temporary, target);
}
