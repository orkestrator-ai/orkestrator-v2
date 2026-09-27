import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ByteCountSemaphore,
  AsyncMutex,
  KeyedRecordAdmissionError,
  KeyedSerialQueue,
} from "./keyed-record-concurrency.js";
import {
  KEYED_RECORD_DEFAULT_MAX_HEADER_BYTES,
  KEYED_RECORD_EXTENSION,
  KEYED_RECORD_FORMAT,
  KEYED_RECORD_PREVIOUS_EXTENSION,
  assertValidRecordKey,
  encodeRecordFile,
  ensureNamespaceDirectory,
  isMissingPathError,
  normalizeOwner,
  readRecordFile,
  readRecordHeader,
  recordFileStem,
  sha256Hex,
  statFingerprint,
  syncDirectory,
  tempFileName,
  writeExclusivePrivateFile,
  type KeyedRecordHeader,
  type RecordCorruptReason,
  type RecordRetentionClass,
} from "./keyed-record-format.js";
import {
  KeyedRecordIndexState,
  isPersistedKeyedRecordIndex,
  reconcileIndex,
  type KeyedRecordIndexEntry,
  type ReconcileReport,
} from "./keyed-record-index.js";
import { KEYED_RECORD_META_DIRECTORY, readMetaJson, writeMetaJson } from "./keyed-record-meta.js";
import { KeyedRecordTombstones } from "./keyed-record-tombstones.js";

/**
 * Bounded keyed-record storage: one private file per logical key.
 *
 * Updating or reading one record touches that record's file plus a small
 * metadata index, never its neighbours' payloads. See
 * docs/improvements/efficiency/plan/06-keyed-storage-primitives.md for the
 * design and recovery matrix. Summary of the guarantees:
 *
 * - Reads are lock-free (records are replaced by atomic rename), bounded
 *   before and during buffering, and verify header identity, length and
 *   checksum. Missing and corrupt are distinct outcomes.
 * - Mutations of one key are serialized in-process (and optionally across
 *   processes through the injected lock); different keys progress
 *   concurrently, bounded by a count/byte staging semaphore. None of this uses
 *   the process-global `StorageBase.enqueueWrite` queue.
 * - Admission reserves aggregate bytes under a short quota lock before any
 *   payload is staged and always releases the reservation.
 * - `durable` records fsync file and directory and keep one previous
 *   generation for recovery. `cache` records skip both: a crash may lose the
 *   latest write or leave a corrupt file, which readers report as corrupt
 *   (an explicit miss) and repair removes.
 */

export type KeyedRecordLock = (targetPath: string) => Promise<() => Promise<void>>;

export type KeyedRecordFaultStage =
  | "after-stage"
  | "before-publish"
  | "after-retain-previous"
  | "after-publish"
  | "before-index-commit"
  | "after-delete-current";

export interface KeyedRecordFaults {
  /** Test-only hook. Throw to fail a stage; never resolve to simulate a crash. */
  at?(stage: KeyedRecordFaultStage, detail: { key: string }): void | Promise<void>;
}

export type KeyedRecordIoKind =
  | "payload-read"
  | "header-read"
  | "stat"
  | "payload-write"
  | "checksum"
  | "delete"
  | "evict"
  | "index-read"
  | "index-write";

/** In-process observation hook for tests and counters; never logged. */
export type KeyedRecordObserver = (event: { kind: KeyedRecordIoKind; key?: string }) => void;

export interface KeyedRecordStoreOptions {
  directory: string;
  /** Stable namespace string; part of every filename hash. */
  namespace: string;
  schema: string;
  retentionClass: RecordRetentionClass;
  maxPayloadBytes: number;
  maxRecords: number;
  maxTotalPayloadBytes: number;
  maxHeaderBytes?: number;
  maxConcurrentStaging?: number;
  maxStagingBytes?: number;
  maxQueuedOperations?: number;
  tempGraceMs?: number;
  maxRepairEntries?: number;
  maxTombstones?: number;
  tombstoneTtlMs?: number;
  /** Cross-process lock for short metadata critical sections (quota index, markers). */
  lock?: KeyedRecordLock;
  /** Also take the cross-process lock per key. Recommended for durable records. */
  crossProcessKeyLocks?: boolean;
  now?: () => number;
  faults?: KeyedRecordFaults;
  observer?: KeyedRecordObserver;
}

export type KeyedRecordRead =
  | { status: "missing" }
  | { status: "corrupt"; reason: RecordCorruptReason }
  | { status: "unchanged"; fingerprint: string }
  | {
      status: "found";
      header: KeyedRecordHeader;
      payload: Buffer;
      fingerprint: string;
      generation: "current" | "previous";
    };

export type KeyedRecordWriteResult =
  | { status: "written"; revision: number; fingerprint: string | null; evicted: number }
  | { status: "conflict"; currentRevision: number | null }
  | { status: "rejected"; reason: "too-large" | "quota" | "busy" | "fenced" };

export interface KeyedRecordPutOptions {
  owner?: Record<string, string>;
  /** `null`: only create. A number: only replace that committed revision. */
  expectedRevision?: number | null;
  /** Evaluated inside the key's critical section, before staging and again before publish. */
  fence?: () => boolean | Promise<boolean>;
  updatedAt?: number;
  /** Quota bytes when they differ from the payload length (manifests). */
  accountedBytes?: number;
}

export interface KeyedRecordMetadata extends KeyedRecordIndexEntry {
  stem: string;
}

export interface KeyedRecordStats {
  payloadReads: number;
  headerReads: number;
  payloadWrites: number;
  bytesWritten: number;
  checksums: number;
  deletes: number;
  evictions: number;
  indexWrites: number;
  rejected: number;
}

const DEFAULT_TEMP_GRACE_MS = 60_000;

export class KeyedRecordStore {
  readonly directory: string;
  readonly retentionClass: RecordRetentionClass;
  readonly schema: string;
  readonly namespace: string;
  private readonly maxHeaderBytes: number;
  private readonly keyQueue = new KeyedSerialQueue();
  private readonly staging: ByteCountSemaphore;
  private readonly quotaMutex = new AsyncMutex();
  private readonly maxQueuedOperations: number;
  private queuedOperations = 0;
  private index: KeyedRecordIndexState | null = null;
  private indexFingerprint: string | null = null;
  private indexNeedsReconcile = true;
  private readonly reservations = new Map<symbol, { bytes: number; newKey: boolean }>();
  private reservedBytes = 0;
  private reservedNewKeys = 0;
  private directoryReady: Promise<void> | null = null;
  readonly tombstones: KeyedRecordTombstones;
  private lastReconcile: ReconcileReport | null = null;
  private readonly counters: KeyedRecordStats = {
    payloadReads: 0,
    headerReads: 0,
    payloadWrites: 0,
    bytesWritten: 0,
    checksums: 0,
    deletes: 0,
    evictions: 0,
    indexWrites: 0,
    rejected: 0,
  };

  constructor(private readonly options: KeyedRecordStoreOptions) {
    if (!path.isAbsolute(options.directory)) {
      throw new Error("Keyed record directory must be absolute");
    }
    if (options.maxPayloadBytes < 1 || options.maxRecords < 1 || options.maxTotalPayloadBytes < 1) {
      throw new Error("Keyed record limits must be positive");
    }
    this.directory = options.directory;
    this.retentionClass = options.retentionClass;
    this.schema = options.schema;
    this.namespace = options.namespace;
    this.maxHeaderBytes = options.maxHeaderBytes ?? KEYED_RECORD_DEFAULT_MAX_HEADER_BYTES;
    const recordBytes = this.maxHeaderBytes + 1 + options.maxPayloadBytes;
    this.staging = new ByteCountSemaphore(
      options.maxConcurrentStaging ?? 2,
      options.maxStagingBytes ?? recordBytes * 2,
      options.maxQueuedOperations ?? 256,
    );
    this.maxQueuedOperations = options.maxQueuedOperations ?? 256;
    this.tombstones = new KeyedRecordTombstones({
      file: this.metaPath("tombstones.json"),
      namespace: options.namespace,
      lock: options.lock,
      now: () => this.now(),
      maxEntries: options.maxTombstones ?? 1_024,
      ttlMs: options.tombstoneTtlMs ?? 30 * 24 * 60 * 60 * 1000,
      ensureDirectory: () => this.ensureDirectory(),
    });
  }

  stats(): KeyedRecordStats {
    return { ...this.counters };
  }

  lastReconcileReport(): ReconcileReport | null {
    return this.lastReconcile ? { ...this.lastReconcile } : null;
  }

  stemFor(key: string): string {
    assertValidRecordKey(key);
    return recordFileStem(this.namespace, key);
  }

  metaPath(name: string): string {
    return path.join(this.directory, KEYED_RECORD_META_DIRECTORY, name);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private observe(kind: KeyedRecordIoKind, key?: string): void {
    try {
      this.options.observer?.({ kind, ...(key === undefined ? {} : { key }) });
    } catch {
      // Observation never changes the operation it observes.
    }
  }

  private async fault(stage: KeyedRecordFaultStage, key: string): Promise<void> {
    await this.options.faults?.at?.(stage, { key });
  }

  private currentPath(stem: string): string {
    return path.join(this.directory, `${stem}${KEYED_RECORD_EXTENSION}`);
  }

  private previousPath(stem: string): string {
    return path.join(this.directory, `${stem}${KEYED_RECORD_PREVIOUS_EXTENSION}`);
  }

  private get limits() {
    return { maxHeaderBytes: this.maxHeaderBytes, maxPayloadBytes: this.options.maxPayloadBytes };
  }

  ensureDirectory(): Promise<void> {
    this.directoryReady ??= (async () => {
      await ensureNamespaceDirectory(this.directory);
      await ensureNamespaceDirectory(path.join(this.directory, KEYED_RECORD_META_DIRECTORY));
    })().catch((error) => {
      this.directoryReady = null;
      throw error;
    });
    return this.directoryReady;
  }

  /** Lock-free bounded read of one record; `knownFingerprint` turns it into a stat. */
  async get(key: string, options: { knownFingerprint?: string } = {}): Promise<KeyedRecordRead> {
    const stem = this.stemFor(key);
    const currentPath = this.currentPath(stem);
    if (options.knownFingerprint) {
      this.observe("stat", key);
      const fingerprint = await statFingerprint(currentPath);
      if (fingerprint === options.knownFingerprint) return { status: "unchanged", fingerprint };
    }
    const identity = { schema: this.schema, key, retentionClass: this.retentionClass };
    this.counters.payloadReads += 1;
    this.observe("payload-read", key);
    const read = await readRecordFile(currentPath, identity, this.limits);
    if (
      read.status === "ok" ||
      (read.status === "corrupt" && read.reason === "checksum-mismatch")
    ) {
      this.counters.checksums += 1;
      this.observe("checksum", key);
    }
    if (read.status === "ok") return { ...read, status: "found", generation: "current" };
    // Missing means deleted or never written: a previous generation must not
    // resurrect it. Only a corrupt durable current falls back.
    if (read.status === "missing" || this.retentionClass !== "durable") return read;
    this.counters.payloadReads += 1;
    this.observe("payload-read", key);
    const previous = await readRecordFile(this.previousPath(stem), identity, this.limits);
    if (previous.status === "ok") {
      return { ...previous, status: "found", generation: "previous" };
    }
    return read;
  }

  /** Reads only the current generation, without durable fallback. */
  async getCurrentOnly(key: string): Promise<KeyedRecordRead> {
    this.counters.payloadReads += 1;
    this.observe("payload-read", key);
    const read = await readRecordFile(
      this.currentPath(this.stemFor(key)),
      { schema: this.schema, key, retentionClass: this.retentionClass },
      this.limits,
    );
    return read.status === "ok" ? { ...read, status: "found", generation: "current" } : read;
  }

  /** Reads the previous durable generation explicitly (manifest fallback). */
  async getPrevious(key: string): Promise<KeyedRecordRead> {
    if (this.retentionClass !== "durable") return { status: "missing" };
    const stem = this.stemFor(key);
    this.counters.payloadReads += 1;
    this.observe("payload-read", key);
    const read = await readRecordFile(
      this.previousPath(stem),
      { schema: this.schema, key, retentionClass: this.retentionClass },
      this.limits,
    );
    return read.status === "ok" ? { ...read, status: "found", generation: "previous" } : read;
  }

  private admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queuedOperations >= this.maxQueuedOperations) {
      this.counters.rejected += 1;
      return Promise.reject(new KeyedRecordAdmissionError());
    }
    this.queuedOperations += 1;
    return operation().finally(() => {
      this.queuedOperations -= 1;
    });
  }

  private async withKey<T>(stem: string, operation: () => Promise<T>): Promise<T> {
    return this.keyQueue.run(stem, async () => {
      await this.ensureDirectory();
      const release =
        this.options.crossProcessKeyLocks && this.options.lock
          ? await this.options.lock(this.currentPath(stem))
          : null;
      try {
        return await operation();
      } finally {
        await release?.();
      }
    });
  }

  /**
   * Runs `operation` against the freshest index under the short quota lock.
   * The index is reloaded only when its file fingerprint changed (another
   * process wrote it) and rebuilt from metadata when missing or corrupt.
   * Never performs payload reads.
   */
  private async withQuota<T>(
    operation: (index: KeyedRecordIndexState) => Promise<{ value: T; dirty: boolean }>,
  ): Promise<T> {
    await this.ensureDirectory();
    return this.quotaMutex.run(async () => {
      const indexPath = this.metaPath("index.json");
      const release = this.options.lock ? await this.options.lock(indexPath) : null;
      try {
        let dirty = false;
        const fingerprint = await statFingerprint(indexPath);
        if (!this.index || fingerprint !== this.indexFingerprint) {
          this.observe("index-read");
          const read = await readMetaJson(
            indexPath,
            this.maxIndexBytes(),
            isPersistedKeyedRecordIndex,
          );
          const valid =
            read.status === "ok" &&
            read.value.namespace === this.namespace &&
            read.value.schema === this.schema &&
            read.value.retentionClass === this.retentionClass;
          this.index = valid ? new KeyedRecordIndexState(read.value) : null;
          this.indexFingerprint = valid ? read.fingerprint : null;
          if (!valid) this.indexNeedsReconcile = true;
        }
        if (this.indexNeedsReconcile || !this.index) {
          const { state, report } = await reconcileIndex(this.index, {
            directory: this.directory,
            namespace: this.namespace,
            schema: this.schema,
            retentionClass: this.retentionClass,
            limits: this.limits,
            now: this.now(),
            tempGraceMs: this.options.tempGraceMs ?? DEFAULT_TEMP_GRACE_MS,
            maxEntries: this.options.maxRepairEntries ?? this.options.maxRecords * 4 + 1_024,
            onHeaderRead: (key) => {
              this.counters.headerReads += 1;
              this.observe("header-read", key);
            },
          });
          this.index = state;
          this.lastReconcile = report;
          this.indexNeedsReconcile = false;
          dirty = true;
        }
        const index = this.index;
        const result = await operation(index);
        if (dirty || result.dirty) await this.saveIndex(index);
        return result.value;
      } finally {
        await release?.();
      }
    });
  }

  private maxIndexBytes(): number {
    return this.options.maxRecords * 2_048 + 64 * 1024;
  }

  private async saveIndex(index: KeyedRecordIndexState): Promise<void> {
    try {
      this.indexFingerprint = await writeMetaJson(this.metaPath("index.json"), index.toJSON(), {
        durable: false,
        maxBytes: this.maxIndexBytes(),
      });
      this.counters.indexWrites += 1;
      this.observe("index-write");
    } catch (error) {
      // The in-memory state is still right for this process; force a rebuild
      // from disk metadata before the next decision so nothing drifts.
      this.indexFingerprint = null;
      this.indexNeedsReconcile = true;
      throw error;
    }
  }

  /** Forces a bounded metadata-only reconciliation (startup repair). */
  async repair(): Promise<ReconcileReport> {
    this.indexNeedsReconcile = true;
    await this.withQuota(async () => ({ value: undefined, dirty: false }));
    return this.lastReconcileReport()!;
  }

  /** Metadata-only enumeration from the index; payloads are never read. */
  async list(): Promise<KeyedRecordMetadata[]> {
    return this.withQuota(async (index) => ({
      value: index.entries().map(([stem, entry]) => ({ ...entry, stem })),
      dirty: false,
    }));
  }

  put(
    key: string,
    payload: Buffer | string,
    options: KeyedRecordPutOptions = {},
  ): Promise<KeyedRecordWriteResult> {
    const stem = this.stemFor(key);
    const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    if (bytes.length > this.options.maxPayloadBytes) {
      this.counters.rejected += 1;
      return Promise.resolve({ status: "rejected", reason: "too-large" });
    }
    const owner = normalizeOwner(options.owner);
    return this.admit(() =>
      this.withKey(stem, () => this.putLocked(key, stem, bytes, owner, options)),
    ).catch((error: unknown) => {
      if (error instanceof KeyedRecordAdmissionError) {
        return { status: "rejected", reason: "busy" } as const;
      }
      throw error;
    });
  }

  private async putLocked(
    key: string,
    stem: string,
    payload: Buffer,
    owner: Record<string, string>,
    options: KeyedRecordPutOptions,
  ): Promise<KeyedRecordWriteResult> {
    if (options.fence && !(await options.fence())) {
      this.counters.rejected += 1;
      return { status: "rejected", reason: "fenced" };
    }
    const currentPath = this.currentPath(stem);
    this.counters.headerReads += 1;
    this.observe("header-read", key);
    const current = await readRecordHeader(
      currentPath,
      { schema: this.schema, retentionClass: this.retentionClass, key },
      this.limits,
    );
    const currentRevision = current.status === "ok" ? current.header.revision : null;
    if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
      return { status: "conflict", currentRevision };
    }
    const accountedBytes = options.accountedBytes ?? payload.length;
    const reservation = await this.reserve(stem, accountedBytes, current.status !== "ok");
    if (!reservation) {
      this.counters.rejected += 1;
      return { status: "rejected", reason: "quota" };
    }
    let releaseStaging: (() => void) | null = null;
    const tempPath = path.join(this.directory, tempFileName(stem, randomUUID()));
    try {
      const header: KeyedRecordHeader = {
        format: KEYED_RECORD_FORMAT,
        schema: this.schema,
        key,
        owner,
        revision: Math.max(currentRevision ?? 0, reservation.indexedRevision) + 1,
        byteLength: payload.length,
        checksum: sha256Hex(payload),
        retentionClass: this.retentionClass,
        updatedAt: options.updatedAt ?? this.now(),
        ...(options.accountedBytes === undefined ? {} : { accountedBytes }),
      };
      this.counters.checksums += 1;
      this.observe("checksum", key);
      const contents = encodeRecordFile(header, payload);
      releaseStaging = await this.staging.acquire(contents.length);
      const durable = this.retentionClass === "durable";
      await writeExclusivePrivateFile(tempPath, contents, durable);
      this.counters.payloadWrites += 1;
      this.counters.bytesWritten += contents.length;
      this.observe("payload-write", key);
      await this.fault("after-stage", key);
      // Validate the candidate before it can replace anything.
      const candidate = await readRecordHeader(
        tempPath,
        { schema: this.schema, retentionClass: this.retentionClass, key },
        this.limits,
      );
      if (candidate.status !== "ok" || candidate.header.checksum !== header.checksum) {
        throw new Error("Keyed record candidate failed validation");
      }
      releaseStaging();
      releaseStaging = null;
      if (options.fence && !(await options.fence())) {
        await fs.rm(tempPath, { force: true });
        this.counters.rejected += 1;
        return { status: "rejected", reason: "fenced" };
      }
      await this.fault("before-publish", key);
      if (durable && current.status !== "missing") {
        const verified = await this.getCurrentOnly(key);
        if (verified.status === "found") await this.retainPrevious(stem);
        await this.fault("after-retain-previous", key);
      }
      await fs.rename(tempPath, currentPath);
      if (durable) await syncDirectory(this.directory);
      await this.fault("after-publish", key);
      const evicted = await this.commitIndex(stem, reservation.token, {
        key,
        owner,
        revision: header.revision,
        payloadBytes: accountedBytes,
        diskBytes: contents.length,
        previousBytes: 0,
        updatedAt: header.updatedAt,
        fingerprint: candidate.fingerprint,
      });
      return {
        status: "written",
        revision: header.revision,
        fingerprint: candidate.fingerprint,
        evicted,
      };
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      releaseStaging?.();
      this.releaseReservation(reservation.token);
    }
  }

  /** Hard-links the committed file as the previous generation before replacement. */
  private async retainPrevious(stem: string): Promise<void> {
    const staged = path.join(this.directory, tempFileName(stem, randomUUID()));
    try {
      await fs.link(this.currentPath(stem), staged);
    } catch (error) {
      if (isMissingPathError(error)) return;
      // Filesystems without hard links: copy instead (same bytes, new inode).
      await fs.copyFile(this.currentPath(stem), staged);
      await fs.chmod(staged, 0o600);
    }
    try {
      await fs.rename(staged, this.previousPath(stem));
    } catch (error) {
      await fs.rm(staged, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async reserve(
    stem: string,
    payloadBytes: number,
    newKey: boolean,
  ): Promise<{ token: symbol; indexedRevision: number } | null> {
    return this.withQuota(async (index) => {
      const existing = index.entry(stem);
      const inFlight = this.reservedBytes + payloadBytes;
      let admitted: boolean;
      if (this.retentionClass === "durable") {
        // Durable data is never evicted, so the committed total (including
        // retained previous generations and unclassified files) must fit.
        const replaced = existing ? existing.previousBytes : 0;
        const projected =
          index.totalPayloadBytes +
          index.totalPreviousBytes -
          replaced +
          index.unclassifiedBytes +
          inFlight;
        const count = index.count + this.reservedNewKeys + (existing ? 0 : 1);
        admitted =
          index.complete &&
          projected <= this.options.maxTotalPayloadBytes &&
          count <= this.options.maxRecords;
      } else {
        // Cache admission bounds only what is in flight; commit evicts the
        // oldest records until the committed totals fit again.
        admitted = inFlight <= this.options.maxTotalPayloadBytes;
      }
      if (!admitted) return { value: null, dirty: false };
      const token = Symbol("reservation");
      const isNew = newKey && !existing;
      this.reservations.set(token, { bytes: payloadBytes, newKey: isNew });
      this.reservedBytes += payloadBytes;
      if (isNew) this.reservedNewKeys += 1;
      return { value: { token, indexedRevision: existing?.revision ?? 0 }, dirty: false };
    });
  }

  private releaseReservation(token: symbol): void {
    const reservation = this.reservations.get(token);
    if (!reservation) return;
    this.reservations.delete(token);
    this.reservedBytes -= reservation.bytes;
    if (reservation.newKey) this.reservedNewKeys -= 1;
  }

  private async commitIndex(
    stem: string,
    token: symbol,
    entry: KeyedRecordIndexEntry,
  ): Promise<number> {
    await this.fault("before-index-commit", entry.key);
    try {
      return await this.withQuota(async (index) => {
        this.releaseReservation(token);
        const existing = index.entry(stem);
        index.set(stem, {
          ...entry,
          previousBytes: this.retentionClass === "durable" ? (existing?.diskBytes ?? 0) : 0,
        });
        const evicted = this.retentionClass === "cache" ? await this.evict(index, stem) : 0;
        return { value: evicted, dirty: true };
      });
    } catch {
      // The record is published and readable; only the index is behind.
      // withQuota already scheduled a metadata rebuild for the next decision.
      this.indexNeedsReconcile = true;
      return 0;
    }
  }

  /**
   * Evicts least-recently-written cache records until the committed totals
   * fit. The key just written and keys busy in this process are skipped, so
   * one active key never stalls convergence for the rest.
   */
  private async evict(index: KeyedRecordIndexState, keepStem: string): Promise<number> {
    let evicted = 0;
    while (
      index.count > this.options.maxRecords ||
      index.totalPayloadBytes > this.options.maxTotalPayloadBytes
    ) {
      let victim: [string, KeyedRecordIndexEntry] | null = null;
      for (const candidate of index.entries()) {
        if (candidate[0] === keepStem || this.keyQueue.isBusy(candidate[0])) continue;
        if (!victim || candidate[1].updatedAt < victim[1].updatedAt) victim = candidate;
      }
      if (!victim) break;
      const [stem, entry] = victim;
      await fs.rm(this.currentPath(stem), { force: true });
      await fs.rm(this.previousPath(stem), { force: true });
      index.remove(stem);
      evicted += 1;
      this.counters.evictions += 1;
      this.observe("evict", entry.key);
    }
    return evicted;
  }

  /**
   * Deletes the current record and every retained generation. With
   * `tombstone`, a durable marker is written first so an interrupted delete
   * can never be undone by a legacy import.
   *
   * Deletion is deliberately exempt from the write admission bound: a user's
   * delete must never be dropped because checkpoints saturated the queue. It
   * is still serialized behind the key's in-flight operations.
   */
  delete(key: string, options: { tombstone?: boolean } = {}): Promise<boolean> {
    const stem = this.stemFor(key);
    return this.withKey(stem, async () => {
      if (options.tombstone) await this.tombstones.addKey(stem);
      const currentPath = this.currentPath(stem);
      let existed = true;
      try {
        await fs.unlink(currentPath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        existed = false;
      }
      this.counters.deletes += 1;
      this.observe("delete", key);
      await this.fault("after-delete-current", key);
      await fs.rm(this.previousPath(stem), { force: true });
      if (this.retentionClass === "durable") await syncDirectory(this.directory);
      await this.withQuota(async (index) => ({
        value: undefined,
        dirty: index.remove(stem) !== undefined,
      })).catch(() => {
        this.indexNeedsReconcile = true;
      });
      return existed;
    });
  }

  /**
   * Deletes every indexed record whose metadata matches; payloads are never
   * read. Callers fence new writes first; a write already past its fence when
   * the index was read may still publish, so the in-flight operations are
   * settled and the index is consulted a second time.
   */
  async deleteWhere(
    predicate: (metadata: KeyedRecordMetadata) => boolean,
    options: { tombstone?: boolean } = {},
  ): Promise<number> {
    let deleted = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      if (pass === 1) await this.keyQueue.settled();
      for (const metadata of (await this.list()).filter(predicate)) {
        if (await this.delete(metadata.key, options)) deleted += 1;
      }
    }
    return deleted;
  }

  /** True when `key`'s current file exists (one lstat). */
  async has(key: string): Promise<boolean> {
    return (await statFingerprint(this.currentPath(this.stemFor(key)))) !== null;
  }

  /** Removes the namespace directory entirely (tests and full retirement). */
  async destroy(): Promise<void> {
    await fs.rm(this.directory, { recursive: true, force: true });
    this.directoryReady = null;
    this.index = null;
    this.indexFingerprint = null;
    this.indexNeedsReconcile = true;
  }
}
