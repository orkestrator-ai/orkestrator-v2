import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseStoredDesktopConnections,
  type StoredDesktopConnections,
} from "@orkestrator/protocol/connections";
import {
  emptyDeviceCatalogue,
  legacyDesktopConnections,
  migrateDesktopConnections,
  parseDeviceCatalogue,
  type DeviceCatalogue,
} from "@orkestrator/protocol/device-catalogue";

/**
 * Where this device keeps its machine-and-route catalogue.
 *
 * The catalogue belongs to the client device. The native store keeps it in
 * the desktop's own data directory so it stays readable and writable when
 * the desktop's local execution backend is stopped or crashed; nothing here
 * depends on a running backend. Secrets stay OS-encrypted blobs.
 */
export interface ConnectionCatalogueStore {
  /** The saved catalogue, or `null` when this device has none yet. */
  load(): Promise<DeviceCatalogue | null>;
  save(catalogue: DeviceCatalogue): Promise<void>;
  /** Whether a save reaches durable storage right now. */
  isDurable(): boolean;
}

export const DEVICE_CATALOGUE_FILE = "device-connections.json";
export const DEVICE_CATALOGUE_BACKUP_FILE = "device-connections.backup.json";
/** The version-1 list as it was at migration time; the explicit downgrade path. */
export const LEGACY_CATALOGUE_SNAPSHOT_FILE = "device-connections.v1-snapshot.json";
const MAX_CATALOGUE_BYTES = 1024 * 1024;

type FileSystem = Pick<
  typeof fs,
  "readFile" | "writeFile" | "rename" | "mkdir" | "open" | "copyFile" | "rm"
>;

/**
 * Native device store: atomic replacement (unique temp file, flushed, then
 * renamed) and one bounded backup of the previous good catalogue.
 */
export class NativeDeviceCatalogueStore implements ConnectionCatalogueStore {
  private readonly file: string;
  private readonly backupFile: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly fileSystem: FileSystem = fs,
  ) {
    this.file = path.join(directory, DEVICE_CATALOGUE_FILE);
    this.backupFile = path.join(directory, DEVICE_CATALOGUE_BACKUP_FILE);
  }

  isDurable(): boolean {
    return true;
  }

  async load(): Promise<DeviceCatalogue | null> {
    const primary = await this.readCatalogue(this.file);
    if (primary.kind === "ok") return primary.catalogue;
    if (primary.kind === "missing") return null;
    // A torn or corrupted primary falls back to the last good copy rather
    // than silently starting empty, which would look like forgotten machines.
    const backup = await this.readCatalogue(this.backupFile);
    if (backup.kind === "ok") {
      console.warn("[Connections] Device catalogue was unreadable; restored the backup copy.");
      return backup.catalogue;
    }
    throw new Error(
      "The saved connection catalogue is unreadable. It was left in place for recovery.",
    );
  }

  save(catalogue: DeviceCatalogue): Promise<void> {
    const validated = parseDeviceCatalogue(catalogue);
    const run = this.writeQueue.then(() => this.write(validated));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  /** Records the version-1 list once, before the first migrated save. */
  async snapshotLegacy(legacy: StoredDesktopConnections): Promise<void> {
    await this.fileSystem.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, LEGACY_CATALOGUE_SNAPSHOT_FILE);
    try {
      await this.fileSystem.writeFile(target, `${JSON.stringify(legacy, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private async write(catalogue: DeviceCatalogue): Promise<void> {
    await this.fileSystem.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify(catalogue, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_CATALOGUE_BYTES) {
      throw new Error("The connection catalogue is too large to save.");
    }
    const previous = await this.readCatalogue(this.file);
    if (previous.kind === "ok") {
      await this.fileSystem.copyFile(this.file, this.backupFile).catch(() => undefined);
    }
    const temp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await this.fileSystem.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fileSystem.rename(temp, this.file);
    } catch (error) {
      await this.fileSystem.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readCatalogue(
    file: string,
  ): Promise<{ kind: "ok"; catalogue: DeviceCatalogue } | { kind: "missing" } | { kind: "bad" }> {
    let text: string;
    try {
      text = await this.fileSystem.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      return { kind: "bad" };
    }
    if (text.length > MAX_CATALOGUE_BYTES) return { kind: "bad" };
    try {
      return { kind: "ok", catalogue: parseDeviceCatalogue(JSON.parse(text)) };
    } catch {
      return { kind: "bad" };
    }
  }
}

type LegacyBackend = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

/**
 * Reads the version-1 list from the local backend's `config.json`. Used to
 * migrate once, and as the persistence of a manager constructed without a
 * native store (the previous behaviour): saves are written back in the
 * version-1 shape and are in-memory only while the local backend is down.
 */
export class LocalBackendCatalogueStore implements ConnectionCatalogueStore {
  constructor(
    private readonly backend: LegacyBackend,
    private readonly available: () => boolean,
  ) {}

  isDurable(): boolean {
    return this.available();
  }

  async load(): Promise<DeviceCatalogue | null> {
    const legacy = await this.loadLegacy();
    return legacy ? migrateDesktopConnections(legacy) : null;
  }

  async loadLegacy(): Promise<StoredDesktopConnections | null> {
    if (!this.available()) return null;
    return parseStoredDesktopConnections(
      await this.backend.invoke<StoredDesktopConnections>("get_desktop_connections"),
    );
  }

  async save(catalogue: DeviceCatalogue): Promise<void> {
    if (!this.available()) return;
    await this.backend.invoke("save_desktop_connections", {
      desktopConnections: parseStoredDesktopConnections(legacyDesktopConnections(catalogue)),
    });
  }
}

/**
 * The device catalogue, importing the version-1 list exactly once. The
 * import also happens late: when the local backend was down (or its list
 * unreadable) on the first start, the next start that can read it adds the
 * old entries it does not already have and then records the migration. The
 * old list is left untouched (and snapshotted) as the downgrade path.
 */
export async function loadOrMigrateCatalogue(
  store: ConnectionCatalogueStore,
  legacyCatalogue: LocalBackendCatalogueStore | null,
): Promise<DeviceCatalogue> {
  const loaded = await store.load();
  if (loaded?.migratedFromVersion === 1 || !legacyCatalogue) {
    return loaded ?? emptyDeviceCatalogue();
  }
  let legacy: StoredDesktopConnections | null = null;
  try {
    legacy = await legacyCatalogue.loadLegacy();
  } catch {
    console.warn("[Connections] Could not read the previous connection list for migration.");
  }
  if (!legacy) return loaded ?? emptyDeviceCatalogue();
  await (
    store as { snapshotLegacy?: (value: StoredDesktopConnections) => Promise<void> }
  ).snapshotLegacy
    ?.call(store, legacy)
    .catch(() => undefined);
  const imported = migrateDesktopConnections(legacy);
  const merged: DeviceCatalogue = loaded
    ? {
        ...loaded,
        backends: [
          ...loaded.backends,
          ...imported.backends.filter(
            (backend) => !loaded.backends.some((existing) => existing.id === backend.id),
          ),
        ],
        migratedFromVersion: 1,
        migratedAt: imported.migratedAt,
      }
    : imported;
  await store.save(merged);
  return merged;
}
