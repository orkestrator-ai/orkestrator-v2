/**
 * Rollback for the desktop app after an update restarts into a version whose
 * backend will not start. Before installing, the update host keeps a copy of
 * the running app (`keepRollbackCopy`); if the new version then fails to
 * start, `rollBackFailedUpdate` restores the database snapshot its migration
 * took, puts the old app back, and relaunches it. The old version reports the
 * rollback from `pending-install.json`.
 *
 * It cannot help when the new Electron process cannot run at all; that is
 * left to the code signature and notarization the release passed.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  findPreMigrationSnapshot,
  restoreDatabaseSnapshot,
} from "@orkestrator/protocol/node/storage-snapshot-restore";
import type { PendingInstallMarker } from "./update-host.js";

const execFileAsync = promisify(execFile);

export type InstalledApp = { kind: "mac-app"; path: string } | { kind: "appimage"; path: string };

/** The running install: the `.app` bundle on macOS, the AppImage file on Linux. */
export function installedApp(options: {
  platform: NodeJS.Platform;
  exePath: string;
  appImage: string | undefined;
}): InstalledApp | null {
  if (options.platform === "darwin") {
    const bundle = path.resolve(options.exePath, "..", "..", "..");
    return bundle.endsWith(".app") ? { kind: "mac-app", path: bundle } : null;
  }
  return options.appImage ? { kind: "appimage", path: options.appImage } : null;
}

export type RollbackFileOps = {
  /** Copies a bundle or file preserving what macOS signatures need (`ditto` on macOS). */
  copy(source: string, destination: string, kind: InstalledApp["kind"]): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(target: string): Promise<void>;
  mkdir(directory: string): Promise<void>;
  list(directory: string): Promise<string[]>;
};

export const defaultRollbackFileOps: RollbackFileOps = {
  async copy(source, destination, kind) {
    if (kind === "mac-app") {
      // ditto keeps the code signature, extended attributes and symlinks intact.
      await execFileAsync("/usr/bin/ditto", [source, destination]);
    } else {
      await copyFile(source, destination);
    }
  },
  rename: (from, to) => rename(from, to),
  remove: (target) => rm(target, { recursive: true, force: true }),
  mkdir: async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  },
  list: (directory) => readdir(directory).catch(() => []),
};

/**
 * Copies the running app under `<rollbackRoot>/<version>/`, replacing any
 * older copy: only one previous version is kept, at the cost of one app's size.
 */
export async function keepRollbackCopy(options: {
  app: InstalledApp;
  version: string;
  rollbackRoot: string;
  ops?: RollbackFileOps;
}): Promise<string> {
  const ops = options.ops ?? defaultRollbackFileOps;
  await ops.mkdir(options.rollbackRoot);
  for (const entry of await ops.list(options.rollbackRoot)) {
    await ops.remove(path.join(options.rollbackRoot, entry));
  }
  const directory = path.join(options.rollbackRoot, options.version);
  await ops.mkdir(directory);
  const destination = path.join(directory, path.basename(options.app.path));
  await ops.copy(options.app.path, destination, options.app.kind);
  return destination;
}

export type RollbackResult =
  | { rolledBack: true; restoredDatabase: boolean }
  | { rolledBack: false; reason: string };

/**
 * Called when this version failed to start. Rolls back only an update that
 * just installed this very version and left a copy of what it replaced.
 */
export async function rollBackFailedUpdate(options: {
  marker: PendingInstallMarker | null;
  appVersion: string;
  app: InstalledApp | null;
  dataDir: string;
  now: number;
  ops?: RollbackFileOps;
}): Promise<RollbackResult> {
  const { marker, app } = options;
  const ops = options.ops ?? defaultRollbackFileOps;
  if (!marker || marker.toVersion !== options.appVersion || marker.rolledBack) {
    return { rolledBack: false, reason: "no update to roll back" };
  }
  if (!marker.rollbackPath) return { rolledBack: false, reason: "no copy of the previous version" };
  if (!app) return { rolledBack: false, reason: "this install cannot be replaced in place" };
  // The new version's migration snapshotted the database before changing it.
  const snapshot = findPreMigrationSnapshot(options.dataDir, {
    since: Date.parse(marker.createdAt),
  });
  if (snapshot) restoreDatabaseSnapshot(options.dataDir, snapshot.file);
  if (app.kind === "mac-app") {
    const aside = `${app.path}.failed-${options.now}`;
    await ops.rename(app.path, aside);
    try {
      await ops.copy(marker.rollbackPath, app.path, app.kind);
    } catch (error) {
      await ops.rename(aside, app.path).catch(() => undefined);
      throw error;
    }
    await ops.remove(aside).catch(() => undefined);
  } else {
    const temporary = `${app.path}.restore-${options.now}`;
    await ops.copy(marker.rollbackPath, temporary, app.kind);
    await ops.rename(temporary, app.path);
  }
  return { rolledBack: true, restoredDatabase: snapshot !== null };
}
