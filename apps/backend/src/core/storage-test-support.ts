import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STORAGE_DATABASE_FILE, StorageDatabase } from "./storage-database.js";
import { databaseStoreForPath, openBackendDatabase } from "./storage-stores.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageRepositories } from "./storage-repositories.js";
import type { StorageService } from "./storage.js";

/**
 * Test helpers for the backend database. Stores are named by the data-dir
 * relative JSON path they replaced (`"kanban.json"`), so a test that used to
 * seed or inspect a file changes only the call, not its fixture.
 *
 * Each helper opens its own short-lived connection, which behaves like another
 * backend process sharing the directory: a running `StorageService` observes
 * the write through the store's committed revision.
 */

function storeName(file: string): string {
  const store = databaseStoreForPath(file);
  if (!store) throw new Error(`${file} is not a database store`);
  return store;
}

function withDatabase<T>(dataDir: string, run: (database: StorageDatabase) => T): T {
  const database = openBackendDatabase(dataDir);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

/** Replaces a store's whole value, like an external write of the old file. */
export function seedStore(dataDir: string, file: string, value: unknown): void {
  withDatabase(dataDir, (database) => database.writeStore(storeName(file), value));
}

/** Stores text that is not valid JSON: a store imported from a corrupt file. */
export function seedUnreadableStore(dataDir: string, file: string, raw = "{ not json"): void {
  withDatabase(dataDir, (database) =>
    database.transaction(() => database.writeRawDocumentInTransaction(storeName(file), raw)),
  );
}

/** A store's committed value, or `undefined` when it was never written. */
export function readStoredValue<T = unknown>(dataDir: string, file: string): T | undefined {
  return withDatabase(dataDir, (database) => {
    const snapshot = database.readStore(storeName(file));
    return snapshot ? (snapshot.value as T) : undefined;
  });
}

type StoredPromptQueueRecord = {
  messages: unknown[];
  outstandingClaim?: unknown;
  updatedAt: string;
  revision: number;
};

/**
 * Moves the head of a stored prompt queue into `outstandingClaim`, the way the
 * removed prompt-queue claim command did (and an older backend sharing
 * the data directory still can): a fresh token, the message, `claimedAt`, and
 * `expiresAt` (default: a five-minute lease), with the revision bumped. Every
 * load of a running `StorageService` restores the message to the head
 * (`restoreLegacyPromptQueueClaims`). Returns the token.
 */
export function seedLegacyPromptQueueClaim(
  dataDir: string,
  queueKey: string,
  messageId: string,
  options: { claimedAt?: string | number | Date; expiresAt?: string | number | Date } = {},
): string {
  const queues = readStoredValue<Record<string, StoredPromptQueueRecord>>(
    dataDir,
    "prompt-queues.json",
  );
  const queue = queues?.[queueKey];
  if (!queues || !queue) throw new Error(`No stored prompt queue ${queueKey}`);
  if (queue.outstandingClaim) throw new Error(`${queueKey} already has a claim`);
  const [head, ...rest] = queue.messages;
  if (typeof head !== "object" || head === null || (head as { id?: unknown }).id !== messageId) {
    throw new Error(`${messageId} is not the head of ${queueKey}`);
  }
  const claimedAt = new Date(options.claimedAt ?? Date.now());
  const expiresAt = new Date(options.expiresAt ?? claimedAt.getTime() + 5 * 60 * 1000);
  const token = randomUUID();
  queues[queueKey] = {
    ...queue,
    messages: rest,
    outstandingClaim: {
      token,
      message: head,
      claimedAt: claimedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    updatedAt: new Date().toISOString(),
    revision: queue.revision + 1,
  };
  seedStore(dataDir, "prompt-queues.json", queues);
  return token;
}

export function hasStore(dataDir: string, file: string): boolean {
  return withDatabase(dataDir, (database) => database.hasStore(storeName(file)));
}

export function deleteStoredValue(dataDir: string, file: string): void {
  withDatabase(dataDir, (database) => database.deleteStore(storeName(file)));
}

/**
 * Whether `needle` is readable anywhere in the database files (main file, WAL
 * and shared memory). The privacy check for deletes: content a delete removed
 * must not survive in free pages or old WAL frames.
 */
export function storageFilesContain(dataDir: string, needle: string): boolean {
  const target = Buffer.from(needle, "utf8");
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path.join(dataDir, `${STORAGE_DATABASE_FILE}${suffix}`);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (bytes.includes(target)) return true;
  }
  return false;
}

/**
 * Writes a pre-SQLite JSON store file. Only meaningful in a data directory
 * whose database does not exist yet: the first open imports it (and applies
 * the one-shot record upgrades), exactly as an upgraded installation would.
 */
export function writeLegacyStore(dataDir: string, file: string, value: unknown): void {
  storeName(file);
  if (fs.existsSync(path.join(dataDir, STORAGE_DATABASE_FILE))) {
    throw new Error("writeLegacyStore needs a data directory without a database");
  }
  const target = path.join(dataDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Writes every legacy-backed store of `dataDir` as JSON files into `targetDir`, after
 * `edit` (return `undefined` to keep a value). Lets a test build current state
 * through the API, rewrite a record into an older shape, and then exercise the
 * real import and upgrade path by opening `targetDir`.
 */
export function exportStoresAsLegacyJson(
  dataDir: string,
  targetDir: string,
  edit: (file: string, value: unknown) => unknown = () => undefined,
): void {
  const values = withDatabase(dataDir, (database) =>
    database.listStores().map((store) => [store, database.readStore(store)?.value] as const),
  );
  for (const [store, value] of values) {
    const file = `${store}.json`;
    // Engine stores that never had a legacy JSON file (web annotations,
    // transcript manifests, display tails) have nothing to export.
    if (!databaseStoreForPath(file)) continue;
    const edited = edit(file, structuredClone(value));
    writeLegacyStore(targetDir, file, edited === undefined ? value : edited);
  }
}

/**
 * The context and repositories behind a `StorageService`, for tests that drive
 * a store primitive or a repository helper the facade does not expose. The one
 * place tests reach past the facade; production code never does.
 */
export function storageInternals(storage: StorageService): {
  context: StorageContext;
  repos: StorageRepositories;
} {
  return storage as unknown as { context: StorageContext; repos: StorageRepositories };
}

/** The open database of a running `StorageService`. */
export function storageDatabase(storage: StorageService): StorageDatabase {
  return storageInternals(storage).context.database;
}
