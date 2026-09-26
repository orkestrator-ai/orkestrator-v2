import { randomUUID } from "node:crypto";
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
  type DesignSnapshotResult,
  type DesignSyncResult,
} from "@orkestrator/protocol/design-operations";
import { applyComputed, verifyComputed } from "./design-apply.js";
import { DesignError, designConflict, toDesignFailure } from "./design-errors.js";
import { computeOperation, type ComputedOperation, type RenderPriority } from "./design-execute.js";
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
} from "./design-history.js";
import { DesignLibraryIndex, summarizeRecord, type DesignSummary } from "./design-library.js";
import {
  cloneRecord,
  descriptorDigest,
  migrateLegacy,
  portableBytes,
  pruneReceipts,
  DesignRecordStore,
  type DesignHistoryEntryRecord,
  type DesignPendingOperation,
  type DesignPrivateRecord,
  type DesignStorageFaults,
} from "./design-records.js";
import { DesignRenderer } from "./design-renderer.js";
import { descriptorSchema, designId, operationToken, revision } from "./design-schemas.js";
import { buildSync, snapshotEnvelope, tombstone } from "./design-sync.js";
import * as lifecycle from "./design-service-lifecycle.js";
import * as validation from "./design-validation.js";

// Portable schemas remain importable from their historic module.
export { canvasSchema, designId, frameSchema, htmlSchema, revision } from "./design-schemas.js";

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
>;

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

/**
 * Backend-owned design documents. Every document change and its terminal
 * operation receipt become authoritative together in one atomic record
 * replacement. Rendering never happens while a canvas lane or the global
 * guard is held.
 *
 * Lock order: global guard, then one canvas lane. Never wait for the renderer
 * or for the global guard while holding a lane.
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
  private readonly cache = new Map<string, { record: DesignPrivateRecord; bytes: number }>();
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
    readonly renderer: DesignRendererLike = new DesignRenderer(),
    options: DesignServiceOptions = {},
  ) {
    this.store = new DesignRecordStore(dataDir, options.faults);
    this.library = new DesignLibraryIndex(this.store.root);
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
    const run = current.tail.then(work);
    current.tail = run.catch(() => undefined);
    return run.finally(() => {
      current.depth--;
      if (current.depth === 0 && this.lanes.get(canvasId) === current) this.lanes.delete(canvasId);
    });
  }

  global<T>(work: () => Promise<T>): Promise<T> {
    const run = this.globalTail.then(work);
    this.globalTail = run.catch(() => undefined);
    return run;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= (async () => {
      await this.store.ensure();
      const persisted = await this.library.load();
      const ids = (await this.store.ids()).slice(0, 4096);
      let index = 0;
      const worker = async () => {
        while (index < ids.length) {
          const id = ids[index++]!;
          await this.indexCanvas(id, persisted.get(id));
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
      // Each recovery step degrades independently: one bad file must not make
      // every design unavailable.
      await this.startupStep("pending recovery", () => this.recoverPending());
      await this.startupStep("state recovery", () => this.recoverStartupState());
      await this.startupStep("reservation expiry", () => lifecycle.expireProvisional(this));
      await this.startupStep("recycle bin", () => lifecycle.enforceRecycleBin(this));
      // Checkpoints written before a crash but never referenced are collected
      // in the background (age-gated so an in-progress writer is never raced).
      this.track(this.collectStartupOrphans());
      this.library.persistSoon();
      this.initialized = true;
    })().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
  }

  private async indexCanvas(id: string, cached: DesignSummary | undefined): Promise<void> {
    const file = await this.store.fileStat(id);
    if (!file) return;
    if (
      cached &&
      cached.fileSize === file.size &&
      cached.fileMtimeMs === file.mtimeMs &&
      Boolean(cached.legacy) === (file.kind === "legacy")
    ) {
      this.library.entries.set(id, cached);
      return;
    }
    const read = await this.store.read(id);
    if (read.kind === "record") {
      this.library.entries.set(id, summarizeRecord(read.record, file));
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
      });
    }
  }

  /**
   * Finishes work a previous process may have left half done:
   * - an interrupted migration (record committed, legacy file still in place)
   *   retires the verified legacy copy to the bounded backup directory;
   * - an export still marked "writing" belongs to a dead process, so its
   *   outcome is unknown until reconciled against the destination.
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
        if (pending?.state !== "writing") return;
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

  /** Admitted work that has no terminal receipt did not commit: report it interrupted. */
  private async recoverPending(): Promise<void> {
    for (const id of await this.store.pendingIds()) {
      await this.startupStep("pending recovery for one design", () => this.recoverPendingFor(id));
    }
  }

  private async recoverPendingFor(id: string): Promise<void> {
    {
      const entries = await this.store.readPending(id);
      if (!entries.length) return;
      const loaded = await this.load(id);
      if (loaded.kind !== "record" || loaded.legacy) {
        await this.store.writePending(id, []);
        return;
      }
      const record = cloneRecord(loaded.record);
      const settled = new Set(record.receipts.map((receipt) => receipt.token));
      let changed = false;
      for (const entry of entries) {
        if (settled.has(entry.token)) continue;
        record.receipts.push(
          this.receipt(entry, "interrupted", {
            failure: {
              code: "unknown-outcome",
              message:
                "The backend restarted before this edit committed. It was not applied; review and submit it again.",
              retry: "review",
            },
          }),
        );
        changed = true;
      }
      if (changed && record.state !== "provisional") {
        record.statusVersion++;
        await this.commit(record, false);
      }
      await this.store.writePending(id, []);
    }
  }

  // -------------------------------------------------------------------------
  // Record access and commits
  // -------------------------------------------------------------------------

  /** Committed record (never mutate); legacy documents are migrated in memory. */
  async load(id: string): Promise<LoadedRecord> {
    designId.parse(id);
    const cached = this.cache.get(id);
    if (cached) {
      this.cache.delete(id);
      this.cache.set(id, cached);
      return { kind: "record", record: cached.record, legacy: false };
    }
    const read = await this.store.read(id);
    if (read.kind === "record") {
      this.remember(read.record, read.bytes);
      return { kind: "record", record: read.record, legacy: false };
    }
    if (read.kind === "legacy")
      return { kind: "record", record: migrateLegacy(read.canvas, read.mtime), legacy: true };
    return read;
  }

  /** Loads a canvas the environment may see. Other environments get `not-found`. */
  async loadFor(
    id: string,
    environmentId: string,
    options: { allowDeleted?: boolean; allowProvisional?: boolean } = {},
  ): Promise<{ record: DesignPrivateRecord; legacy: boolean }> {
    designId.parse(id);
    if (this.fences.has(environmentId))
      throw new DesignError("not-found", "Canvas not found in this environment");
    const loaded = await this.load(id);
    if (loaded.kind === "missing")
      throw new DesignError("not-found", "Canvas not found in this environment");
    // A record from another environment is "not found", even when unreadable.
    if (loaded.kind === "problem" && this.library.entries.get(id)?.environmentId !== environmentId)
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

  private remember(record: DesignPrivateRecord, bytes: number) {
    const previous = this.cache.get(record.canvasId);
    if (previous) this.cacheBytes -= previous.bytes;
    this.cache.delete(record.canvasId);
    this.cache.set(record.canvasId, { record, bytes });
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
    if (this.fences.has(record.environmentId))
      throw new DesignError("not-found", "Canvas not found in this environment");
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
    this.remember(record, bytes);
    if (legacy) {
      await this.store.retireLegacy(record.canvasId).catch((error: unknown) => {
        console.warn(
          "[backend] Could not retire a migrated legacy design:",
          (error as NodeJS.ErrnoException)?.code,
        );
      });
    }
    const file = await this.store.fileStat(record.canvasId);
    this.library.upsert(summarizeRecord(record, file ?? { size: bytes, mtimeMs: Date.now() }));
    if (hint) this.publish({ canvasId: record.canvasId, ...hint });
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
      const { record } = await this.loadFor(canvasId, environmentId, {
        allowDeleted: descriptor.input.kind === "restore_canvas",
      });
      const now = this.now();
      // Settled and expired entries are compacted away here, lazily.
      const pending = this.livePending(record, await this.store.readPending(canvasId));
      const digest = descriptorDigest({ environmentId, canvasId, descriptor });
      if (descriptor.correlationId) {
        const existing =
          pending.find((entry) => entry.descriptor.correlationId === descriptor.correlationId) ??
          record.receipts.find((receipt) => receipt.correlationId === descriptor.correlationId);
        if (existing) {
          const existingDigest = "digest" in existing ? existing.digest : undefined;
          if (existingDigest !== undefined && existingDigest !== digest)
            throw new DesignError(
              "invalid-input",
              "This correlation id was already used for a different edit",
            );
          if ("digest" in existing)
            return {
              token: existing.token,
              canvasId,
              state: "prepared",
              expiresAt: existing.expiresAt,
            };
          throw new DesignError(
            "invalid-input",
            "This correlation id already has a settled operation",
            {
              details: { token: existing.token },
            },
          );
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
      };
      await this.store.writePending(canvasId, [...pending, entry]);
      return { token: entry.token, canvasId, state: "prepared", expiresAt: entry.expiresAt };
    });
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
    const unrecorded = this.unrecorded.get(token);
    if (
      unrecorded &&
      unrecorded.canvasId === canvasId &&
      record.environmentId === environmentId &&
      !this.running.has(token)
    )
      return unrecorded;
    const entry = (await this.store.readPending(canvasId)).find(
      (candidate) => candidate.token === token,
    );
    if (entry && entry.environmentId === environmentId) {
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
      next.receipts.push(canceled);
      pruneReceipts(next);
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
      const entry = pending.find((candidate) => candidate.token === token);
      if (!entry || entry.environmentId !== environmentId || entry.canvasId !== canvasId)
        return { done: await this.status(environmentId, canvasId, token) } as const;
      if (entry.state === "executing") return { done: this.receipt(entry, "executing") } as const;
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
      // pending entry into an `interrupted` receipt, so admission is tracked
      // in memory (`running`) and costs no extra write.
      this.admit(canvasId, entry.bytes);
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
      record.receipts.push(receipt);
      pruneReceipts(record);
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
    record.receipts.push(receipt);
    pruneReceipts(record);
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

  private async settle(
    record: DesignPrivateRecord,
    legacy: boolean,
    pending: DesignPendingOperation[],
    entry: DesignPendingOperation,
    state: "rejected" | "expired",
    failure: DesignFailure,
  ): Promise<DesignOperationStatus> {
    const receipt = this.receipt(entry, state, { failure });
    if (record.state === "provisional") {
      await this.dropPending(entry.canvasId, pending, entry.token);
      return receipt;
    }
    const next = cloneRecord(record);
    next.receipts.push(receipt);
    pruneReceipts(next);
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
    for (
      let attempts = 0;
      attempts < 64 && this.historyTotal() > DESIGN_LIMITS.historyBytesGlobal;
      attempts++
    ) {
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
    if (this.fences.has(environmentId)) return { kind: "missing", ...base };
    const loaded = await this.load(canvasId);
    if (loaded.kind === "missing") return { kind: "missing", ...base };
    if (loaded.kind === "problem") {
      const summary = this.library.entries.get(canvasId);
      if (summary?.environmentId !== environmentId) return { kind: "missing", ...base };
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
    return Array.from(this.library.entries.values())
      .filter((entry) => entry.environmentId === environmentId && entry.state === "live")
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id))
      .map((entry) => ({ id: entry.id, name: entry.name, revision: entry.revision }));
  }

  async libraryPage(environmentId: string, query: DesignLibraryQuery): Promise<DesignLibraryPage> {
    await this.initialize();
    return this.library.query(environmentId, query);
  }

  hasCanvases(environmentId: string): boolean {
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

  async linkSession(
    environmentId: string,
    canvasId: string,
    link: Omit<DesignSessionLink, "id" | "createdAt">,
    replaceId?: string,
  ): Promise<DesignSessionLink> {
    await this.initialize();
    return this.lane(canvasId, async () => {
      const { record, legacy } = await this.loadFor(canvasId, environmentId);
      const next = cloneRecord(record);
      const existing = next.sessions.find((candidate) => candidate.tabId === link.tabId);
      if (existing) {
        Object.assign(existing, link);
      } else {
        if (replaceId)
          next.sessions = next.sessions.filter((candidate) => candidate.id !== replaceId);
        if (next.sessions.length >= DESIGN_LIMITS.sessionLinksPerCanvas)
          throw new DesignError(
            "capacity",
            "This design already links eight conversations; replace one",
            {
              retry: "review",
            },
          );
        next.sessions.push({ ...link, id: randomUUID().slice(0, 12), createdAt: this.iso() });
      }
      next.statusVersion++;
      await this.commit(next, legacy, {
        revision: next.document.revision,
        kind: "status",
        statusVersion: next.statusVersion,
      });
      return next.sessions.find((candidate) => candidate.tabId === link.tabId)!;
    });
  }

  async unlinkSession(environmentId: string, canvasId: string, linkId: string): Promise<void> {
    await this.initialize();
    await this.lane(canvasId, async () => {
      const { record, legacy } = await this.loadFor(canvasId, environmentId, {
        allowDeleted: true,
      });
      if (!record.sessions.some((candidate) => candidate.id === linkId)) return;
      const next = cloneRecord(record);
      next.sessions = next.sessions.filter((candidate) => candidate.id !== linkId);
      next.statusVersion++;
      await this.commit(next, legacy, {
        revision: next.document.revision,
        kind: "status",
        statusVersion: next.statusVersion,
      });
    });
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
  }

  private async collectStartupOrphans(): Promise<void> {
    const candidates = Array.from(this.library.entries.values())
      .filter((entry) => entry.state === "live" || entry.state === "deleted")
      .slice(0, 256);
    for (const entry of candidates) {
      await this.lane(entry.id, () => this.collectHistoryOrphans(entry.id)).catch(() => 0);
    }
  }

  /** Orphaned checkpoint collection, bounded and age-gated. */
  async collectHistoryOrphans(canvasId: string): Promise<number> {
    const loaded = await this.load(canvasId);
    if (loaded.kind !== "record") return 0;
    return collectOrphans(
      this.store,
      canvasId,
      new Set(loaded.record.history.entries.map((entry) => entry.checkpoint)),
    );
  }
}

function legacyInput(
  frameId: string,
  update:
    | Partial<Pick<DesignFrame, "name" | "x" | "y" | "width" | "height" | "html">>
    | DesignOperation,
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
