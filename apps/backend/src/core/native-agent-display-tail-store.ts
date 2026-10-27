import { deletionFence, deletionMarker, markDeletion } from "./storage-deletion-fences.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NATIVE_AGENT_DISPLAY_TAIL_STORE } from "./native-agent-display-tail-layout.js";
import {
  NATIVE_DISPLAY_TAIL_MAX_BYTES,
  NATIVE_DISPLAY_TAIL_MAX_SESSIONS,
  NATIVE_DISPLAY_TAIL_MAX_TOTAL_BYTES,
  isNativeAgentDisplayTail,
  type NativeAgentDisplayTail,
} from "./native-agent-display-tails.js";
import type { StorageDatabase } from "./storage-database.js";

/**
 * Display tails (restart previews) as rows of the backend database: store
 * `native-agent-display-tail-records`, one row per session key, the row owner
 * being the tail's environment. Tails are a regenerable cache; the provider
 * stays authoritative and a missing or invalid row is simply a miss.
 *
 * The rows are read and written through the database's uncached row access
 * (`StorageDatabase.rows`) rather than its whole-store row cache: that cache
 * would hold every tail (up to 64 MiB) in memory and reload all of them
 * whenever another process commits, while a cold read here touches exactly
 * one row. Every committing write moves the store's revision, so
 * `storeRevision` and the database's own readers stay correct for this store.
 *
 * - put: one IMMEDIATE transaction evicts the oldest rows while the store
 *   would exceed the session or byte bound, then upserts the row with
 *   `position` set past every stored position (a write sequence, so position
 *   order is least-recently-written first). A failure rolls everything back.
 * - get: the store revision, then one keyed read, validated (size, schema,
 *   checksum). The row owner (the tail's environment, which
 *   `deleteByEnvironment` deletes by) is derived from the value by the store
 *   layout on every write, so it always matches the tail served. Decoded
 *   tails are cached in memory, bounded, and trusted only while the store
 *   revision is unchanged, so any process's later commit is observed. Store
 *   revisions never repeat, even across a deleted and recreated store.
 * - delete: row deletes, then a scrub: tails hold conversation text, and a
 *   deleted session's or environment's preview must not stay readable in free
 *   pages or old WAL frames. Evictions and overwrites are not scrubbed: that
 *   content is still live at the provider and the next checkpoint reclaims it.
 *
 * The legacy shared `native-agent-display-tails.json` and the keyed-record
 * directory are disposable cache: they are removed (best effort) instead of
 * imported, and the provider repopulates the previews.
 */
export const NATIVE_DISPLAY_TAIL_LEGACY_FILE = "native-agent-display-tails.json";
export const NATIVE_DISPLAY_TAIL_LEGACY_RECORD_DIRECTORY = "native-agent-display-tail-records";
export const NATIVE_DISPLAY_TAIL_DECODED_CACHE_MAX_ENTRIES = 16;
export const NATIVE_DISPLAY_TAIL_DECODED_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_BACKUPS = 5;
const MAX_LEGACY_TEMP_SCAN = 4_096;
const STORE = NATIVE_AGENT_DISPLAY_TAIL_STORE;

export type NativeAgentDisplayTailDeletion =
  { kind: "key"; key: string } | { kind: "environment"; environmentId: string };

export interface NativeAgentDisplayTailStoreOptions {
  /** The backend database; called per operation so a reopened connection is used. */
  database: () => StorageDatabase;
  /** Data directory holding the legacy file-based tails to remove. */
  legacyRoot: string;
  /** Bounds override (tests); defaults are the native display-tail bounds. */
  limits?: { maxSessions?: number; maxTotalBytes?: number };
}

export interface NativeAgentDisplayTailStoreStats {
  /** Rows parsed and validated. */
  decodes: number;
  /** Reads answered by the decoded cache after revalidation. */
  decodedCacheHits: number;
  /** Row values read from the database. */
  rowReads: number;
  /** Rows written. */
  rowWrites: number;
  /** Serialized bytes written. */
  bytesWritten: number;
  /** Rows removed by the session or byte bound. */
  evictions: number;
  /** Rows removed by deletes. */
  deletedRows: number;
}

interface DecodedEntry {
  /** Store revision the entry was read or written at. */
  revision: number;
  tail: NativeAgentDisplayTail;
  bytes: number;
}

type RowLookup =
  /** The store does not exist. */
  | { kind: "absent" }
  /** The store exists without this key. */
  | { kind: "missing" }
  /** The decoded entry passed in is still current at `revision`. */
  | { kind: "current"; revision: number }
  | { kind: "row"; revision: number; value: string };

export class NativeAgentDisplayTailStore {
  private readonly decoded = new Map<string, DecodedEntry>();
  private decodedBytes = 0;
  private legacyCleanup: Promise<void> | null = null;
  private readonly deletionListeners = new Set<(event: NativeAgentDisplayTailDeletion) => void>();
  private readonly maxSessions: number;
  private readonly maxTotalBytes: number;
  private readonly counters: NativeAgentDisplayTailStoreStats = {
    decodes: 0,
    decodedCacheHits: 0,
    rowReads: 0,
    rowWrites: 0,
    bytesWritten: 0,
    evictions: 0,
    deletedRows: 0,
  };

  constructor(private readonly options: NativeAgentDisplayTailStoreOptions) {
    this.maxSessions = Math.max(1, options.limits?.maxSessions ?? NATIVE_DISPLAY_TAIL_MAX_SESSIONS);
    this.maxTotalBytes = Math.max(
      1,
      options.limits?.maxTotalBytes ?? NATIVE_DISPLAY_TAIL_MAX_TOTAL_BYTES,
    );
  }

  stats(): NativeAgentDisplayTailStoreStats {
    return { ...this.counters };
  }

  /**
   * Deletion fence: an opaque sequence captured when a tail is produced. A
   * write carrying a fence older than a later deletion of its key or
   * environment is refused, so a late checkpoint cannot resurrect a deleted
   * session's preview. The check and the commit run in one synchronous step,
   * so a deletion in any process cannot land between them. Tombstones
   * live in the database; decoded caches remain bounded.
   */
  captureFence(): number {
    return deletionFence(this.options.database());
  }

  isFenceCurrent(key: string, environmentId: string, fence: number): boolean {
    return (
      deletionMarker(this.options.database(), "tail-key", key) <= fence &&
      deletionMarker(this.options.database(), "tail-environment", environmentId) <= fence
    );
  }

  onDeleted(listener: (event: NativeAgentDisplayTailDeletion) => void): () => void {
    this.deletionListeners.add(listener);
    return () => this.deletionListeners.delete(listener);
  }

  private notifyDeleted(event: NativeAgentDisplayTailDeletion): void {
    for (const listener of this.deletionListeners) {
      try {
        listener(event);
      } catch {
        // A scheduler's cleanup hook must never fail the deletion itself.
      }
    }
  }

  private forgetDecoded(key: string): void {
    const entry = this.decoded.get(key);
    if (!entry) return;
    this.decoded.delete(key);
    this.decodedBytes -= entry.bytes;
  }

  private forgetAllDecoded(): void {
    this.decoded.clear();
    this.decodedBytes = 0;
  }

  private rememberDecoded(key: string, entry: DecodedEntry): void {
    this.forgetDecoded(key);
    if (entry.bytes > NATIVE_DISPLAY_TAIL_DECODED_CACHE_MAX_BYTES) return;
    this.decoded.set(key, entry);
    this.decodedBytes += entry.bytes;
    while (
      this.decoded.size > NATIVE_DISPLAY_TAIL_DECODED_CACHE_MAX_ENTRIES ||
      this.decodedBytes > NATIVE_DISPLAY_TAIL_DECODED_CACHE_MAX_BYTES
    ) {
      const oldest = this.decoded.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.forgetDecoded(oldest);
    }
  }

  async get(key: string): Promise<NativeAgentDisplayTail | null> {
    void this.cleanupLegacy();
    const database = this.options.database();
    const cached = this.decoded.get(key);
    const lookup = lookupRow(database, key, cached);
    if (lookup.kind === "absent") {
      // No store at all: nothing decoded earlier can still be current.
      this.forgetAllDecoded();
      return null;
    }
    if (lookup.kind === "current" && cached) {
      this.counters.decodedCacheHits += 1;
      // Refresh recency, and hand out a copy: callers own what they receive.
      this.decoded.delete(key);
      this.decoded.set(key, cached);
      return structuredClone(cached.tail);
    }
    this.forgetDecoded(key);
    if (lookup.kind !== "row") return null;
    this.counters.rowReads += 1;
    const bytes = Buffer.byteLength(lookup.value, "utf8");
    if (bytes > NATIVE_DISPLAY_TAIL_MAX_BYTES) return null;
    this.counters.decodes += 1;
    let tail: unknown;
    try {
      tail = JSON.parse(lookup.value);
    } catch {
      return null;
    }
    if (!isNativeAgentDisplayTail(tail)) return null;
    this.rememberDecoded(key, { revision: lookup.revision, tail, bytes });
    return structuredClone(tail);
  }

  async put(
    key: string,
    tail: NativeAgentDisplayTail,
    options: { fence?: number } = {},
  ): Promise<boolean> {
    void this.cleanupLegacy();
    const fence = options.fence ?? this.captureFence();
    const payload = JSON.stringify(tail);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > NATIVE_DISPLAY_TAIL_MAX_BYTES) return false;
    // Synchronous from here to the commit: a deletion in this process cannot
    // interleave between the fence check and the write.
    if (!this.isFenceCurrent(key, tail.environmentId, fence)) return false;
    let committed: { revision: number; evicted: string[] };
    try {
      const database = this.options.database();
      const result = database.transaction(() => {
        if (!this.isFenceCurrent(key, tail.environmentId, fence)) return null;
        return writeRowInTransaction(database, key, payload, {
          maxSessions: this.maxSessions,
          maxTotalBytes: this.maxTotalBytes,
        });
      });
      if (!result) return false;
      committed = result;
    } catch {
      return false;
    }
    this.counters.rowWrites += 1;
    this.counters.bytesWritten += bytes;
    this.counters.evictions += committed.evicted.length;
    for (const evicted of committed.evicted) this.forgetDecoded(evicted);
    this.rememberDecoded(key, {
      revision: committed.revision,
      tail: structuredClone(tail),
      bytes,
    });
    return true;
  }

  async delete(key: string): Promise<void> {
    this.forgetDecoded(key);
    this.notifyDeleted({ kind: "key", key });
    void this.cleanupLegacy();
    const database = this.options.database();
    const removed = database.transaction(() => {
      markDeletion(database, "tail-key", key);
      return database.rows(STORE).delete(key) ? 1 : 0;
    });
    this.afterDelete(database, removed);
  }

  async deleteByEnvironment(environmentId: string): Promise<void> {
    for (const [key, entry] of Array.from(this.decoded)) {
      if (entry.tail.environmentId === environmentId) this.forgetDecoded(key);
    }
    this.notifyDeleted({ kind: "environment", environmentId });
    void this.cleanupLegacy();
    const database = this.options.database();
    const removed = database.transaction(() => {
      markDeletion(database, "tail-environment", environmentId);
      return database.rows(STORE).deleteWhere({ owner: environmentId });
    });
    this.afterDelete(database, removed);
  }

  private afterDelete(database: StorageDatabase, removed: number): void {
    if (removed === 0) return;
    this.counters.deletedRows += removed;
    database.scrubDeletedContent();
  }

  /**
   * Removes the pre-database tail files once per store instance: the legacy
   * shared file with its backups, lock and crashed temp copies, and the
   * keyed-record directory. Best effort; never rejects.
   */
  cleanupLegacy(): Promise<void> {
    this.legacyCleanup ??= removeLegacyDisplayTailFiles(this.options.legacyRoot).catch(
      () => undefined,
    );
    return this.legacyCleanup;
  }
}

/**
 * Reads the store revision and, unless `cached` is still current (the store
 * did not move since it was read or written), the row. The revision is read
 * first: the row then reflects that revision or a later one, so tagging it
 * with the revision read can only make a later lookup re-read, never trust a
 * stale row.
 */
function lookupRow(
  database: StorageDatabase,
  key: string,
  cached: DecodedEntry | undefined,
): RowLookup {
  const revision = database.storeRevision(STORE);
  if (revision === null) return { kind: "absent" };
  if (cached && cached.revision === revision) return { kind: "current", revision };
  const value = database.rows(STORE).get(key);
  return value === undefined ? { kind: "missing" } : { kind: "row", revision, value };
}

function writeRowInTransaction(
  database: StorageDatabase,
  key: string,
  payload: string,
  limits: { maxSessions: number; maxTotalBytes: number },
): { revision: number; evicted: string[] } {
  let rows = database.rows(STORE);
  let existing = rows.list({ collection: "", values: false });
  if (existing.length === 0 && database.storeRevision(STORE) !== null) {
    // An existing store without rows: empty, or held whole as a document,
    // which is not something this module writes (row writes refuse it). The
    // cache is dropped, not merged; the revision sequence continues.
    database.deleteStoreInTransaction(STORE);
    rows = database.rows(STORE);
    existing = [];
  }
  // Least-recently-written first: `position` is a write sequence, and the
  // written row takes the next one. Evict before the write so the last step
  // of the transaction is the upsert.
  let count = 1;
  let total = Buffer.byteLength(payload, "utf8");
  let next = 0;
  for (const row of existing) {
    next = Math.max(next, row.position + 1);
    if (row.key === key) continue;
    count += 1;
    total += row.bytes;
  }
  const evicted: string[] = [];
  for (const row of existing) {
    if (count <= limits.maxSessions && total <= limits.maxTotalBytes) break;
    if (row.key === key) continue;
    rows.delete(row.key);
    evicted.push(row.key);
    count -= 1;
    total -= row.bytes;
  }
  // The owner column comes from the layout's extractor (the tail's
  // environment), so it always matches the value `get` validates.
  rows.put(key, payload, { position: next });
  return { revision: database.storeRevision(STORE)!, evicted };
}

async function removeLegacyDisplayTailFiles(root: string): Promise<void> {
  const legacy = path.join(root, NATIVE_DISPLAY_TAIL_LEGACY_FILE);
  await fs.rm(path.join(root, NATIVE_DISPLAY_TAIL_LEGACY_RECORD_DIRECTORY), {
    recursive: true,
    force: true,
  });
  await fs.rm(legacy, { force: true });
  await fs.rm(`${legacy}.lock`, { recursive: true, force: true });
  for (let index = 1; index <= MAX_LEGACY_BACKUPS; index += 1) {
    await fs.rm(`${legacy}.bak.${index}`, { force: true });
  }
  const tempPrefix = `.${NATIVE_DISPLAY_TAIL_LEGACY_FILE}.`;
  let scanned = 0;
  try {
    const entries = await fs.opendir(root, { bufferSize: 64 });
    for await (const dirent of entries) {
      if ((scanned += 1) > MAX_LEGACY_TEMP_SCAN) break;
      if (dirent.name.startsWith(tempPrefix) && dirent.name.endsWith(".tmp")) {
        await fs.rm(path.join(root, dirent.name), { force: true });
      }
    }
  } catch {
    // Best effort: a missing data directory has nothing to remove.
  }
}
