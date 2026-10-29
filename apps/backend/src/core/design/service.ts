import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DESIGN_EVENT,
  DESIGN_MAX_CANVASES,
  DESIGN_MAX_DOCUMENT_BYTES,
  type DesignCanvas,
  type DesignCanvasState,
  type DesignChange,
  type DesignChanges,
  type DesignElement,
  type DesignFrame,
  type DesignHierarchyPage,
  type DesignHistoryStatus,
  type DesignOperation,
} from "@orkestrator/protocol/design-canvas";
import {
  DESIGN_LIMITS,
  DESIGN_PROTOCOL_VERSION,
  DESIGN_RESPONSE_VERSION,
  DESIGN_TERMINAL_STATES,
  type DesignActor,
  type DesignCapabilities,
  type DesignCheckpointPreview,
  type DesignFailure,
  type DesignHistoryPage,
  type DesignLibraryPage,
  type DesignLibraryQuery,
  type DesignOperationDescriptor,
  type DesignOperationInput,
  type DesignOperationStatus,
  type DesignPrepareResult,
  type DesignReadiness,
  type DesignSessionLink,
  type DesignSessionLinkStates,
  type DesignSessionResumeResult,
  type DesignSnapshotResult,
  type DesignSyncResult,
} from "@orkestrator/protocol/design-operations";
import { applyComputed, verifyComputed } from "./apply.js";
import { CANVAS_LEASE, DesignCoordination, GLOBAL_LEASE } from "./coordination.js";
import { DesignError, designConflict, reusedCorrelation, toDesignFailure } from "./errors.js";
import { computeOperation, type ComputedOperation, type RenderPriority } from "./execute.js";
import {
  appendEntry,
  checkpointPreview,
  collectOrphans,
  deleteCheckpoints,
  dropOldestUnprotected,
  gestureMergeTarget,
  historyPage,
  historyStatus,
  PROTECTED_HISTORY_ENTRIES,
  readCheckpoint,
  writeCheckpoint,
} from "./history.js";
import { DesignLibraryIndex, summarizeRecord, type DesignSummary } from "./library.js";
import * as sessionLinks from "./session-links.js";
import type {
  DesignNativeSessionLookup,
  DesignSessionLinkInput,
  DesignSessionResumer,
} from "./session-links.js";
import {
  addReceipt,
  cloneRecord,
  descriptorDigest,
  intentDigest,
  migrateLegacy,
  portableBytes,
  receiptDigest,
  settledMatches,
  DesignRecordStore,
  type DesignHistoryEntryRecord,
  type DesignPendingOperation,
  type DesignPrivateRecord,
  type DesignStorageFaults,
} from "./records.js";
import { DesignProfileLedger } from "./browser-profiles.js";
import { DesignRenderer } from "./renderer.js";
import { descriptorSchema, designId, operationToken, revision } from "./schemas.js";
import { buildSync, snapshotEnvelope, tombstone } from "./sync.js";
import * as lifecycle from "./service-lifecycle.js";
import * as validation from "./validation.js";

// Portable schemas remain importable from their historic module.
export { canvasSchema, designId, frameSchema, htmlSchema, revision } from "./schemas.js";

export interface DesignServiceOptions {
  now?: () => Date;
  faults?: DesignStorageFaults;
  /** Bytes of committed records kept in memory; disk remains authoritative. */
  recordCacheBytes?: number;
  /** How long an execute request waits before answering `executing`. */
  executeWaitMs?: number;
}

export type LoadedRecord =
  | { kind: "record"; record: DesignPrivateRecord; legacy: boolean }
  | { kind: "missing" }
  | {
      kind: "problem";
      problem: "corrupt" | "unsupported-version";
      message: string;
      backupAvailable: boolean;
    };

/** The renderer surface the service depends on; tests substitute a DOM-emulated runtime. */
export type DesignRendererLike = Pick<
  DesignRenderer,
  "run" | "status" | "probe" | "close" | "invalidateHealth"
> &
  Partial<Pick<DesignRenderer, "sweepStaleProfiles">>;

/** Ledger of design browser profiles, under the data directory (see browser-profiles.ts). */
export const DESIGN_BROWSER_PROFILES_DIRECTORY = "design-browser-profiles";

interface Lane {
  tail: Promise<unknown>;
  depth: number;
}

export interface DesignMetrics {
  operations: Record<string, number>;
  renders: number;
  renderMs: number;
  commits: number;
  commitBytes: number;
  commitMs: number;
  noops: number;
  conflicts: number;
}

const INTERRUPTED_FAILURE: DesignFailure = {
  code: "unknown-outcome",
  message:
    "The backend restarted before this edit committed. It was not applied; review and submit it again.",
  retry: "review",
};

/**
 * Backend-owned design documents. Every document change and its terminal
 * operation receipt become authoritative together in one atomic record
 * replacement. Rendering never happens while a canvas lane or the global
 * guard is held.
 *
 * Lock order: global guard, then one canvas lane. Never wait for the renderer
 * or for the global guard while holding a lane. Both are cross-process: a lane
 * holds the canvas's database lease and the global guard holds the library
 * lease (see `design/coordination.ts`), so another backend sharing the data
 * directory is serialized too. Every cached record is revalidated against
 * the file's identity before use, so a lane always works on the latest record.
 */
export class DesignService {
  readonly generation = randomUUID();
  readonly store: DesignRecordStore;
  readonly library: DesignLibraryIndex;
  readonly metrics: DesignMetrics = {
    operations: {},
    renders: 0,
    renderMs: 0,
    commits: 0,
    commitBytes: 0,
    commitMs: 0,
    noops: 0,
    conflicts: 0,
  };
  private readonly lanes = new Map<string, Lane>();
  private globalTail: Promise<unknown> = Promise.resolve();
  private admitted = 0;
  private admittedBytes = 0;
  private readonly admittedByCanvas = new Map<string, number>();
  private readonly running = new Map<string, Promise<DesignOperationStatus>>();
  private readonly runningOwner = new Map<string, string>();
  private readonly cache = new Map<
    string,
    { record: DesignPrivateRecord; bytes: number; key: string }
  >();
  readonly coordination: DesignCoordination;
  /** Change-signal revision the library index reflects; undefined before the first scan. */
  private libraryRevision: number | undefined;
  private libraryScan: Promise<void> | undefined;
  private cacheBytes = 0;
  /** Environments being deleted: no work may commit into them. */
  readonly fences = new Set<string>();
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private closed = false;
  private readonly background = new Set<Promise<unknown>>();
  readonly now: () => Date;
  private readonly recordCacheBytes: number;
  private readonly executeWaitMs: number;
  constructor(
    dataDir: string,
    private readonly emit: (event: string, payload: unknown) => void,
    readonly renderer: DesignRendererLike = new DesignRenderer({
      profiles: new DesignProfileLedger(join(dataDir, DESIGN_BROWSER_PROFILES_DIRECTORY)),
    }),
    options: DesignServiceOptions = {},
  ) {
    this.store = new DesignRecordStore(dataDir, options.faults);
    this.library = new DesignLibraryIndex(this.store.root);
    this.coordination = new DesignCoordination(dataDir, this.generation);
    this.now = options.now ?? (() => new Date());
    this.recordCacheBytes = options.recordCacheBytes ?? 48 * 1024 * 1024;
    this.executeWaitMs = options.executeWaitMs ?? 50_000;
  }

  // -------------------------------------------------------------------------
  // Infrastructure
  // -------------------------------------------------------------------------

  capabilities(): DesignCapabilities {
    return {
      protocolVersion: DESIGN_PROTOCOL_VERSION,
      responseVersion: DESIGN_RESPONSE_VERSION,
      snapshot: true,
      operations: true,
      sync: true,
      save: true,
      history: true,
      lifecycle: true,
      rendererHealth: true,
      library: true,
      batch: true,
      sessions: true,
      validation: true,
      hierarchyPaging: true,
    };
  }

  iso(): string {
    return this.now().toISOString();
  }

  /** Tracks fire-and-forget work so close() can settle it and nothing rejects unhandled. */
  track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      console.warn("[backend] Design background task failed:", toDesignFailure(error).code);
    });
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  lane<T>(canvasId: string, work: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(canvasId);
    if (!lane) {
      lane = { tail: Promise.resolve(), depth: 0 };
      this.lanes.set(canvasId, lane);
    }
    const current = lane;
    current.depth++;
    const run = current.tail.then(() =>
      this.coordination.exclusive(
        `design-canvases/${canvasId}`,
        "design canvas",
        CANVAS_LEASE,
        work,
      ),
    );
    current.tail = run.catch(() => undefined);
    return run.finally(() => {
      current.depth--;
      if (current.depth === 0 && this.lanes.get(canvasId) === current) this.lanes.delete(canvasId);
    });
  }

  global<T>(work: () => Promise<T>): Promise<T> {
    const run = this.globalTail.then(() =>
      this.coordination.exclusive("design-canvases", "design library", GLOBAL_LEASE, work),
    );
    this.globalTail = run.catch(() => undefined);
    return run;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= (async () => {
      await this.store.ensure();
      await this.coordination.start();
      const persisted = await this.library.load();
      const revision = this.coordination.libraryRevision();
      await this.rescanLibrary(persisted);
      this.libraryRevision = revision;
      // Each recovery step degrades independently: one bad file must not make
      // every design unavailable.
      await this.startupStep("pending recovery", () => this.recoverPending());
      await this.startupStep("state recovery", () => this.recoverStartupState());
      await this.startupStep("reservation expiry", () => lifecycle.expireProvisional(this));
      await this.startupStep("recycle bin", () => lifecycle.enforceRecycleBin(this));
      // Checkpoints written before a crash but never referenced are collected
      // in the background (age-gated so an in-progress writer is never raced).
      this.track(this.collectStartupOrphans());
      this.track(this.sweepStaleBrowserProfiles());
      this.library.persistSoon();
      this.initialized = true;
    })().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
  }

  /**
   * Brings the library index up to date with every process's changes. Cheap
   * when nothing changed (one database read); otherwise a directory scan that
   * re-reads only records whose file identity moved.
   */
  async refreshLibrary(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.libraryScan) {
        await this.libraryScan;
        continue;
      }
      const revision = this.coordination.libraryRevision();
      if (revision === this.libraryRevision && !this.coordination.libraryDirty()) return;
      const scan = this.rescanLibrary()
        .then(() => {
          // A change signalled during the scan leaves the signal ahead: the
          // next refresh scans again.
          this.libraryRevision = revision;
        })
        .catch((error: unknown) => {
          console.warn("[backend] Design library refresh failed:", toDesignFailure(error).code);
        })
        .finally(() => {
          if (this.libraryScan === scan) this.libraryScan = undefined;
        });
      this.libraryScan = scan;
      await scan;
      return;
    }
  }

  private async rescanLibrary(persisted?: Map<string, DesignSummary>): Promise<void> {
    const ids = (await this.store.ids()).slice(0, 4096);
    const present = new Set(ids);
    for (const id of Array.from(this.library.entries.keys())) {
      // A canvas committed after the directory listing is still on disk.
      if (!present.has(id) && !(await this.store.fileStat(id))) this.library.entries.delete(id);
    }
    let index = 0;
    const worker = async () => {
      while (index < ids.length) {
        const id = ids[index++]!;
        await this.indexCanvas(id, this.library.entries.get(id) ?? persisted?.get(id));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
    this.library.persistSoon();
  }

  private async indexCanvas(id: string, cached: DesignSummary | undefined): Promise<void> {
    const file = await this.store.fileStat(id);
    if (!file) {
      this.library.entries.delete(id);
      return;
    }
    if (
      cached &&
      cached.fileKey === file.key &&
      Boolean(cached.legacy) === (file.kind === "legacy")
    ) {
      this.library.entries.set(id, cached);
      return;
    }
    const read = await this.store.read(id);
    if (read.kind === "record") {
      this.library.entries.set(
        id,
        summarizeRecord(read.record, { size: read.bytes, mtimeMs: file.mtimeMs, key: read.key }),
      );
    } else if (read.kind === "missing") {
      this.library.entries.delete(id);
    } else if (read.kind === "legacy") {
      this.library.entries.set(
        id,
        summarizeRecord(migrateLegacy(read.canvas, read.mtime), file, true),
      );
    } else if (read.kind === "problem") {
      const environmentId = await lifecycle.problemEnvironment(this, id);
      console.warn(`[backend] Design canvas needs recovery: ${read.problem}`);
      this.library.entries.set(id, {
        id,
        environmentId: environmentId ?? "",
        name: "Design needing recovery",
        revision: 0,
        createdAt: new Date(file.mtimeMs).toISOString(),
        modifiedAt: new Date(file.mtimeMs).toISOString(),
        frameCount: 0,
        state: "problem",
        problem: read.problem,
        invalid: 0,
        unvalidated: 0,
        historyBytes: 0,
        recordBytes: file.size,
        fileSize: file.size,
        fileMtimeMs: file.mtimeMs,
        fileKey: file.key,
      });
    }
  }

  /**
   * Finishes work a previous process may have left half done:
   * - an interrupted migration (record committed, legacy file still in place)
   *   retires the verified legacy copy to the bounded backup directory;
   * - an export still marked "writing" by a process that is no longer alive
   *   has an unknown outcome until reconciled against the destination (a live
   *   backend sharing the data directory may still be writing its own).
   */
  private async recoverStartupState(): Promise<void> {
    for (const id of await this.store.legacyAlongsideRecords()) {
      await this.store.retireLegacy(id).catch(() => undefined);
    }
    for (const summary of Array.from(this.library.entries.values())) {
      if (!summary.exportPending) continue;
      await this.lane(summary.id, async () => {
        const loaded = await this.load(summary.id);
        if (loaded.kind !== "record" || loaded.legacy) return;
        const pending = loaded.record.pendingExport;
        if (pending?.state !== "writing" || this.exportWriterAlive(loaded.record)) return;
        const next = cloneRecord(loaded.record);
        next.pendingExport = {
          ...pending,
          state: "unknown",
          failure: {
            code: "unknown-outcome",
            message:
              "The backend stopped during this export. Check the file before exporting again.",
            retry: "review",
          },
        };
        next.statusVersion++;
        await this.commit(next, false);
      });
    }
  }

  private async startupStep(label: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      console.warn(`[backend] Design ${label} failed:`, toDesignFailure(error).code);
    }
  }

  /**
   * Admitted work that has no terminal receipt and whose owning process is no
   * longer alive did not commit: report it interrupted (or, for a duplicate
   * whose copy exists, committed). Entries owned by a live backend sharing the
   * data directory are left alone.
   */
  private async recoverPending(): Promise<void> {
    for (const id of await this.store.pendingIds()) {
      await this.startupStep("pending recovery for one design", () => this.recoverPendingFor(id));
    }
  }

  /** Whether another live service instance owns this pending entry. */
  ownedElsewhere(entry: Pick<DesignPendingOperation, "owner">): boolean {
    return entry.owner !== this.generation && this.coordination.isAlive(entry.owner);
  }

  /** Whether another live process may still be writing the record's pending export. */
  exportWriterAlive(record: DesignPrivateRecord): boolean {
    return !!record.pendingExport && this.coordination.exportAlive(record.pendingExport.token);
  }

  private async recoverPendingFor(id: string): Promise<void> {
    await this.lane(id, async () => {
      const entries = await this.store.readPending(id);
      if (!entries.length) return;
      const kept = entries.filter((entry) => this.ownedElsewhere(entry));
      const loaded = await this.load(id);
      if (loaded.kind !== "record") {
        if (kept.length !== entries.length) await this.store.writePending(id, kept);
        return;
      }
      // A never-migrated canvas has nowhere to keep a receipt, and recovery
      // must not migrate it: its dead owners' entries stay as their outcomes
      // (see `retainedOutcomes`).
      if (loaded.legacy) return;
      const record = cloneRecord(loaded.record);
      const settled = new Set(record.receipts.map((receipt) => receipt.token));
      let changed = false;
      for (const entry of entries) {
        if (settled.has(entry.token) || kept.includes(entry)) continue;
        addReceipt(record, await this.deadOutcome(entry), entry.descriptor);
        changed = true;
      }
      if (changed && record.state !== "provisional") {
        record.statusVersion++;
        await this.commit(record, false);
      }
      const remaining = kept.filter((entry) => !settled.has(entry.token));
      if (remaining.length !== entries.length) await this.store.writePending(id, remaining);
    });
  }

  // -------------------------------------------------------------------------
  // Record access and commits
  // -------------------------------------------------------------------------

  /** Committed record (never mutate); legacy documents are migrated in memory. */
  async load(id: string): Promise<LoadedRecord> {
    designId.parse(id);
    const cached = this.cache.get(id);
    if (cached) {
      // Another process may have committed (or removed) the record: the cache
      // is trusted only while the file is exactly the one it was read from.
      const file = await this.store.recordStat(id);
      if (file?.key === cached.key && this.cache.get(id) === cached) {
        this.cache.delete(id);
        this.cache.set(id, cached);
        return { kind: "record", record: cached.record, legacy: false };
      }
      if (this.cache.get(id) === cached) this.forget(id);
    }
    const read = await this.store.read(id);
    if (read.kind === "record") {
      this.remember(read.record, read.bytes, read.key);
      return { kind: "record", record: read.record, legacy: false };
    }
    if (read.kind === "legacy")
      return { kind: "record", record: migrateLegacy(read.canvas, read.mtime), legacy: true };
    return read;
  }

  environmentDeleted(environmentId: string): boolean {
    return this.fences.has(environmentId) || this.coordination.environmentDeleted(environmentId);
  }

  /** Loads a canvas the environment may see. Other environments get `not-found`. */
  async loadFor(
    id: string,
    environmentId: string,
    options: { allowDeleted?: boolean; allowProvisional?: boolean } = {},
  ): Promise<{ record: DesignPrivateRecord; legacy: boolean }> {
    designId.parse(id);
    if (this.environmentDeleted(environmentId))
      throw new DesignError("not-found", "Canvas not found in this environment");
    const loaded = await this.load(id);
    if (loaded.kind === "missing")
      throw new DesignError("not-found", "Canvas not found in this environment");
    // A record from another environment is "not found", even when unreadable.
    if (loaded.kind === "problem" && (await this.problemOwner(id)) !== environmentId)
      throw new DesignError("not-found", "Canvas not found in this environment");
    if (loaded.kind === "problem")
      throw new DesignError("storage", loaded.message, {
        retry: "never",
        details: { problem: loaded.problem },
      });
    if (loaded.record.environmentId !== environmentId)
      throw new DesignError("not-found", "Canvas not found in this environment");
    if (loaded.record.state === "deleted" && !options.allowDeleted)
      throw new DesignError("deleted", "This design was deleted", {
        retry: "never",
        target: { canvasId: id },
      });
    if (loaded.record.state === "provisional" && !options.allowProvisional)
      throw new DesignError("not-found", "Canvas not found in this environment");
    return { record: loaded.record, legacy: loaded.legacy };
  }

  /** Environment of an unreadable record, also when another process created it. */
  private async problemOwner(id: string): Promise<string | undefined> {
    const summary = this.library.entries.get(id);
    if (summary?.environmentId) return summary.environmentId;
    return lifecycle.problemEnvironment(this, id);
  }

  private remember(record: DesignPrivateRecord, bytes: number, key: string) {
    const previous = this.cache.get(record.canvasId);
    if (previous) this.cacheBytes -= previous.bytes;
    this.cache.delete(record.canvasId);
    this.cache.set(record.canvasId, { record, bytes, key });
    this.cacheBytes += bytes;
    for (const [id, entry] of this.cache) {
      if (this.cacheBytes <= this.recordCacheBytes || this.cache.size <= 1) break;
      if (id === record.canvasId) continue;
      this.cache.delete(id);
      this.cacheBytes -= entry.bytes;
    }
  }

  forget(id: string) {
    const entry = this.cache.get(id);
    if (entry) this.cacheBytes -= entry.bytes;
    this.cache.delete(id);
  }

  /**
   * Atomically replaces the record, then publishes. Callers hold the canvas
   * lane. `record` must be a private clone; it becomes the cached committed copy.
   */
  async commit(
    record: DesignPrivateRecord,
    legacy: boolean,
    hint?: Omit<DesignChange, "canvasId">,
  ): Promise<void> {
    if (this.environmentDeleted(record.environmentId))
      throw new DesignError("not-found", "Canvas not found in this environment");
    if (legacy) await this.keepRetainedOutcomes(record);
    this.coordination.beginLibraryChange(record.canvasId);
    const started = performance.now();
    record.sequence++;
    let bytes: number;
    try {
      bytes = await this.store.write(record);
    } catch (error) {
      // The replacement may or may not have happened; only disk is authoritative now.
      this.forget(record.canvasId);
      throw error;
    }
    this.metrics.commits++;
    this.metrics.commitBytes += bytes;
    this.metrics.commitMs += performance.now() - started;
    // The lane's lease is held, so the file is still exactly what we wrote.
    const written = await this.store.recordStat(record.canvasId);
    if (written) this.remember(record, bytes, written.key);
    else this.forget(record.canvasId);
    if (legacy) {
      await this.store.retireLegacy(record.canvasId).catch((error: unknown) => {
        console.warn(
          "[backend] Could not retire a migrated legacy design:",
          (error as NodeJS.ErrnoException)?.code,
        );
      });
    }
    this.library.upsert(summarizeRecord(record, written ?? { size: bytes, mtimeMs: Date.now() }));
    this.libraryChanged(record.canvasId);
    if (hint) this.publish({ canvasId: record.canvasId, ...hint });
  }

  /**
   * The commit that migrates a never-migrated canvas records its retained
   * outcomes as receipts. An unreadable pending file leaves them pending: a
   * later restart's recovery records them instead.
   */
  private async keepRetainedOutcomes(record: DesignPrivateRecord): Promise<void> {
    const pending = await this.store.readPending(record.canvasId).catch(() => []);
    for (const entry of this.retainedOutcomes(record, pending))
      addReceipt(record, await this.deadOutcome(entry), entry.descriptor);
  }

  /** Removes a canvas from the index after its files were removed. */
  libraryRemoved(id: string) {
    this.library.remove(id);
    this.libraryChanged(id);
  }

  /** Tells every process sharing the data directory that the canvases changed. */
  private libraryChanged(canvasId: string) {
    const signal = this.coordination.signalLibraryChange();
    if (signal) {
      try {
        this.coordination.finishLibraryChange(canvasId);
      } catch {
        /* Keep recovery intent. */
      }
    }
    // Our index already holds our own change; it stays current only if no
    // other process moved the signal since our last scan.
    if (signal && !this.libraryScan && signal.before === this.libraryRevision)
      this.libraryRevision = signal.after;
  }

  publish(change: DesignChange) {
    // Content-free bounded hints; clients read snapshots/deltas and detect gaps.
    this.emit(DESIGN_EVENT, { ...change, generation: this.generation });
  }

  receipt(
    entry: Pick<
      DesignPendingOperation,
      "token" | "canvasId" | "descriptor" | "actor" | "preparedAt"
    >,
    state: DesignOperationStatus["state"],
    extra: Partial<DesignOperationStatus> = {},
  ): DesignOperationStatus {
    return {
      token: entry.token,
      canvasId: entry.canvasId,
      kind: entry.descriptor.input.kind,
      state,
      actor: entry.actor,
      base: entry.descriptor.preconditions,
      ...(entry.descriptor.gestureId ? { gestureId: entry.descriptor.gestureId } : {}),
      ...(entry.descriptor.correlationId ? { correlationId: entry.descriptor.correlationId } : {}),
      ...(entry.descriptor.clientId ? { clientId: entry.descriptor.clientId } : {}),
      preparedAt: entry.preparedAt,
      updatedAt: this.iso(),
      ...extra,
    };
  }

  // -------------------------------------------------------------------------
  // Recoverable operations
  // -------------------------------------------------------------------------

  async prepare(
    environmentId: string,
    actor: DesignActor,
    raw: unknown,
  ): Promise<DesignPrepareResult> {
    await this.initialize();
    if (this.closed)
      throw new DesignError("unsupported", "Design service is stopping", { retry: "after-delay" });
    const descriptor = descriptorSchema.parse(raw) as DesignOperationDescriptor;
    const bytes = Buffer.byteLength(JSON.stringify(descriptor));
    if (bytes > DESIGN_LIMITS.admittedPayloadBytes)
      throw new DesignError("capacity", "Design operation input is too large", { retry: "never" });
    if (
      descriptor.input.kind === "batch" &&
      Buffer.byteLength(JSON.stringify(descriptor.input.operations)) > DESIGN_LIMITS.batchBytes
    )
      throw new DesignError("capacity", "Batch exceeds 512 KiB", { retry: "never" });
    if (descriptor.input.kind === "create_canvas")
      return lifecycle.prepareCreate(this, environmentId, actor, descriptor, bytes);
    if (!descriptor.canvasId) throw new DesignError("invalid-input", "canvasId is required");
    const canvasId = descriptor.canvasId;
    return this.lane(canvasId, async () => {
      const { record, legacy } = await this.loadFor(canvasId, environmentId, {
        allowDeleted: descriptor.input.kind === "restore_canvas",
      });
      const now = this.now();
      const stored = await this.store.readPending(canvasId);
      let retained = legacy ? this.retainedOutcomes(record, stored) : [];
      // Settled and expired entries are compacted away here, lazily.
      let pending = this.livePending(record, stored).filter((entry) => !retained.includes(entry));
      const digest = descriptorDigest({ environmentId, canvasId, descriptor });
      if (descriptor.correlationId) {
        const existing = pending.find(
          (entry) => entry.descriptor.correlationId === descriptor.correlationId,
        );
        if (existing) {
          if (intentDigest(existing.descriptor) !== intentDigest(descriptor))
            throw reusedCorrelation(existing.token);
          return {
            token: existing.token,
            canvasId,
            state: "prepared",
            expiresAt: existing.expiresAt,
          };
        }
        const settled = this.settledUnder(record, retained, descriptor);
        if (settled) {
          if (!settled.matches) throw reusedCorrelation(settled.token);
          throw new DesignError(
            "invalid-input",
            "This correlation id already has a settled operation",
            {
              details: { token: settled.token },
            },
          );
        }
      }
      // An earlier duplicate whose copy committed but whose source receipt
      // was not saved is recorded first. While that still cannot be saved, a
      // new duplicate is refused so its outcome stays provable.
      if (descriptor.input.kind === "duplicate_canvas") {
        const copied: Array<[DesignPendingOperation, DesignOperationStatus]> = [];
        for (const candidate of stored) {
          if (record.receipts.some((receipt) => receipt.token === candidate.token)) continue;
          const committed = await lifecycle.committedDuplicate(this, candidate);
          if (committed) copied.push([candidate, committed]);
        }
        if (copied.length) {
          const next = cloneRecord(record);
          for (const [candidate, receipt] of copied)
            addReceipt(next, receipt, candidate.descriptor);
          try {
            await this.commit(next, legacy);
          } catch {
            throw new DesignError(
              "unknown-outcome",
              "An earlier duplicate already committed. Reconcile its token before duplicating again.",
              { retry: "review", details: { token: copied[0]![0].token } },
            );
          }
          const recorded = new Set(copied.map(([candidate]) => candidate.token));
          pending = pending.filter((entry) => !recorded.has(entry.token));
          retained = retained.filter((entry) => !recorded.has(entry.token));
        }
      }
      if (
        pending.reduce((total, candidate) => total + candidate.bytes, 0) + bytes >
        DESIGN_LIMITS.admittedPayloadBytes
      )
        throw new DesignError(
          "capacity",
          "Too much pending edit data for this design; wait for it to settle",
          {
            retryAfterMs: 1000,
          },
        );
      if (pending.length >= DESIGN_LIMITS.preparedPerCanvas)
        throw new DesignError(
          "capacity",
          "Too many pending edits for this design; wait for them to settle",
          {
            retryAfterMs: 1000,
          },
        );
      const entry: DesignPendingOperation = {
        token: `op_${randomUUID()}`,
        digest,
        descriptor,
        actor,
        environmentId,
        canvasId,
        incarnation: record.incarnation,
        preparedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + DESIGN_LIMITS.preparedTtlMs).toISOString(),
        bytes,
        state: "prepared",
        owner: this.generation,
      };
      const live = [...pending, entry];
      await this.store.writePending(canvasId, [...fittingOutcomes(retained, live), ...live]);
      return { token: entry.token, canvasId, state: "prepared", expiresAt: entry.expiresAt };
    });
  }

  /**
   * The operation already settled under the descriptor's correlation id (a
   * receipt, or a never-migrated canvas's retained outcome) and whether the
   * descriptor is the same edit.
   */
  private settledUnder(
    record: DesignPrivateRecord,
    retained: DesignPendingOperation[],
    descriptor: DesignOperationDescriptor,
  ) {
    const receipt = record.receipts.find(
      (candidate) => candidate.correlationId === descriptor.correlationId,
    );
    if (receipt)
      return {
        token: receipt.token,
        receipt,
        matches: settledMatches(receiptDigest(record, receipt.token), descriptor),
      };
    const entry = retained.find(
      (candidate) => candidate.descriptor.correlationId === descriptor.correlationId,
    );
    if (entry)
      return {
        token: entry.token,
        entry,
        matches: intentDigest(entry.descriptor) === intentDigest(descriptor),
      };
    return undefined;
  }

  /**
   * What `submit_operation` replays for a correlated descriptor on an existing
   * canvas: the settled outcome and whether the descriptor is the same edit.
   */
  async settledCorrelation(
    environmentId: string,
    canvasId: string,
    descriptor: DesignOperationDescriptor,
  ): Promise<{ status: DesignOperationStatus; matches: boolean } | undefined> {
    await this.initialize();
    const { record, legacy } = await this.loadFor(canvasId, environmentId, { allowDeleted: true });
    const retained = legacy
      ? this.retainedOutcomes(record, await this.store.readPending(canvasId))
      : [];
    const settled = this.settledUnder(record, retained, descriptor);
    if (!settled) return undefined;
    return {
      status: settled.receipt ?? (await this.deadOutcome(settled.entry!)),
      matches: settled.matches,
    };
  }

  /** Executes a prepared token once. Repeats return its state; never a second copy. */
  async execute(
    environmentId: string,
    canvasId: string,
    token: string,
    options: { waitMs?: number } = {},
  ): Promise<DesignOperationStatus> {
    await this.initialize();
    designId.parse(canvasId);
    operationToken.parse(token);
    const owner = `${environmentId}|${canvasId}`;
    let work = this.running.get(token);
    // Joining in-flight work requires the same environment and canvas; anyone
    // else gets the ordinary (ownership-checked) status answer.
    if (work && this.runningOwner.get(token) !== owner)
      return this.status(environmentId, canvasId, token);
    if (!work) {
      work = this.runOperation(environmentId, canvasId, token);
      this.running.set(token, work);
      this.runningOwner.set(token, owner);
      const settle = () => {
        if (this.running.get(token) === work) {
          this.running.delete(token);
          this.runningOwner.delete(token);
        }
      };
      work.then(settle, settle);
    }
    const waitMs = options.waitMs ?? this.executeWaitMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    });
    try {
      const settled = await Promise.race([work, timeout]);
      if (settled) return settled;
      return this.status(environmentId, canvasId, token);
    } finally {
      clearTimeout(timer);
    }
  }

  async status(
    environmentId: string,
    canvasId: string,
    token: string,
  ): Promise<DesignOperationStatus> {
    await this.initialize();
    operationToken.parse(token);
    const { record } = await this.loadFor(canvasId, environmentId, {
      allowDeleted: true,
      allowProvisional: true,
    });
    const receipt = record.receipts.find((candidate) => candidate.token === token);
    if (receipt) return receipt;
    const entry = (await this.store.readPending(canvasId)).find(
      (candidate) => candidate.token === token && candidate.environmentId === environmentId,
    );
    // A duplicate's copy commits before its source receipt. Its owner may
    // still be alive after that receipt repeatedly fails to persist.
    if (entry) {
      const committed = await lifecycle.committedDuplicate(this, entry);
      if (committed) return committed;
    }
    const unrecorded = this.unrecorded.get(token);
    if (
      unrecorded &&
      unrecorded.canvasId === canvasId &&
      record.environmentId === environmentId &&
      !this.running.has(token)
    )
      return unrecorded;
    if (entry) {
      // Side-effect free: the receipt is written when the token is next executed.
      if (!this.running.has(token) && this.ownerDead(entry)) return this.deadOutcome(entry);
      const executing = this.running.has(token) || entry.state === "executing";
      return this.receipt(entry, executing ? "executing" : "prepared", {
        expiresAt: entry.expiresAt,
      });
    }
    return {
      token,
      canvasId,
      kind: "update_frame",
      state: "unknown",
      actor: "system",
      base: {},
      preparedAt: record.createdAt,
      updatedAt: this.iso(),
      failure: {
        code: "expired-operation",
        message:
          "No record of this operation is retained. Review the current design before trying again.",
        retry: "review",
      },
    };
  }

  /** Cancels only work that has not started executing. */
  async cancel(
    environmentId: string,
    canvasId: string,
    token: string,
  ): Promise<DesignOperationStatus> {
    await this.initialize();
    operationToken.parse(token);
    return this.lane(canvasId, async () => {
      const { record, legacy } = await this.loadFor(canvasId, environmentId, {
        allowDeleted: true,
        allowProvisional: true,
      });
      const receipt = record.receipts.find((candidate) => candidate.token === token);
      if (receipt) return receipt;
      const pending = await this.store.readPending(canvasId);
      const entry = pending.find((candidate) => candidate.token === token);
      if (!entry || entry.environmentId !== environmentId)
        return this.status(environmentId, canvasId, token);
      if (!this.running.has(token) && this.ownerDead(entry))
        return this.settleDead(record, legacy, pending, entry);
      if (entry.state === "executing" || this.running.has(token))
        throw new DesignError(
          "conflict",
          "This edit already started; it can no longer be canceled",
          {
            retry: "review",
          },
        );
      const next = cloneRecord(record);
      const canceled = this.receipt(entry, "canceled");
      addReceipt(next, canceled, entry.descriptor);
      next.statusVersion++;
      if (next.state === "provisional") {
        await this.store.writePending(
          canvasId,
          pending.filter((candidate) => candidate.token !== token),
        );
        await lifecycle.discardProvisional(this, canvasId);
        return canceled;
      }
      await this.commit(next, legacy);
      await this.store.writePending(
        canvasId,
        pending.filter((candidate) => candidate.token !== token),
      );
      return canceled;
    });
  }

  private async runOperation(
    environmentId: string,
    canvasId: string,
    token: string,
  ): Promise<DesignOperationStatus> {
    // Phase A: validate the token and capture an immutable snapshot.
    const started = await this.lane(canvasId, async () => {
      const { record, legacy } = await this.loadFor(canvasId, environmentId, {
        allowDeleted: true,
        allowProvisional: true,
      });
      const receipt = record.receipts.find((candidate) => candidate.token === token);
      if (receipt) return { done: receipt } as const;
      const pending = await this.store.readPending(canvasId);
      let entry = pending.find((candidate) => candidate.token === token);
      if (!entry || entry.environmentId !== environmentId || entry.canvasId !== canvasId)
        return { done: await this.status(environmentId, canvasId, token) } as const;
      if (entry.state === "executing") return { done: this.receipt(entry, "executing") } as const;
      // A duplicate whose copy exists committed, whoever owns it and however
      // old its entry is; only its source receipt is missing.
      const copied = await lifecycle.committedDuplicate(this, entry);
      if (copied) {
        // The copy proves the outcome even while the source cannot be saved.
        const done = await this.settleWith(record, legacy, pending, entry, copied).catch(
          () => copied,
        );
        return { done } as const;
      }
      // Work admitted by a process that died never runs (as after a restart).
      if (this.ownerDead(entry))
        return { done: await this.settleDead(record, legacy, pending, entry) } as const;
      if (
        entry.incarnation !== record.incarnation ||
        entry.digest !== descriptorDigest({ environmentId, canvasId, descriptor: entry.descriptor })
      ) {
        return {
          done: await this.settle(record, legacy, pending, entry, "expired", {
            code: "expired-operation",
            message:
              "This edit was prepared for an earlier version of the design and can no longer run",
            retry: "review",
          }),
        } as const;
      }
      if (Date.parse(entry.expiresAt) <= this.now().getTime())
        return {
          done: await this.settle(record, legacy, pending, entry, "expired", {
            code: "expired-operation",
            message: "This prepared edit expired before it ran",
            retry: "review",
          }),
        } as const;
      // No durable "executing" marker: a restart turns every uncommitted
      // pending entry of a dead owner into an `interrupted` receipt, so
      // admission is tracked in memory (`running`) and costs no extra write.
      // Executing another live process's token claims it, so it becomes
      // interruptible if this process dies. Should both run it, the receipt
      // check under the lane lets only the first commit.
      this.admit(canvasId, entry.bytes);
      if (entry.owner !== this.generation) {
        const claimed: DesignPendingOperation = { ...entry, owner: this.generation };
        try {
          await this.store.writePending(
            canvasId,
            pending.map((candidate) => (candidate.token === token ? claimed : candidate)),
          );
        } catch (error) {
          this.release(canvasId, entry.bytes);
          throw error;
        }
        entry = claimed;
      }
      return { entry, record, legacy } as const;
    });
    if ("done" in started) return started.done!;
    const { entry } = started;
    const kind = entry.descriptor.input.kind;
    this.metrics.operations[kind] = (this.metrics.operations[kind] ?? 0) + 1;
    try {
      if (lifecycle.isLifecycle(kind))
        return await lifecycle.executeLifecycle(this, entry, started.record);
      // Phase B: compute outside every lock.
      let computed: ComputedOperation | undefined;
      let failure: DesignFailure | undefined;
      if (started.record.state === "deleted") {
        failure = { code: "deleted", message: "This design was deleted", retry: "never" };
      } else {
        try {
          computed = await computeOperation({
            record: started.record,
            descriptor: entry.descriptor,
            actor: entry.actor,
            store: this.store,
            render: (frame, operation, priority) =>
              this.render(environmentId, canvasId, frame, operation, priority),
            frameRevision: this.substitutedRevision(started.record, entry),
          });
          computed.incarnation = started.record.incarnation;
        } catch (error) {
          failure = toDesignFailure(error);
        }
      }
      // The global history budget counts every process's canvases.
      if (computed?.history) await this.refreshLibrary();
      // Phase C: re-verify against the latest state and commit atomically.
      return await this.lane(canvasId, () =>
        this.finish(environmentId, canvasId, entry, computed, failure),
      );
    } catch (error) {
      // The commit itself failed (e.g. disk full): the replacement may or may
      // not have happened, so report the outcome as unknown until disk proves it.
      this.rememberFailure(
        this.receipt(entry, "unknown", {
          failure: {
            code: "unknown-outcome",
            message:
              "Saving this edit failed part-way. Reload the design to see whether it applied.",
            retry: "review",
          },
        }),
      );
      throw error;
    } finally {
      this.release(canvasId, entry.bytes);
    }
  }

  /** In-process outcomes that could not be written as receipts (bounded). */
  private readonly unrecorded = new Map<string, DesignOperationStatus>();
  private rememberFailure(status: DesignOperationStatus) {
    this.unrecorded.set(status.token, status);
    while (this.unrecorded.size > 256) this.unrecorded.delete(this.unrecorded.keys().next().value!);
  }

  /**
   * A same-client predecessor may stand in for the declared base revision when
   * the frame still equals exactly that predecessor's committed result.
   */
  private substitutedRevision(
    record: DesignPrivateRecord,
    entry: DesignPendingOperation,
  ): number | undefined {
    const input = entry.descriptor.input;
    const declared = entry.descriptor.preconditions.frameRevision;
    if (!entry.descriptor.predecessor || !("frameId" in input) || declared === undefined)
      return undefined;
    if (input.kind !== "update_frame" && input.kind !== "set_element_styles") return undefined;
    const frame = record.document.frames.find((candidate) => candidate.id === input.frameId);
    if (!frame || frame.revision === declared) return undefined;
    const predecessor = record.receipts.find(
      (receipt) => receipt.token === entry.descriptor.predecessor,
    );
    const produced = predecessor?.result?.frames.find(
      (candidate) => candidate.frameId === input.frameId,
    );
    if (
      predecessor?.state !== "committed" ||
      !entry.descriptor.clientId ||
      predecessor.clientId !== entry.descriptor.clientId ||
      predecessor.base.frameRevision !== declared ||
      !produced ||
      produced.revision !== frame.revision ||
      !record.receipts.some(
        (receipt) => receipt.token === predecessor.token && receipt.actor === entry.actor,
      )
    )
      return undefined;
    if (input.kind === "set_element_styles") {
      const structure = entry.descriptor.preconditions.structureId;
      if (!structure || produced.identity?.structureId !== structure) return undefined;
    }
    return frame.revision;
  }

  private async finish(
    environmentId: string,
    canvasId: string,
    entry: DesignPendingOperation,
    computed: ComputedOperation | undefined,
    failure: DesignFailure | undefined,
  ): Promise<DesignOperationStatus> {
    const { record: latest, legacy } = await this.loadFor(canvasId, environmentId, {
      allowDeleted: true,
    });
    const pending = await this.store.readPending(canvasId);
    // Settled meanwhile (canceled, interrupted or run by another process): one outcome only.
    const settled = latest.receipts.find((receipt) => receipt.token === entry.token);
    if (settled) {
      await this.dropPending(canvasId, pending, entry.token);
      return settled;
    }
    if (!computed || failure) {
      if (failure?.code === "conflict") this.metrics.conflicts++;
      return this.settle(latest, legacy, pending, entry, "rejected", failure!);
    }
    const record = cloneRecord(latest);
    try {
      verifyComputed(record, computed);
    } catch (error) {
      const verification = toDesignFailure(error);
      if (verification.code === "conflict") this.metrics.conflicts++;
      return this.settle(latest, legacy, pending, entry, "rejected", verification);
    }
    if (computed.noop) {
      this.metrics.noops++;
      const receipt = this.receipt(entry, "no-op", {
        result: {
          canvasRevision: record.document.revision,
          frames: computed.frameRevisions.map((frame) => ({
            frameId: frame.frameId,
            revision: frame.revision,
          })),
          ...(computed.unchangedProperties?.length
            ? { unchangedProperties: computed.unchangedProperties }
            : {}),
          ...(computed.outcomes ? { outcomes: computed.outcomes } : {}),
        },
      });
      addReceipt(record, receipt, entry.descriptor);
      await this.commit(record, legacy);
      await this.dropPending(canvasId, pending, entry.token);
      return receipt;
    }
    const now = this.iso();
    const before = record.document.revision;
    const applied = applyComputed(record, computed, now);
    // Every committed revision must stay exportable and re-importable as a v1 file.
    if (portableBytes(record.document).byteLength > DESIGN_MAX_DOCUMENT_BYTES)
      return this.settle(latest, legacy, pending, entry, "rejected", {
        code: "invalid-content",
        message: "This edit would make the design larger than 4 MiB; the previous version was kept",
        retry: "never",
      });
    let obsolete: string[] = [];
    let written: string | undefined;
    if (computed.history && applied.checkpoint) {
      const draft = {
        gestureId: entry.descriptor.gestureId,
        actor: entry.actor,
        kind: computed.history.kind,
        frames: applied.historyFrames,
      };
      const merged = computed.history.markUndone ? undefined : gestureMergeTarget(record, draft);
      let checkpoint = applied.checkpoint;
      let canvasRevisionBefore = before;
      let historyFrames = applied.historyFrames;
      if (merged) {
        const previous = await readCheckpoint(this.store, canvasId, merged).catch(() => undefined);
        if (previous) {
          checkpoint = {
            ...checkpoint,
            frames: checkpoint.frames.map((frame) => {
              const earlier = previous.frames.find(
                (candidate) => candidate.frameId === frame.frameId,
              );
              return earlier
                ? { ...frame, before: earlier.before, beforeIndex: earlier.beforeIndex }
                : frame;
            }),
            ...(previous.canvasName && checkpoint.canvasName
              ? {
                  canvasName: {
                    before: previous.canvasName.before,
                    after: checkpoint.canvasName.after,
                  },
                }
              : {}),
          };
          canvasRevisionBefore = merged.canvasRevisionBefore;
          historyFrames = historyFrames.map((frame) => ({
            ...frame,
            before:
              merged.frames.find((candidate) => candidate.frameId === frame.frameId)?.before ??
              frame.before,
          }));
        }
      }
      const entryId = randomUUID().slice(0, 18);
      const file = await writeCheckpoint(this.store, { entryId, ...checkpoint });
      written = file.file;
      const history: DesignHistoryEntryRecord = {
        id: entryId,
        kind: computed.history.kind,
        label: computed.history.label,
        actor: entry.actor,
        createdAt: now,
        canvasRevisionBefore,
        canvasRevisionAfter: record.document.revision,
        frames: historyFrames,
        ...(checkpoint.canvasName ? { canvasName: checkpoint.canvasName } : {}),
        checkpoint: file.file,
        bytes: file.bytes,
        undone: false,
        ...(computed.history.undoOf ? { undoOf: computed.history.undoOf } : {}),
        ...(computed.history.redoOf ? { redoOf: computed.history.redoOf } : {}),
        ...(entry.descriptor.gestureId ? { gestureId: entry.descriptor.gestureId } : {}),
        protected: false,
        scope: computed.history.scope,
      };
      if (computed.history.markUndone) {
        const target = record.history.entries.find(
          (candidate) => candidate.id === computed.history!.markUndone,
        );
        if (target) target.undone = true;
      }
      try {
        obsolete = appendEntry(record, history, merged).obsolete;
        this.ensureHistoryBudget(canvasId, record);
      } catch (error) {
        await deleteCheckpoints(this.store, canvasId, [file.file]);
        return this.settle(latest, legacy, pending, entry, "rejected", toDesignFailure(error));
      }
      applied.result.historyEntryId = entryId;
    }
    const receipt = this.receipt(entry, "committed", { result: applied.result });
    addReceipt(record, receipt, entry.descriptor);
    try {
      await this.commit(record, legacy, {
        revision: record.document.revision,
        kind: "document",
        statusVersion: record.statusVersion,
        ...(applied.result.frames.length === 1
          ? { frameId: applied.result.frames[0]!.frameId }
          : {}),
      });
    } catch (error) {
      if (written) await deleteCheckpoints(this.store, canvasId, [written]);
      throw error;
    }
    await this.dropPending(canvasId, pending, entry.token);
    if (obsolete.length) this.track(deleteCheckpoints(this.store, canvasId, obsolete));
    for (const frameId of computed.validateAfter)
      validation.schedule(this, environmentId, canvasId, frameId);
    this.track(this.enforceGlobalHistory());
    return receipt;
  }

  private settle(
    record: DesignPrivateRecord,
    legacy: boolean,
    pending: DesignPendingOperation[],
    entry: DesignPendingOperation,
    state: "rejected" | "expired",
    failure: DesignFailure,
  ): Promise<DesignOperationStatus> {
    return this.settleWith(record, legacy, pending, entry, this.receipt(entry, state, { failure }));
  }

  /**
   * Settles a dead owner's entry with {@link deadOutcome}. On a never-migrated
   * canvas an interrupted entry stays pending as its outcome instead: writing
   * the receipt would migrate the canvas without an edit.
   */
  private async settleDead(
    record: DesignPrivateRecord,
    legacy: boolean,
    pending: DesignPendingOperation[],
    entry: DesignPendingOperation,
  ): Promise<DesignOperationStatus> {
    const outcome = await this.deadOutcome(entry);
    if (legacy && outcome.state === "interrupted") return outcome;
    return this.settleWith(record, legacy, pending, entry, outcome);
  }

  private async settleWith(
    record: DesignPrivateRecord,
    legacy: boolean,
    pending: DesignPendingOperation[],
    entry: DesignPendingOperation,
    receipt: DesignOperationStatus,
  ): Promise<DesignOperationStatus> {
    if (record.state === "provisional") {
      await this.dropPending(entry.canvasId, pending, entry.token);
      return receipt;
    }
    const next = cloneRecord(record);
    addReceipt(next, receipt, entry.descriptor);
    await this.commit(next, legacy);
    await this.dropPending(entry.canvasId, pending, entry.token);
    return receipt;
  }

  /**
   * Removes a settled token's pending entry in the same lane, right after its
   * receipt committed. It must not linger: once the receipt is pruned from the
   * bounded list, a leftover entry would look runnable again. Receipts stay
   * authoritative, so a crash between the two writes is harmless (prepare and
   * restart recovery skip entries that have receipts).
   */
  async dropPending(canvasId: string, pending: DesignPendingOperation[], token: string) {
    await this.store
      .writePending(
        canvasId,
        pending.filter((candidate) => candidate.token !== token),
      )
      .catch(() => undefined);
  }

  /**
   * What an unsettled entry of a dead owner amounts to. It never ran, except a
   * duplicate whose copy exists: that committed before its source receipt.
   */
  async deadOutcome(entry: DesignPendingOperation): Promise<DesignOperationStatus> {
    return (
      (await lifecycle.committedDuplicate(this, entry)) ??
      this.receipt(entry, "interrupted", { failure: INTERRUPTED_FAILURE })
    );
  }

  /**
   * A never-migrated canvas's outcomes for work its dead owners admitted. It
   * has nowhere to keep receipts, so their pending entries stay: status
   * answers them, prepare keeps them while they fit, and the commit that
   * migrates the canvas turns them into receipts.
   */
  private retainedOutcomes(record: DesignPrivateRecord, pending: DesignPendingOperation[]) {
    const settled = new Set(record.receipts.map((receipt) => receipt.token));
    return pending.filter(
      (entry) =>
        !settled.has(entry.token) && !this.running.has(entry.token) && this.ownerDead(entry),
    );
  }

  /**
   * Whether the entry's owner is gone: another process that is no longer
   * alive, or an entry written before owners were recorded.
   */
  ownerDead(entry: Pick<DesignPendingOperation, "owner">): boolean {
    return entry.owner !== this.generation && !this.coordination.isAlive(entry.owner);
  }

  /** Entries that are neither settled by a receipt nor expired (unless still running). */
  livePending(record: DesignPrivateRecord, pending: DesignPendingOperation[]) {
    const settled = new Set(record.receipts.map((receipt) => receipt.token));
    const now = this.now().getTime();
    return pending.filter(
      (entry) =>
        !settled.has(entry.token) &&
        (this.running.has(entry.token) || Date.parse(entry.expiresAt) > now),
    );
  }

  private admit(canvasId: string, bytes: number) {
    const perCanvas = this.admittedByCanvas.get(canvasId) ?? 0;
    if (
      this.admitted >= DESIGN_LIMITS.admittedMutations ||
      perCanvas >= DESIGN_LIMITS.admittedMutationsPerCanvas ||
      this.admittedBytes + bytes > DESIGN_LIMITS.admittedPayloadBytes
    )
      throw new DesignError("capacity", "Design editing is at capacity; retry shortly", {
        retryAfterMs: 500,
      });
    this.admitted++;
    this.admittedBytes += bytes;
    this.admittedByCanvas.set(canvasId, perCanvas + 1);
  }

  private release(canvasId: string, bytes: number) {
    this.admitted--;
    this.admittedBytes -= bytes;
    const perCanvas = (this.admittedByCanvas.get(canvasId) ?? 1) - 1;
    if (perCanvas <= 0) this.admittedByCanvas.delete(canvasId);
    else this.admittedByCanvas.set(canvasId, perCanvas);
  }

  async render(
    environmentId: string,
    canvasId: string,
    frame: Pick<DesignFrame, "html" | "width" | "height">,
    operation: DesignOperation | { op: "capture" },
    priority: RenderPriority,
  ): Promise<unknown> {
    const started = performance.now();
    try {
      return await this.renderer.run({ environmentId, canvasId, priority, frame, operation });
    } finally {
      this.metrics.renders++;
      this.metrics.renderMs += performance.now() - started;
    }
  }

  private historyTotal(): number {
    let total = 0;
    for (const entry of this.library.entries.values()) total += entry.historyBytes;
    return total;
  }

  /** Refuses a destructive edit before mutation if its recovery state cannot be kept. */
  private ensureHistoryBudget(canvasId: string, record: DesignPrivateRecord) {
    const others = this.historyTotal() - (this.library.entries.get(canvasId)?.historyBytes ?? 0);
    if (others + record.history.bytes <= DESIGN_LIMITS.historyBytesGlobal) return;
    // Only entries beyond each canvas's protected newest ones can be pruned.
    let prunable = record.history.entries.length > PROTECTED_HISTORY_ENTRIES;
    for (const entry of this.library.entries.values()) {
      if (entry.id !== canvasId && entry.historyPrunable) prunable = true;
    }
    if (!prunable)
      throw new DesignError(
        "capacity",
        "Design history storage is full; purge deleted designs to continue",
        {
          retry: "never",
        },
      );
  }

  /** Background pruning of the oldest unprotected entries across canvases. */
  private async enforceGlobalHistory(): Promise<void> {
    for (let attempts = 0; attempts < 64; attempts++) {
      await this.refreshLibrary();
      if (this.historyTotal() <= DESIGN_LIMITS.historyBytesGlobal) return;
      const candidates = Array.from(this.library.entries.values())
        .filter((entry) => entry.historyBytes > 0 && entry.state !== "provisional")
        .sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt));
      let pruned = false;
      for (const candidate of candidates) {
        pruned = await this.lane(candidate.id, async () => {
          const loaded = await this.load(candidate.id);
          if (loaded.kind !== "record" || loaded.legacy) return false;
          const record = cloneRecord(loaded.record);
          const file = dropOldestUnprotected(record);
          if (!file) return false;
          record.statusVersion++;
          await this.commit(record, false, {
            revision: record.document.revision,
            kind: "status",
            statusVersion: record.statusVersion,
          });
          await deleteCheckpoints(this.store, candidate.id, [file]);
          return true;
        });
        if (pruned) break;
      }
      if (!pruned) return;
    }
  }

  /** Legacy one-shot adapter: prepare + execute; failures throw typed errors. */
  async runOnce(
    environmentId: string,
    actor: DesignActor,
    descriptor: DesignOperationDescriptor,
  ): Promise<DesignOperationStatus> {
    const prepared = await this.prepare(environmentId, actor, descriptor);
    const status = await this.execute(environmentId, prepared.canvasId, prepared.token, {
      waitMs: 10 * 60_000,
    });
    if (status.state === "committed" || status.state === "no-op") return status;
    if (status.failure?.code === "conflict" && status.failure.revisions)
      throw designConflict(
        status.failure.revisions.expected ?? 0,
        status.failure.revisions.current ?? 0,
      );
    if (status.failure)
      throw new DesignError(status.failure.code, status.failure.message, status.failure);
    throw new DesignError("unknown-outcome", `Design operation ${status.state}`);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async snapshot(environmentId: string, canvasId: string): Promise<DesignSnapshotResult> {
    await this.initialize();
    const base = {
      responseVersion: DESIGN_RESPONSE_VERSION,
      generation: this.generation,
      canvasId,
    };
    designId.parse(canvasId);
    if (this.environmentDeleted(environmentId)) return { kind: "missing", ...base };
    const loaded = await this.load(canvasId);
    if (loaded.kind === "missing") return { kind: "missing", ...base };
    if (loaded.kind === "problem") {
      if ((await this.problemOwner(canvasId)) !== environmentId)
        return { kind: "missing", ...base };
      return {
        kind: "record-problem",
        ...base,
        problem: loaded.problem,
        message: loaded.message,
        backupAvailable: loaded.backupAvailable,
      };
    }
    const record = loaded.record;
    if (record.environmentId !== environmentId || record.state === "provisional")
      return { kind: "missing", ...base };
    if (record.state === "deleted") return tombstone(record, this.generation, true);
    validation.scheduleStale(this, environmentId, record);
    return snapshotEnvelope(record, this.generation);
  }

  async sync(
    environmentId: string,
    canvasId: string,
    clientGeneration: string | undefined,
    after: number,
    statusVersion: number | undefined,
  ): Promise<DesignSyncResult> {
    const snapshot = await this.snapshot(environmentId, canvasId);
    if (snapshot.kind !== "snapshot") return snapshot;
    const loaded = await this.load(canvasId);
    if (loaded.kind !== "record") return snapshot;
    const result = buildSync(
      loaded.record,
      this.generation,
      clientGeneration,
      revision.parse(after),
      statusVersion,
    );
    return result;
  }

  async get(id: string, environmentId?: string): Promise<DesignCanvas> {
    await this.initialize();
    const loaded = await this.load(id);
    if (loaded.kind === "missing")
      throw new DesignError("not-found", "Canvas not found in this environment");
    if (loaded.kind === "problem")
      throw new DesignError("storage", loaded.message, { retry: "never" });
    const record = loaded.record;
    if ((environmentId && record.environmentId !== environmentId) || record.state === "provisional")
      throw new DesignError("not-found", "Canvas not found in this environment");
    if (record.state === "deleted") throw new DesignError("deleted", "This design was deleted");
    return record.document;
  }

  async getFrame(canvasId: string, environmentId: string, frameId: string): Promise<DesignFrame> {
    const canvas = await this.get(canvasId, environmentId);
    const frame = canvas.frames.find((candidate) => candidate.id === frameId);
    if (!frame) throw new DesignError("not-found", "Frame not found");
    return frame;
  }

  async list(environmentId: string) {
    await this.initialize();
    await this.refreshLibrary();
    return Array.from(this.library.entries.values())
      .filter((entry) => entry.environmentId === environmentId && entry.state === "live")
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id))
      .map((entry) => ({ id: entry.id, name: entry.name, revision: entry.revision }));
  }

  async libraryPage(environmentId: string, query: DesignLibraryQuery): Promise<DesignLibraryPage> {
    await this.initialize();
    await this.refreshLibrary();
    return this.library.query(environmentId, query);
  }

  /**
   * Synchronous answer from the index. A change by another process is picked
   * up by a background refresh, so it is visible to the next call.
   */
  hasCanvases(environmentId: string): boolean {
    if (this.initialized && !this.closed && !this.libraryScan) this.track(this.refreshLibrary());
    for (const entry of this.library.entries.values()) {
      if (
        entry.environmentId === environmentId &&
        (entry.state === "live" || entry.state === "deleted")
      )
        return true;
    }
    return false;
  }

  async historyStatus(
    canvasId: string,
    environmentId: string,
    actor: DesignActor = "user",
  ): Promise<DesignHistoryStatus> {
    await this.initialize();
    const { record } = await this.loadFor(canvasId, environmentId);
    return historyStatus(record, actor);
  }

  async historyPage(
    environmentId: string,
    canvasId: string,
    offset?: number,
    limit?: number,
  ): Promise<DesignHistoryPage> {
    await this.initialize();
    const { record } = await this.loadFor(canvasId, environmentId, { allowDeleted: true });
    return historyPage(record, offset, limit);
  }

  async checkpoint(
    environmentId: string,
    canvasId: string,
    entryId: string,
    side: "before" | "after",
  ): Promise<DesignCheckpointPreview> {
    await this.initialize();
    const { record } = await this.loadFor(canvasId, environmentId, { allowDeleted: true });
    return checkpointPreview(this.store, record, entryId, side);
  }

  async getCanvasState(
    canvasId: string,
    environmentId: string,
    actor: DesignActor = "user",
  ): Promise<DesignCanvasState> {
    await this.initialize();
    const { record } = await this.loadFor(canvasId, environmentId);
    return { canvas: record.document, history: historyStatus(record, actor) };
  }

  async readiness(probe = false): Promise<DesignReadiness> {
    await this.initialize().catch(() => undefined);
    if (this.initialized) await this.refreshLibrary();
    const counts = this.library.counts();
    const renderer = probe ? await this.renderer.probe(true) : this.renderer.status();
    return {
      capabilities: this.capabilities(),
      storage: {
        available: this.initialized,
        canvases: counts.live + counts.provisional,
        limit: DESIGN_MAX_CANVASES,
        ...(this.initialized ? {} : { message: "Design storage is unavailable" }),
      },
      renderer,
    };
  }

  async inspect(environmentId: string, canvasId: string, frameId: string, selector: string) {
    const { record } = await this.loadFor(canvasId, environmentId);
    const frame = record.document.frames.find((candidate) => candidate.id === frameId);
    if (!frame) throw new DesignError("not-found", "Frame not found");
    const meta = record.frames[frameId]!;
    const element = (await this.render(
      environmentId,
      canvasId,
      frame,
      { op: "inspectElement", selector },
      "interactive",
    )) as DesignElement;
    return {
      revision: frame.revision,
      structureId: meta.structureId,
      contentId: meta.contentId,
      element,
    };
  }

  async capture(
    environmentId: string,
    canvasId: string,
    frameId: string,
    priority: RenderPriority = "interactive",
  ) {
    const { record } = await this.loadFor(canvasId, environmentId);
    const frame = record.document.frames.find((candidate) => candidate.id === frameId);
    if (!frame) throw new DesignError("not-found", "Frame not found");
    const meta = record.frames[frameId]!;
    const capture = (await this.render(
      environmentId,
      canvasId,
      frame,
      { op: "capture" },
      priority,
    )) as {
      data: string;
      mimeType: string;
    };
    return {
      revision: frame.revision,
      contentId: meta.contentId,
      viewportId: meta.viewportId,
      ...capture,
    };
  }

  async hierarchy(
    environmentId: string,
    canvasId: string,
    frameId: string,
    query: { rootSelector?: string; cursor?: string; maxNodes?: number; maxDepth?: number },
  ) {
    const { record } = await this.loadFor(canvasId, environmentId);
    const frame = record.document.frames.find((candidate) => candidate.id === frameId);
    if (!frame) throw new DesignError("not-found", "Frame not found");
    const page = (await this.render(
      environmentId,
      canvasId,
      frame,
      { op: "hierarchyPage", ...query },
      "background",
    )) as DesignHierarchyPage;
    return { revision: frame.revision, structureId: record.frames[frameId]!.structureId, page };
  }

  // -------------------------------------------------------------------------
  // Sessions (workspace metadata only; never transcripts or credentials)
  // -------------------------------------------------------------------------

  linkSession(
    environmentId: string,
    canvasId: string,
    link: DesignSessionLinkInput,
    replaceId?: string,
  ): Promise<DesignSessionLink> {
    return sessionLinks.linkSession(this, environmentId, canvasId, link, replaceId);
  }

  unlinkSession(environmentId: string, canvasId: string, linkId: string): Promise<void> {
    return sessionLinks.unlinkSession(this, environmentId, canvasId, linkId);
  }

  sessionLinkStates(
    environmentId: string,
    canvasId: string,
    lookup: DesignNativeSessionLookup,
  ): Promise<DesignSessionLinkStates> {
    return sessionLinks.sessionLinkStates(this, environmentId, canvasId, lookup);
  }

  recordTabSession(input: {
    environmentId: string;
    tabId: string;
    platform: string;
    providerSessionId: string;
  }): Promise<number> {
    return sessionLinks.recordTabSession(this, input);
  }

  resumeSessionLink(
    environmentId: string,
    canvasId: string,
    input: { linkId: string; expectedTabId: string; tabId: string },
    resumer: DesignSessionResumer,
  ): Promise<DesignSessionResumeResult> {
    return sessionLinks.resumeSessionLink(this, environmentId, canvasId, input, resumer);
  }

  // -------------------------------------------------------------------------
  // Legacy API (UI v1 commands, MCP tools and existing tests)
  // -------------------------------------------------------------------------

  async create(
    environmentId: string,
    canvasName = "Untitled design",
    document?: string,
    actor: DesignActor = "agent",
  ): Promise<DesignCanvas> {
    const status = await this.runOnce(environmentId, actor, {
      input: {
        kind: "create_canvas",
        name: canvasName,
        ...(document !== undefined ? { document } : {}),
      },
      preconditions: {},
    });
    return this.get(status.result!.createdCanvasId ?? status.canvasId, environmentId);
  }

  async delete(
    canvasId: string,
    environmentId: string,
    actor: DesignActor = "agent",
  ): Promise<void> {
    const { record } = await this.loadFor(canvasId, environmentId);
    await this.runOnce(environmentId, actor, {
      canvasId,
      input: { kind: "delete_canvas" },
      preconditions: { canvasRevision: record.document.revision },
    });
  }

  async createFrame(
    canvasId: string,
    environmentId: string,
    expectedRevision: number,
    input: Omit<DesignFrame, "id" | "revision">,
    actor: DesignActor = "agent",
  ) {
    const status = await this.runOnce(environmentId, actor, {
      canvasId,
      input: {
        kind: "create_frame",
        frame: {
          name: input.name,
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
          html: input.html,
        },
      },
      preconditions: { canvasRevision: expectedRevision },
    });
    const frame = await this.getFrame(canvasId, environmentId, status.result!.createdFrameId!);
    return { frame, canvasRevision: status.result!.canvasRevision };
  }

  async mutate(
    canvasId: string,
    environmentId: string,
    frameId: string,
    expectedRevision: number,
    update:
      | Partial<Pick<DesignFrame, "name" | "x" | "y" | "width" | "height" | "html">>
      | DesignOperation,
    actor: DesignActor = "agent",
  ) {
    const input = legacyInput(frameId, update);
    const status = await this.runOnce(environmentId, actor, {
      canvasId,
      input,
      preconditions: { frameRevision: expectedRevision },
    });
    const frame = await this.getFrame(canvasId, environmentId, frameId);
    return { frame, canvasRevision: status.result?.canvasRevision ?? frame.revision };
  }

  async undo(
    canvasId: string,
    environmentId: string,
    expectedRevision: number,
    actor: DesignActor = "user",
    scope: "own" | "any" = "own",
  ) {
    return this.legacyHistory(canvasId, environmentId, expectedRevision, "undo", actor, scope);
  }

  async redo(
    canvasId: string,
    environmentId: string,
    expectedRevision: number,
    actor: DesignActor = "user",
    scope: "own" | "any" = "own",
  ) {
    return this.legacyHistory(canvasId, environmentId, expectedRevision, "redo", actor, scope);
  }

  private async legacyHistory(
    canvasId: string,
    environmentId: string,
    expectedRevision: number,
    kind: "undo" | "redo",
    actor: DesignActor,
    scope: "own" | "any",
  ) {
    const status = await this.runOnce(environmentId, actor, {
      canvasId,
      input: { kind, scope },
      preconditions: { canvasRevision: expectedRevision },
    });
    return {
      canvasRevision: status.result!.canvasRevision,
      history: await this.historyStatus(canvasId, environmentId, actor),
    };
  }

  /** Legacy cursor check: content-free events from the record's change list. */
  async changes(
    canvasId: string,
    environmentId: string,
    generation: string | undefined,
    after: number,
  ): Promise<DesignChanges> {
    await this.initialize();
    revision.parse(after);
    const { record } = await this.loadFor(canvasId, environmentId);
    const current = record.document.revision;
    const events = record.changes
      .filter((change) => change.revision > after)
      .map((change) => ({
        canvasId,
        revision: change.revision,
        ...(change.frames.length === 1 ? { frameId: change.frames[0]!.id } : {}),
      }));
    const reset =
      generation !== this.generation ||
      after > current ||
      (after !== current &&
        (events[0]?.revision !== after + 1 || events.at(-1)?.revision !== current));
    return { generation: this.generation, revision: current, reset, events: reset ? [] : events };
  }

  async deleteEnvironment(environmentId: string): Promise<number> {
    await this.initialize();
    return lifecycle.deleteEnvironment(this, environmentId);
  }

  /** Removes canvases whose environment is gone; see {@link lifecycle.sweepOrphanedCanvases}. */
  async sweepOrphanedCanvases(
    liveEnvironmentIds: () => Promise<ReadonlySet<string>>,
    minAgeMs: number,
  ): Promise<number> {
    await this.initialize();
    return lifecycle.sweepOrphanedCanvases(this, liveEnvironmentIds, minAgeMs);
  }

  isTerminal(status: DesignOperationStatus) {
    return DESIGN_TERMINAL_STATES.includes(status.state);
  }

  isRunning(token: string) {
    return this.running.has(token);
  }

  async close() {
    this.closed = true;
    await Promise.allSettled(Array.from(this.running.values()));
    await Promise.allSettled(Array.from(this.background));
    await this.globalTail;
    await Promise.allSettled(Array.from(this.lanes.values()).map((lane) => lane.tail));
    await this.library.flush();
    this.library.close();
    await this.renderer.close();
    await this.coordination.close();
  }

  /** Profiles of design browsers whose backend was killed before it could close them. */
  private async sweepStaleBrowserProfiles(): Promise<void> {
    const removed = (await this.renderer.sweepStaleProfiles?.()) ?? 0;
    if (removed > 0)
      console.warn(
        `[backend] Design startup removed ${removed} stale browser profile${removed === 1 ? "" : "s"}`,
      );
  }

  private async collectStartupOrphans(): Promise<void> {
    const candidates = Array.from(this.library.entries.values())
      .filter((entry) => entry.state === "live" || entry.state === "deleted")
      .slice(0, 256);
    for (const entry of candidates) {
      await this.collectHistoryOrphans(entry.id).catch(() => 0);
    }
  }

  /**
   * Orphaned checkpoint collection, bounded and age-gated. Runs under the
   * canvas lane (its cross-process lease) against the record as it is on disk
   * now, so a checkpoint any process's committed record references is kept;
   * a checkpoint written but not yet referenced is younger than the age gate.
   * A canvas whose record cannot be read keeps every checkpoint.
   */
  async collectHistoryOrphans(canvasId: string): Promise<number> {
    return this.lane(canvasId, async () => {
      const loaded = await this.load(canvasId);
      if (loaded.kind !== "record" || loaded.legacy) return 0;
      return collectOrphans(
        this.store,
        canvasId,
        new Set(loaded.record.history.entries.map((entry) => entry.checkpoint)),
      );
    });
  }
}

function legacyInput(
  frameId: string,
  update:
    Partial<Pick<DesignFrame, "name" | "x" | "y" | "width" | "height" | "html">> | DesignOperation,
): DesignOperationInput {
  if ("op" in update) {
    switch (update.op) {
      case "setStyles":
      case "applyStyles":
        return {
          kind: "set_element_styles",
          frameId,
          selector: update.selector,
          styles: update.styles,
        };
      case "appendHtml":
        return { kind: "append_frame_html", frameId, html: update.html };
      case "replaceElementHtml":
        return {
          kind: "replace_element_html",
          frameId,
          selector: update.selector,
          html: update.html,
        };
      case "moveElement":
        return {
          kind: "move_element",
          frameId,
          selector: update.selector,
          parentSelector: update.parentSelector,
          ...(update.beforeSelector ? { beforeSelector: update.beforeSelector } : {}),
        };
      default:
        throw new DesignError("unsupported", "Unsupported design operation");
    }
  }
  const { html, ...patch } = update;
  if (html !== undefined && Object.keys(patch).length)
    throw new DesignError("invalid-input", "Replace HTML and change geometry in separate edits");
  if (html !== undefined) return { kind: "replace_frame_html", frameId, html };
  return { kind: "update_frame", frameId, patch };
}

/**
 * Retained outcomes that still fit in the pending file beside `live` (which
 * already respects the count and byte bounds). The oldest give way first, so
 * a kept outcome never blocks a new edit; one that gives way answers
 * `unknown`, as it did before outcomes were kept.
 */
function fittingOutcomes(
  retained: DesignPendingOperation[],
  live: DesignPendingOperation[],
): DesignPendingOperation[] {
  const bytes = (entries: DesignPendingOperation[]) =>
    entries.reduce((total, entry) => total + entry.bytes, 0);
  const kept = [...retained];
  while (
    kept.length &&
    (kept.length + live.length > DESIGN_LIMITS.preparedPerCanvas ||
      bytes(kept) + bytes(live) > DESIGN_LIMITS.admittedPayloadBytes)
  )
    kept.shift();
  return kept;
}
