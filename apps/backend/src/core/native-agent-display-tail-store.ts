import { promises as fs } from "node:fs";
import path from "node:path";
import { readBoundedFile } from "./keyed-record-format.js";
import {
  markMigrationComplete,
  readMigrationProgress,
  runKeyedRecordMigration,
  type KeyedRecordMigrationEntry,
  type KeyedRecordMigrationOptions,
} from "./keyed-record-migration.js";
import {
  KeyedRecordStore,
  type KeyedRecordFaults,
  type KeyedRecordLock,
  type KeyedRecordObserver,
} from "./keyed-record-store.js";
import {
  NATIVE_DISPLAY_TAIL_MAX_BYTES,
  NATIVE_DISPLAY_TAIL_MAX_SESSIONS,
  NATIVE_DISPLAY_TAIL_MAX_TOTAL_BYTES,
  NATIVE_DISPLAY_TAIL_SCHEMA,
  isNativeAgentDisplayTail,
  type NativeAgentDisplayTail,
} from "./native-agent-display-tails.js";

/**
 * Display tails as independent keyed records (plan step 07, finding E04).
 *
 * Layout under the backend data directory:
 *
 *   native-agent-display-tail-records/
 *     <sha256(namespace, session key)>.rec   one compact tail per session
 *     _meta/index.json                        eviction/quota metadata only
 *     _meta/tombstones.json                   deletions pending legacy retirement
 *     _meta/migration-<id>.json               legacy import progress/completion
 *
 * Reading or writing one tail touches that tail's file plus the small index.
 * Tails remain a regenerable cache: no backups, no fsync, and a corrupt or
 * missing record is simply a miss. The provider stays authoritative.
 *
 * The legacy shared `native-agent-display-tails.json` is imported once by a
 * shared bounded background pass, then retired with its backups.
 */
export const NATIVE_DISPLAY_TAIL_RECORD_DIRECTORY = "native-agent-display-tail-records";
export const NATIVE_DISPLAY_TAIL_RECORD_NAMESPACE = "native-agent-display-tail/v1";
export const NATIVE_DISPLAY_TAIL_LEGACY_MIGRATION_ID = "legacy-native-agent-display-tails-json";
/** The legacy file is pretty-printed; allow its indentation over the 64 MiB compact budget. */
export const NATIVE_DISPLAY_TAIL_LEGACY_MAX_BYTES = 192 * 1024 * 1024;
export const NATIVE_DISPLAY_TAIL_DECODED_CACHE_MAX_ENTRIES = 16;
export const NATIVE_DISPLAY_TAIL_DECODED_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** How long a cold read waits for the one-time import before letting the provider answer. */
export const NATIVE_DISPLAY_TAIL_IMPORT_WAIT_MS = 1_000;
const MAX_FENCE_MEMORY = 4_096;
const MAX_LEGACY_BACKUPS = 5;
const MAX_LEGACY_TEMP_SCAN = 4_096;

export type NativeAgentDisplayTailDeletion =
  | { kind: "key"; key: string }
  | { kind: "environment"; environmentId: string };

export interface NativeAgentDisplayTailStoreOptions {
  directory: string;
  legacyFile: string;
  lock?: KeyedRecordLock;
  now?: () => number;
  importWaitMs?: number;
  legacyMaxBytes?: number;
  observer?: KeyedRecordObserver;
  faults?: KeyedRecordFaults;
  migrationFaults?: KeyedRecordMigrationOptions["faults"];
}

export interface NativeAgentDisplayTailStoreStats {
  decodes: number;
  decodedCacheHits: number;
  importedLegacy: number;
  skippedLegacy: number;
}

interface DecodedEntry {
  fingerprint: string;
  revision: number;
  tail: NativeAgentDisplayTail;
  bytes: number;
}

export class NativeAgentDisplayTailStore {
  readonly records: KeyedRecordStore;
  private readonly decoded = new Map<string, DecodedEntry>();
  private decodedBytes = 0;
  private migration: Promise<void> | null = null;
  private migrated = false;
  private deletionSequence = 0;
  private fenceFloor = 0;
  private readonly keyDeletions = new Map<string, number>();
  private readonly environmentDeletions = new Map<string, number>();
  private readonly deletionListeners = new Set<(event: NativeAgentDisplayTailDeletion) => void>();
  private readonly counters: NativeAgentDisplayTailStoreStats = {
    decodes: 0,
    decodedCacheHits: 0,
    importedLegacy: 0,
    skippedLegacy: 0,
  };

  constructor(private readonly options: NativeAgentDisplayTailStoreOptions) {
    this.records = new KeyedRecordStore({
      directory: options.directory,
      namespace: NATIVE_DISPLAY_TAIL_RECORD_NAMESPACE,
      schema: NATIVE_DISPLAY_TAIL_SCHEMA,
      retentionClass: "cache",
      maxPayloadBytes: NATIVE_DISPLAY_TAIL_MAX_BYTES,
      maxRecords: NATIVE_DISPLAY_TAIL_MAX_SESSIONS,
      maxTotalPayloadBytes: NATIVE_DISPLAY_TAIL_MAX_TOTAL_BYTES,
      ...(options.lock ? { lock: options.lock } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
      ...(options.faults ? { faults: options.faults } : {}),
    });
  }

  stats(): NativeAgentDisplayTailStoreStats {
    return { ...this.counters };
  }

  /**
   * Deletion fence: an opaque sequence captured when a tail is produced. A
   * write carrying a fence older than a later deletion of its key or
   * environment is refused inside the key's critical section, so a late
   * checkpoint cannot resurrect a deleted session's preview. The memory is
   * bounded; a fence older than forgotten deletions is refused conservatively.
   */
  captureFence(): number {
    return this.deletionSequence;
  }

  isFenceCurrent(key: string, environmentId: string, fence: number): boolean {
    return (
      fence >= this.fenceFloor &&
      (this.keyDeletions.get(key) ?? 0) <= fence &&
      (this.environmentDeletions.get(environmentId) ?? 0) <= fence
    );
  }

  onDeleted(listener: (event: NativeAgentDisplayTailDeletion) => void): () => void {
    this.deletionListeners.add(listener);
    return () => this.deletionListeners.delete(listener);
  }

  private recordDeletion(map: Map<string, number>, id: string): void {
    this.deletionSequence += 1;
    map.delete(id);
    map.set(id, this.deletionSequence);
    while (map.size > MAX_FENCE_MEMORY) {
      const oldest = map.entries().next().value as [string, number] | undefined;
      if (!oldest) break;
      map.delete(oldest[0]);
      this.fenceFloor = Math.max(this.fenceFloor, oldest[1]);
    }
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
    await this.waitForMigration(this.options.importWaitMs ?? NATIVE_DISPLAY_TAIL_IMPORT_WAIT_MS);
    const cached = this.decoded.get(key);
    const read = await this.records.get(
      key,
      cached ? { knownFingerprint: cached.fingerprint } : {},
    );
    if (read.status === "unchanged" && cached) {
      this.counters.decodedCacheHits += 1;
      // Refresh recency, and hand out a copy: callers own what they receive.
      this.decoded.delete(key);
      this.decoded.set(key, cached);
      return structuredClone(cached.tail);
    }
    if (read.status !== "found") {
      this.forgetDecoded(key);
      return null;
    }
    this.counters.decodes += 1;
    let tail: unknown;
    try {
      tail = JSON.parse(read.payload.toString("utf8"));
    } catch {
      return null;
    }
    if (
      !isNativeAgentDisplayTail(tail) ||
      read.header.owner.environmentId !== tail.environmentId ||
      read.header.owner.agent !== tail.agent
    ) {
      return null;
    }
    this.rememberDecoded(key, {
      fingerprint: read.fingerprint,
      revision: read.header.revision,
      tail,
      bytes: read.payload.length,
    });
    return structuredClone(tail);
  }

  async put(
    key: string,
    tail: NativeAgentDisplayTail,
    options: { fence?: number } = {},
  ): Promise<boolean> {
    // Start (never await) the one-time import: its create-only writes can
    // never overwrite this newer live checkpoint.
    void this.ensureMigration();
    const fence = options.fence ?? this.captureFence();
    const payload = JSON.stringify(tail);
    try {
      const result = await this.records.put(key, payload, {
        owner: { environmentId: tail.environmentId, agent: tail.agent },
        fence: () => this.isFenceCurrent(key, tail.environmentId, fence),
      });
      if (result.status !== "written") return false;
      if (result.fingerprint) {
        this.rememberDecoded(key, {
          fingerprint: result.fingerprint,
          revision: result.revision,
          tail: structuredClone(tail),
          bytes: Buffer.byteLength(payload),
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    this.recordDeletion(this.keyDeletions, key);
    this.forgetDecoded(key);
    this.notifyDeleted({ kind: "key", key });
    await this.records.delete(key, { tombstone: !(await this.isMigrationComplete()) });
  }

  async deleteByEnvironment(environmentId: string): Promise<void> {
    this.recordDeletion(this.environmentDeletions, environmentId);
    for (const [key, entry] of Array.from(this.decoded)) {
      if (entry.tail.environmentId === environmentId) this.forgetDecoded(key);
    }
    this.notifyDeleted({ kind: "environment", environmentId });
    if (!(await this.isMigrationComplete())) {
      await this.records.tombstones.addOwner("environmentId", environmentId);
    }
    await this.records.deleteWhere((metadata) => metadata.owner.environmentId === environmentId);
  }

  private async isMigrationComplete(): Promise<boolean> {
    if (this.migrated) return true;
    const progress = await readMigrationProgress(
      this.records,
      NATIVE_DISPLAY_TAIL_LEGACY_MIGRATION_ID,
    ).catch(() => null);
    return progress?.completedAt !== undefined;
  }

  /** Waits for the shared import at most `waitMs`; the provider covers the rest. */
  async waitForMigration(waitMs: number): Promise<void> {
    if (this.migrated) return;
    const migration = this.ensureMigration();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      migration,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** One shared import per store; failures are retried on a later call. */
  ensureMigration(): Promise<void> {
    if (this.migrated) return Promise.resolve();
    this.migration ??= this.migrateLegacy()
      .then(() => {
        this.migrated = true;
      })
      .catch(() => undefined)
      .finally(() => {
        this.migration = null;
      });
    return this.migration;
  }

  private async migrateLegacy(): Promise<void> {
    const id = NATIVE_DISPLAY_TAIL_LEGACY_MIGRATION_ID;
    if ((await readMigrationProgress(this.records, id))?.completedAt !== undefined) {
      // An older binary may have recreated the legacy file after migration.
      // It is never read again, so retire it rather than retain stale content.
      await this.retireLegacy();
      return;
    }
    // Serialize with any legacy writer and with other backends importing.
    const release = this.options.lock ? await this.options.lock(this.options.legacyFile) : null;
    try {
      if ((await readMigrationProgress(this.records, id))?.completedAt !== undefined) {
        await this.retireLegacy();
        return;
      }
      const source = await this.readLegacySource();
      const tombstones = await this.records.tombstones.read();
      if (source && !tombstones.overflowed) {
        const result = await runKeyedRecordMigration(this.records, {
          id,
          sourceFingerprint: source.fingerprint,
          entries: () => source.entries,
          maxEntries: NATIVE_DISPLAY_TAIL_MAX_SESSIONS,
          ...(this.options.now ? { now: this.options.now } : {}),
          ...(this.options.migrationFaults ? { faults: this.options.migrationFaults } : {}),
        });
        this.counters.importedLegacy += result.imported;
        this.counters.skippedLegacy +=
          result.invalid + result.truncated + result.rejected + result.tombstoned;
      } else {
        // Absent, oversized, unreadable, or tombstone protection overflowed:
        // the preview cache is dropped rather than imported unsafely.
        await markMigrationComplete(
          this.records,
          id,
          source?.fingerprint ?? "absent",
          this.options.now?.() ?? Date.now(),
        );
      }
      await this.retireLegacy();
    } finally {
      await release?.();
    }
  }

  /**
   * Bounded read of the legacy shared file. Entries are validated with the
   * existing v1/v2 validators, re-checked against the per-record size limit,
   * and ordered newest first so the aggregate record bound keeps the most
   * useful previews. Invalid or oversized entries are yielded as `null`.
   */
  private async readLegacySource(): Promise<{
    fingerprint: string;
    entries: Array<KeyedRecordMigrationEntry | null>;
  } | null> {
    const read = await readBoundedFile(
      this.options.legacyFile,
      this.options.legacyMaxBytes ?? NATIVE_DISPLAY_TAIL_LEGACY_MAX_BYTES,
    );
    if (read.status !== "ok") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.bytes.toString("utf8"));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const valid: Array<{ entry: KeyedRecordMigrationEntry; updatedAt: number }> = [];
    let invalid = 0;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length === 0 || !isNativeAgentDisplayTail(value)) {
        invalid += 1;
        continue;
      }
      const payload = JSON.stringify(value);
      if (Buffer.byteLength(payload) > NATIVE_DISPLAY_TAIL_MAX_BYTES) {
        invalid += 1;
        continue;
      }
      const updatedAt = Date.parse(value.updatedAt);
      valid.push({
        entry: {
          key,
          payload,
          owner: { environmentId: value.environmentId, agent: value.agent },
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
        },
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      });
    }
    valid.sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.entry.key.localeCompare(right.entry.key),
    );
    return {
      fingerprint: read.fingerprint,
      entries: [...valid.map((item) => item.entry), ...Array.from({ length: invalid }, () => null)],
    };
  }

  /**
   * Removes the legacy file, its rotated sensitive backups and any crashed
   * temporary copies, then retires tombstones: with no legacy source left,
   * nothing can resurrect a deleted record.
   */
  private async retireLegacy(): Promise<void> {
    const legacy = this.options.legacyFile;
    await fs.rm(legacy, { force: true });
    for (let index = 1; index <= MAX_LEGACY_BACKUPS; index += 1) {
      await fs.rm(`${legacy}.bak.${index}`, { force: true });
    }
    const directory = path.dirname(legacy);
    const tempPrefix = `.${path.basename(legacy)}.`;
    let scanned = 0;
    try {
      const entries = await fs.opendir(directory, { bufferSize: 64 });
      for await (const dirent of entries) {
        if ((scanned += 1) > MAX_LEGACY_TEMP_SCAN) break;
        if (dirent.name.startsWith(tempPrefix) && dirent.name.endsWith(".tmp")) {
          await fs.rm(path.join(directory, dirent.name), { force: true });
        }
      }
    } catch {
      // Best effort: a missing data directory has nothing to retire.
    }
    const tombstones = await this.records.tombstones.read();
    if (
      Object.keys(tombstones.keys).length > 0 ||
      Object.keys(tombstones.owners).length > 0 ||
      tombstones.overflowed
    ) {
      await this.records.tombstones.retireAll();
    }
  }
}
