import { deletionMarker, markDeletion } from "./storage-deletion-fences.js";
/**
 * Durable per-environment storage for web annotations.
 *
 * Metadata lives in the backend database, one envelope store per environment
 * (`web-annotations/<environment-id>`, layout and collections in
 * `web-annotation-store-layout.ts`, row codec in `web-annotation-store-rows.ts`):
 * the listing index, drafts, operation receipts, and the immutable records
 * (captures, entries, request briefs, results, draft text). Files stay files
 * under `<dataDir>/web-annotations/<environment-id>/`:
 *
 *   assets/<asset-id>.png    validated images (rows hold their metadata)
 *   staging/                 uploads not yet promoted into assets/
 *   migration-backups/       private copies of migrated legacy chat drafts
 *
 * A mutation is: asynchronous preparation outside (image staging and
 * promotion into `assets/`), then ONE synchronous IMMEDIATE transaction that
 * revalidates the in-memory model against the store revision (reloading what
 * another backend committed), runs the caller's synchronous `work` against a
 * copy-on-write working manifest (`web-annotation-working-manifest.ts`), and
 * serializes and writes only the rows it changed plus the environment revision. SQLite's write
 * lock serializes that transaction against every connection and process, so
 * two backends sharing a data directory never lose each other's updates. The
 * per-environment FIFO only orders this process's writes and bounds them.
 * Change hints, metrics and file removals happen only after the commit.
 *
 * Every read revalidates against the committed store revision (one indexed
 * lookup), so another process's commits are visible before they are used.
 * The old file layout (`manifest.json`, `drafts.json`, `records/`) is imported
 * lazily on first access by `web-annotation-legacy-import.ts`.
 */
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_DEGRADED,
  WEB_ANNOTATION_LIMITS,
  formatWebAnnotationError,
  isWebAnnotationRequestActive,
  webAnnotationUtf8Bytes,
  type WebAnnotationCapacityResource,
  type WebAnnotationErrorDetail,
  type WebAnnotationStorageStatus,
} from "@orkestrator/protocol/web-annotations";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import {
  WEB_ANNOTATION_MAX_RECORD_BYTES,
  archiveLegacyEnvironment,
  hasLegacyFiles,
  readLegacyEnvironment,
  removeArchivedLegacyEnvironment,
} from "./web-annotation-legacy-import.js";
import {
  WEB_ANNOTATION_STORE_PREFIX,
  webAnnotationStoreName,
} from "./web-annotation-store-layout.js";
import {
  WEB_ANNOTATION_STORE_FORMAT,
  WEB_ANNOTATION_STORE_VERSION,
  assembleSnapshot,
  assertSameRowPlan,
  committedStoreRevision,
  defaultMeta,
  deleteAllRows,
  deleteRecordRows,
  emptySnapshot,
  hasAssetRow,
  freezeRowValue,
  planChangedRows,
  planRows,
  readIndexSnapshot,
  readMetaRow,
  readRecordRow,
  recordKey,
  writeIndexRows,
  writeRecordRows,
  type StoreSnapshot,
  type WebAnnotationStoreMeta,
} from "./web-annotation-store-rows.js";
import { WorkingManifest, type EditableCollection } from "./web-annotation-working-manifest.js";
import {
  WebAnnotationStorageError,
  isRecord,
  type ManifestDraft,
  type WebAnnotationManifest,
  type WebAnnotationRecordKind,
} from "./web-annotation-storage-format.js";

export {
  WEB_ANNOTATION_DRAFTS_FORMAT,
  WEB_ANNOTATION_DRAFTS_VERSION,
  WEB_ANNOTATION_MANIFEST_FORMAT,
  WEB_ANNOTATION_MANIFEST_VERSION,
  WebAnnotationStorageError,
  emptyManifest,
  recordDirectoryName,
  requestTextRecordId,
  type ManifestAsset,
  type ManifestCapture,
  type ManifestDraft,
  type ManifestEntry,
  type ManifestMigration,
  type ManifestMigrationDraftState,
  type ManifestMigrationOwnership,
  type ManifestMigrationScreenshot,
  type ManifestReceipt,
  type ManifestResult,
  type WebAnnotationManifest,
  type WebAnnotationRecordKind,
} from "./web-annotation-storage-format.js";
export { WEB_ANNOTATION_MAX_RECORD_BYTES } from "./web-annotation-legacy-import.js";

/**
 * Failure-injection points. All but cleanup, after-commit and legacy batch hooks run
 * synchronously inside the commit transaction (a returned promise is not
 * awaited); throwing there rolls the whole commit back.
 */
export type WebAnnotationFaultStage =
  | "before-record-write"
  | "before-manifest-replace"
  | "after-commit"
  | "before-drafts-replace"
  | "during-cleanup"
  | "after-legacy-record-batch";

export type WebAnnotationFaultHook = (
  stage: WebAnnotationFaultStage,
  environmentId: string,
) => void | Promise<void>;

export interface WebAnnotationCommitHint {
  environmentId: string;
  revision: number;
  annotationIds: string[];
  requestIds: string[];
}

/** Content-free commit facts for metrics. `previous`/`next` must not be retained. */
export interface WebAnnotationCommitObservation {
  environmentId: string;
  scope: "manifest" | "drafts";
  durationMs: number;
  /** Serialized bytes of the environment's index rows after the commit. */
  indexBytes: number;
  records: number;
  requestIds: readonly string[];
  /** Annotations the commit touched (empty for draft commits). */
  annotationIds: readonly string[];
  /**
   * Index rows the commit serialized to plan its writes. Bounded by the rows
   * it changed, not by the size of the collection.
   */
  rowsSerialized: number;
  /** Collections the commit shallow-copied (pointer copies; no row is cloned). */
  collectionsCopied: number;
  previous: Readonly<WebAnnotationManifest>;
  next: Readonly<WebAnnotationManifest>;
}

export interface WebAnnotationStorageOptions {
  dataDir: string;
  clock?: () => number;
  faults?: WebAnnotationFaultHook;
  /**
   * Called after every commit by this process, and when a read observes that
   * another process advanced the environment revision.
   */
  onCommit?: (hint: WebAnnotationCommitHint) => void;
  /** Synchronous, must not throw; failures are swallowed. */
  observeCommit?: (observation: WebAnnotationCommitObservation) => void;
  /** Directory fsync of staged uploads is best-effort; tests may disable it. */
  syncDirectories?: boolean;
  /** A connection to use instead of opening (and owning) one. */
  database?: StorageDatabase;
  /**
   * Also run the full row diff on every commit and refuse (roll back) one
   * whose incremental plan differs. Defaults to on under `bun test`.
   */
  verifyRowPlans?: boolean;
}

export function storageCapacityError(
  message: string,
  resource: WebAnnotationCapacityResource,
  usage: { used?: number; limit?: number; requested?: number } = {},
): WebAnnotationStorageError {
  return new WebAnnotationStorageError(
    formatWebAnnotationError(`${WEB_ANNOTATION_CAPACITY} ${message}`, {
      code: "capacity",
      resource,
      ...usage,
    }),
  );
}

function degradedError(
  reason: string,
  detail?: WebAnnotationErrorDetail,
): WebAnnotationStorageError {
  return new WebAnnotationStorageError(
    formatWebAnnotationError(
      `${WEB_ANNOTATION_DEGRADED} ${reason}`,
      detail ?? { code: "degraded" },
    ),
  );
}

export async function writeDurable(path: string, data: string | Buffer): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Best-effort: unsupported on some platforms.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

interface PendingRecordWrite {
  kind: WebAnnotationRecordKind;
  id: string;
  revision: number;
  key: string;
  json: string;
  bytes: number;
}

function encodeRecord(
  kind: WebAnnotationRecordKind,
  id: string,
  revision: number,
  value: unknown,
): PendingRecordWrite {
  const json = JSON.stringify({ kind, value });
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > WEB_ANNOTATION_MAX_RECORD_BYTES) {
    throw storageCapacityError("record exceeds 1 MiB", "record-bytes", {
      used: bytes,
      limit: WEB_ANNOTATION_MAX_RECORD_BYTES,
    });
  }
  return { kind, id, revision, key: recordKey(id, revision), json, bytes };
}

type RecordReader = (kind: WebAnnotationRecordKind, id: string, revision: number) => unknown;

/**
 * One mutation's working set. `manifest` is a copy-on-write working copy
 * (`web-annotation-working-manifest.ts`): committed rows are frozen, so a
 * change replaces a row (`manifest.requests[id] = { ...request, state }`) or
 * edits the private clone `edit` returns.
 */
export class WebAnnotationTransaction {
  readonly records: PendingRecordWrite[] = [];
  readonly dropRecords: Array<{ id: string; revision: number }> = [];
  readonly dropDraftRecords: Array<{ id: string; revision: number; bytes: number }> = [];
  readonly dropAssets: string[] = [];
  readonly annotationIds = new Set<string>();
  readonly requestIds = new Set<string>();
  private changed = false;
  private bypassQuota = false;

  constructor(
    private readonly working: WorkingManifest,
    readonly now: string,
    readonly nowMs: number,
    private readonly reader: RecordReader,
  ) {}

  get manifest(): WebAnnotationManifest {
    return this.working.manifest;
  }
  /**
   * A mutable clone of one committed row, put in its place: edits to it
   * commit with the transaction. `undefined` when the row does not exist.
   */
  edit<C extends EditableCollection>(
    collection: C,
    key: string,
  ): WebAnnotationManifest[C][string] | undefined {
    return this.working.edit(collection, key);
  }
  get dirty(): boolean {
    return this.changed;
  }
  get essential(): boolean {
    return this.bypassQuota;
  }
  /** Mark the transaction as changed without naming ids (receipts, GC). */
  markDirty(): void {
    this.changed = true;
  }
  /** Progress, receipts, and cleanup must never fail on the metadata quota. */
  markEssential(): void {
    this.bypassQuota = true;
  }
  touch(ids: { annotationIds?: Iterable<string>; requestIds?: Iterable<string> }): void {
    this.changed = true;
    for (const id of ids.annotationIds ?? []) this.annotationIds.add(id);
    for (const id of ids.requestIds ?? []) this.requestIds.add(id);
  }
  /** Stage an immutable record row; returns its serialized size. */
  writeRecord(kind: WebAnnotationRecordKind, id: string, revision: number, value: unknown): number {
    const record = encodeRecord(kind, id, revision, value);
    this.records.push(record);
    this.changed = true;
    return record.bytes;
  }
  /**
   * Read a committed (or this transaction's) record synchronously, inside the
   * commit. Throws `WebAnnotationStorageError` when it is missing or damaged.
   */
  readRecord<T>(kind: WebAnnotationRecordKind, id: string, revision: number): T {
    const pending = this.records.find((record) => record.id === id && record.revision === revision);
    if (pending) {
      if (pending.kind !== kind) {
        throw new WebAnnotationStorageError(
          "record does not match its reference",
          "record-invalid",
        );
      }
      return (JSON.parse(pending.json) as { value: T }).value;
    }
    return this.reader(kind, id, revision) as T;
  }
  /** A record the listing index stops referencing; removed in the same commit. */
  dropRecordAfterCommit(id: string, revision: number, _bytes?: number): void {
    this.dropRecords.push({ id, revision });
    this.changed = true;
  }
  /** A draft text record whose draft this commit removes. */
  dropDraftRecordAfterCommit(id: string, revision: number, bytes: number): void {
    this.dropDraftRecords.push({ id, revision, bytes });
    this.changed = true;
  }
  dropAssetAfterCommit(assetId: string): void {
    this.dropAssets.push(assetId);
    this.changed = true;
  }
}

/** A draft-only mutation: edits a private copy of the draft index. */
export class WebAnnotationDraftTransaction {
  readonly records: PendingRecordWrite[] = [];
  readonly dropRecords: Array<{ id: string; revision: number; bytes: number }> = [];
  private changed = false;

  constructor(
    readonly manifest: Readonly<WebAnnotationManifest>,
    readonly drafts: Record<string, ManifestDraft>,
    readonly now: string,
    readonly nowMs: number,
  ) {}

  get dirty(): boolean {
    return this.changed;
  }
  markDirty(): void {
    this.changed = true;
  }
  writeRecord(id: string, revision: number, value: unknown): number {
    const record = encodeRecord("draft", id, revision, value);
    this.records.push(record);
    this.changed = true;
    return record.bytes;
  }
  dropRecordAfterCommit(id: string, revision: number, bytes: number): void {
    this.dropRecords.push({ id, revision, bytes });
    this.changed = true;
  }
}

export interface WebAnnotationCommitResult<T> {
  value: T;
  revision: number;
  committed: boolean;
}

/**
 * Mutation body. It runs inside the commit transaction, so it must be
 * synchronous: a returned promise is refused and nothing commits.
 */
export type WebAnnotationWork<Tx, T> = (tx: Tx) => T;

const DRAFT_SCOPE: ReadonlySet<string> = new Set(["drafts", "meta"]);
/** Bytes of record rows written per transaction while importing legacy files. */
const IMPORT_BATCH_BYTES = 4 * 1024 * 1024;

interface CommitOutcome<T> {
  value: T;
  committed: boolean;
  next?: StoreSnapshot;
  previous?: StoreSnapshot;
  records?: number;
  rowsSerialized?: number;
  collectionsCopied?: number;
  dropAssets?: readonly string[];
  annotationIds?: readonly string[];
  requestIds?: readonly string[];
}

interface EnvironmentHost {
  database(): StorageDatabase;
  /** Another process deleted the environment's store. */
  deletedElsewhere(environmentId: string): void;
}

/** Storage for one environment. Created and owned by `WebAnnotationStorage`. */
export class WebAnnotationEnvironmentStore {
  readonly dir: string;
  readonly storeName: string;
  private snapshot: StoreSnapshot;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private deleted = false;
  private storageStatus: WebAnnotationStorageStatus = "ready";
  private draftsStatus: WebAnnotationStorageStatus = "ready";
  private reason: string | undefined;
  private reasonDetail: WebAnnotationErrorDetail | undefined;
  /** Unavailable without a store: the legacy files could not be imported. */
  private loadFailure: { reason: string; detail?: WebAnnotationErrorDetail } | null = null;
  private readonly runtimeUnavailable = new Map<string, string>();
  private derived: { snapshot: StoreSnapshot; unavailable: Map<string, string> } | null = null;
  private active: { snapshot: StoreSnapshot; ids: string[] } | null = null;
  private readonly activeStaging = new Set<string>();
  private pendingHints: WebAnnotationCommitHint[] = [];
  private hintFlushScheduled = false;
  /** Hints for foreign commits start after the first load (the ring's base). */
  private loaded = false;

  constructor(
    readonly environmentId: string,
    root: string,
    private readonly options: WebAnnotationStorageOptions,
    private readonly host: EnvironmentHost,
  ) {
    this.dir = join(root, environmentId);
    this.storeName = webAnnotationStoreName(environmentId);
    this.snapshot = emptySnapshot(environmentId, new Date(this.nowMs()).toISOString());
  }

  private nowMs(): number {
    return this.options.clock?.() ?? Date.now();
  }
  private db(): StorageDatabase {
    return this.host.database();
  }
  private get verifyRowPlans(): boolean {
    return this.options.verifyRowPlans ?? process.env.NODE_ENV === "test";
  }

  /** The committed manifest, revalidated against other processes' commits. */
  get manifest(): Readonly<WebAnnotationManifest> {
    this.refresh();
    this.assertReadable();
    return this.snapshot.manifest;
  }
  get status(): WebAnnotationStorageStatus {
    this.refreshQuietly();
    return this.storageStatus;
  }
  get degradedReason(): string | undefined {
    this.refreshQuietly();
    return this.reason;
  }
  get draftStatus(): WebAnnotationStorageStatus {
    this.refreshQuietly();
    return this.storageStatus === "ready" ? this.draftsStatus : this.storageStatus;
  }
  get revision(): number {
    this.refresh();
    return this.snapshot.manifest.revision;
  }
  /** Committed metadata bytes: index rows plus record rows (row JSON length). */
  get metadataBytes(): number {
    this.refresh();
    return this.snapshot.indexBytes + this.snapshot.manifest.usage.recordBytes;
  }
  /** Ids of requests that are still active (may execute or are unsettled). */
  activeRequestIds(): string[] {
    this.refreshQuietly();
    const snapshot = this.snapshot;
    if (this.active?.snapshot !== snapshot) {
      const ids = Object.values(snapshot.manifest.requests)
        .filter((request) => isWebAnnotationRequestActive(request.state))
        .map((request) => request.id);
      this.active = { snapshot, ids };
    }
    return [...this.active.ids];
  }
  unavailableReason(annotationId: string): string | undefined {
    this.refreshQuietly();
    return this.runtimeUnavailable.get(annotationId) ?? this.derivedUnavailable().get(annotationId);
  }
  /** In-memory only: an unreadable referenced record degrades that item. */
  markUnavailable(annotationId: string, reason: string): void {
    if (!this.runtimeUnavailable.has(annotationId)) {
      console.warn(`[web-annotations] Record unavailable (${reason})`);
    }
    this.runtimeUnavailable.set(annotationId, reason);
  }

  /** Items whose records the legacy import found missing or damaged. */
  private derivedUnavailable(): Map<string, string> {
    const snapshot = this.snapshot;
    if (this.derived?.snapshot === snapshot) return this.derived.unavailable;
    const unavailable = new Map<string, string>();
    const mark = (annotationIds: Iterable<string>, reason: string) => {
      for (const id of annotationIds) if (!unavailable.has(id)) unavailable.set(id, reason);
    };
    const { manifest, unreadable } = snapshot;
    if (unreadable.size > 0) {
      for (const marker of unreadable.values()) {
        const request = marker.requestId ? manifest.requests[marker.requestId] : undefined;
        if (marker.kind === "request-text" && request) {
          mark(
            request.selections.map((selection) => selection.annotationId),
            "request record unreadable",
          );
        }
      }
      for (const annotation of Object.values(manifest.annotations)) {
        if (annotation.state === "deleted") continue;
        const marker = unreadable.get(recordKey(annotation.currentCaptureId, 1));
        if (marker?.kind === "capture") mark([annotation.id], `capture record ${marker.state}`);
      }
      for (const request of Object.values(manifest.requests)) {
        if (!isWebAnnotationRequestActive(request.state)) continue;
        const marker = unreadable.get(recordKey(request.id, 1));
        if (marker?.kind === "brief") {
          mark(
            request.selections.map((selection) => selection.annotationId),
            `request record ${marker.state}`,
          );
        }
      }
    }
    this.derived = { snapshot, unavailable };
    return unavailable;
  }

  private assertReadable(): void {
    if (this.deleted) throw new WebAnnotationStorageError("Environment was deleted");
    if (this.storageStatus === "unavailable") {
      throw degradedError(this.reason ?? "environment storage is unreadable", this.reasonDetail);
    }
  }
  private assertWritable(): void {
    if (this.deleted) throw new WebAnnotationStorageError("Environment was deleted");
    if (this.closed)
      throw new WebAnnotationStorageError("Environment annotation storage is closed");
    if (this.storageStatus !== "ready") {
      throw degradedError(this.reason ?? "environment storage is read-only", this.reasonDetail);
    }
  }
  private assertDraftsWritable(): void {
    this.assertWritable();
    if (this.draftsStatus !== "ready") {
      throw degradedError(
        this.draftsStatus === "degraded"
          ? "the draft index is damaged; drafts are read-only"
          : "the draft index is unreadable",
      );
    }
  }
  assertDraftsReadable(): void {
    this.refresh();
    this.assertReadable();
    if (this.draftsStatus === "unavailable") throw degradedError("the draft index is unreadable");
  }

  assetPath(assetId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(assetId) || assetId.includes("..")) {
      throw new WebAnnotationStorageError("Asset id is invalid");
    }
    return join(this.dir, "assets", `${assetId}.png`);
  }

  // -------------------------------------------------------------------------
  // Loading and revalidation

  /**
   * First access in this process: import the legacy files if this
   * environment has no store yet, then load the committed rows.
   */
  async load(): Promise<void> {
    const database = this.db();
    const meta = readMetaRow(database, this.storeName);
    if (meta === null) {
      await this.importLegacy();
    } else {
      await this.repairRetainedLegacy(meta);
      await this.archiveLeftovers(readMetaRow(database, this.storeName) ?? meta);
    }
    this.refresh();
    this.applyLoadFailure();
    this.loaded = true;
  }

  private async importLegacy(): Promise<void> {
    if (!(await hasLegacyFiles(this.dir))) return;
    const database = this.db();
    // One importer at a time across processes; the meta row is the marker.
    const release = await database.acquireLease(
      `${this.storeName}/import`,
      "web annotation import",
      { staleMs: 60_000, acquireTimeoutMs: 120_000 },
    );
    let archive = false;
    try {
      this.assertNotDeleted();
      if (readMetaRow(database, this.storeName) !== null) return;
      const now = new Date(this.nowMs()).toISOString();
      let result: Awaited<ReturnType<typeof readLegacyEnvironment>>;
      try {
        result = await readLegacyEnvironment(this.dir, this.environmentId, now);
      } catch (error) {
        console.warn(
          `[web-annotations] Legacy storage unreadable (code=${errorCode(error) ?? "error"})`,
        );
        this.loadFailure = { reason: "environment storage is unreadable" };
        return;
      }
      if (result.kind === "absent") return;
      if (result.kind === "unavailable") {
        this.loadFailure = {
          reason: result.reason,
          ...(result.detail ? { detail: result.detail } : {}),
        };
        return;
      }
      const legacy = result.legacy;
      // A crashed earlier attempt may have left record rows without a header.
      database.transaction(() => {
        this.assertNotDeleted();
        if (readMetaRow(database, this.storeName) === null) {
          deleteAllRows(database, this.storeName);
        }
      });
      let batch: typeof legacy.records = [];
      let batchBytes = 0;
      const flush = () => {
        const rows = batch;
        batch = [];
        batchBytes = 0;
        return database.transaction(() => {
          this.assertNotDeleted();
          if (readMetaRow(database, this.storeName) !== null) return false;
          writeRecordRows(database, this.storeName, rows);
          return true;
        });
      };
      for (const record of legacy.records) {
        batch.push(record);
        batchBytes += record.bytes;
        if (batchBytes >= IMPORT_BATCH_BYTES) {
          if (!flush()) return;
          await this.options.faults?.("after-legacy-record-batch", this.environmentId);
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      const imported = database.transaction(() => {
        this.assertNotDeleted();
        if (readMetaRow(database, this.storeName) !== null) return false;
        if (batch.length > 0) writeRecordRows(database, this.storeName, batch);
        const manifest = legacy.manifest;
        const recordBytes = legacy.records.reduce((sum, record) => sum + record.bytes, 0);
        manifest.usage = { recordBytes };
        const meta: WebAnnotationStoreMeta = {
          ...defaultMeta(this.environmentId, manifest.createdAt),
          updatedAt: manifest.updatedAt,
          revision: manifest.revision,
          recordBytes,
          status: legacy.status,
          ...(legacy.reason ? { reason: legacy.reason } : {}),
          draftsStatus: legacy.draftsStatus,
          source: legacy.sourceVersion === 1 ? "legacy-v1" : "legacy-v2",
          importedAt: now,
          ...(legacy.clean ? {} : { legacyRetained: true }),
        };
        const plan = planRows(
          emptySnapshot(this.environmentId, now),
          manifest,
          meta,
          legacy.unreadable,
        );
        writeIndexRows(database, this.storeName, plan.upserts, []);
        return true;
      });
      archive = imported && legacy.clean;
    } finally {
      await release();
    }
    if (archive) {
      await archiveLegacyEnvironment(this.options.dataDir, this.environmentId).catch(
        (error: unknown) => {
          console.warn(
            `[web-annotations] Could not archive imported legacy files (code=${errorCode(error) ?? "error"})`,
          );
        },
      );
    }
  }

  private assertNotDeleted(): void {
    if (deletionMarker(this.db(), "annotations", this.environmentId)) {
      this.markDeletedElsewhere();
      throw new WebAnnotationStorageError("Environment was deleted");
    }
  }

  /** Retry retained recovery data on reopen, without replacing newer database edits. */
  private async repairRetainedLegacy(metaJson: string): Promise<void> {
    let meta: WebAnnotationStoreMeta;
    try {
      meta = JSON.parse(metaJson) as WebAnnotationStoreMeta;
    } catch {
      return;
    }
    if (!meta.legacyRetained) return;
    const database = this.db();
    const release = await database.acquireLease(`${this.storeName}/import`, "annotation repair", {
      staleMs: 60_000,
      acquireTimeoutMs: 120_000,
    });
    let archive = false;
    try {
      this.assertNotDeleted();
      const now = new Date(this.nowMs()).toISOString();
      const result = await readLegacyEnvironment(this.dir, this.environmentId, now);
      if (result.kind !== "import" || !result.legacy.clean) return;
      const legacy = result.legacy;
      database.transaction(() => {
        this.assertNotDeleted();
        const fetched = readIndexSnapshot(database, this.storeName);
        if (!fetched) return;
        const base = assembleSnapshot(
          this.environmentId,
          fetched.revision,
          fetched.rows,
          this.snapshot,
          now,
        );
        if (!base.meta.legacyRetained) return;
        // A degraded manifest admitted no mutations. A ready manifest may have
        // newer edits; only repair its damaged drafts and referenced records.
        const manifest =
          base.meta.status === "degraded" ? legacy.manifest : structuredClone(base.manifest);
        if (base.meta.draftsStatus !== "ready") manifest.drafts = legacy.manifest.drafts;
        const unreadable = new Map(base.unreadable);
        const repairedDraftKeys = new Set(
          Object.values(manifest.drafts).map((draft) => recordKey(draft.id, draft.revision)),
        );
        for (const [key, marker] of Array.from(unreadable)) {
          if (marker.kind !== "request-text" || !marker.requestId) continue;
          const current = manifest.requests[marker.requestId];
          const recovered = legacy.manifest.requests[marker.requestId];
          if (current && recovered && !legacy.unreadable.has(key)) {
            current.instruction = recovered.instruction;
            current.response = recovered.response;
            unreadable.delete(key);
          }
        }
        let recordBytes = base.meta.recordBytes;
        for (const record of legacy.records) {
          if (
            base.meta.status !== "degraded" &&
            !unreadable.has(record.key) &&
            !repairedDraftKeys.has(record.key)
          )
            continue;
          const existing = readRecordRow(database, this.storeName, record.key);
          if (existing !== null && !unreadable.has(record.key)) continue;
          recordBytes +=
            record.bytes - (existing === null ? 0 : Buffer.byteLength(existing, "utf8"));
          writeRecordRows(database, this.storeName, [record]);
          unreadable.delete(record.key);
        }
        manifest.usage = { recordBytes };
        const repaired: WebAnnotationStoreMeta = {
          ...base.meta,
          status: "ready",
          reason: undefined,
          draftsStatus: "ready",
          legacyRetained: unreadable.size > 0 ? true : undefined,
          revision: manifest.revision,
          recordBytes,
          createdAt: manifest.createdAt,
          updatedAt: manifest.updatedAt,
        };
        const plan = planRows(base, manifest, repaired, unreadable);
        writeIndexRows(database, this.storeName, plan.upserts, plan.deletes);
        archive = unreadable.size === 0;
      });
    } finally {
      await release();
    }
    if (archive) await archiveLegacyEnvironment(this.options.dataDir, this.environmentId);
  }

  /** Legacy files beside an imported store: a crash before archiving, or an older backend. */
  private async archiveLeftovers(metaJson: string): Promise<void> {
    let meta: Partial<WebAnnotationStoreMeta> = {};
    try {
      meta = JSON.parse(metaJson) as Partial<WebAnnotationStoreMeta>;
    } catch {
      return;
    }
    if (meta.legacyRetained || !(await hasLegacyFiles(this.dir))) return;
    const moved = await archiveLegacyEnvironment(this.options.dataDir, this.environmentId).catch(
      () => 0,
    );
    if (moved > 0) {
      console.warn(
        `[web-annotations] Archived ${moved} legacy file(s) beside an imported environment; they were not imported`,
      );
    }
  }

  /** Revalidate the in-memory model against the committed store revision. */
  private refresh(): void {
    if (this.deleted) return;
    const database = this.db();
    if (deletionMarker(database, "annotations", this.environmentId)) {
      this.markDeletedElsewhere();
      return;
    }
    const revision = database.storeRevision(this.storeName);
    if (revision === this.snapshot.storeRevision) return;
    if (revision === null) {
      this.markDeletedElsewhere();
      return;
    }
    const nowIso = new Date(this.nowMs()).toISOString();
    let next: StoreSnapshot;
    try {
      // Revision and rows of one committed state (see readIndexSnapshot).
      const fetched = readIndexSnapshot(database, this.storeName);
      if (fetched === null) {
        this.markDeletedElsewhere();
        return;
      }
      next = assembleSnapshot(
        this.environmentId,
        fetched.revision,
        fetched.rows,
        this.snapshot,
        nowIso,
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.storageStatus = "unavailable";
      this.reason = "environment storage is unreadable";
      this.reasonDetail = undefined;
      console.warn("[web-annotations] Storage unavailable (code=store-unreadable)");
      return;
    }
    this.adopt(next, true);
  }

  /** Stores are removed only by environment deletion. */
  private markDeletedElsewhere(): void {
    this.deleted = true;
    this.closed = true;
    this.host.deletedElsewhere(this.environmentId);
  }

  /** Status getters must not throw for a store that vanished or is unreadable. */
  private refreshQuietly(): void {
    try {
      this.refresh();
    } catch {
      // The next read reports the error.
    }
  }

  private adopt(next: StoreSnapshot, external: boolean): void {
    const previous = this.snapshot;
    this.snapshot = next;
    this.loadFailure = null;
    const meta = next.meta;
    if (
      meta.format !== WEB_ANNOTATION_STORE_FORMAT ||
      !(meta.version <= WEB_ANNOTATION_STORE_VERSION)
    ) {
      this.storageStatus = "unavailable";
      this.reason =
        "annotation storage was written by a newer version of Orkestrator; upgrade to read it";
      this.reasonDetail = { code: "unsupported-version", format: "manifest" };
    } else if (meta.status === "degraded") {
      this.storageStatus = "degraded";
      this.reason = meta.reason ?? "environment storage is read-only";
      this.reasonDetail = undefined;
    } else {
      this.storageStatus = "ready";
      this.reason = undefined;
      this.reasonDetail = undefined;
    }
    this.draftsStatus = meta.draftsStatus ?? "ready";
    if (!external || !this.loaded || next.manifest.revision <= previous.manifest.revision) return;
    // Another process committed: hint the ids whose rows changed since this
    // process last looked (a superset of the last revision's changes).
    const annotationIds = new Set<string>();
    const requestIds = new Set<string>();
    for (const [id, row] of next.rows) {
      if (previous.rows.get(id) === row) continue;
      if (row.collection === "annotations" || row.collection === "changed") {
        annotationIds.add(row.key);
      } else if (row.collection === "requests") requestIds.add(row.key);
    }
    this.pendingHints.push({
      environmentId: this.environmentId,
      revision: next.manifest.revision,
      annotationIds: Array.from(annotationIds),
      requestIds: Array.from(requestIds),
    });
    if (!this.hintFlushScheduled) {
      this.hintFlushScheduled = true;
      queueMicrotask(() => this.flushHints());
    }
  }

  private flushHints(): void {
    this.hintFlushScheduled = false;
    const hints = this.pendingHints;
    this.pendingHints = [];
    for (const hint of hints) this.emitHint(hint);
  }

  private emitHint(hint: WebAnnotationCommitHint): void {
    try {
      this.options.onCommit?.(hint);
    } catch (error) {
      console.warn(
        "[web-annotations] Change hint listener failed:",
        error instanceof Error ? error.name : "unknown",
      );
    }
  }

  /** Applies the import outcome when there is no store yet. */
  private applyLoadFailure(): void {
    if (this.snapshot.storeRevision !== null || !this.loadFailure) return;
    this.storageStatus = "unavailable";
    this.reason = this.loadFailure.reason;
    this.reasonDetail = this.loadFailure.detail;
  }

  // -------------------------------------------------------------------------
  // Records and assets

  /** Read an immutable record row; malformed content is reported, never guessed. */
  async readRecord<T>(kind: WebAnnotationRecordKind, id: string, revision: number): Promise<T> {
    this.refresh();
    this.assertReadable();
    return this.readRecordNow(kind, id, revision) as T;
  }

  private readRecordNow(kind: WebAnnotationRecordKind, id: string, revision: number): unknown {
    const key = recordKey(id, revision);
    const json = readRecordRow(this.db(), this.storeName, key);
    if (json === null) {
      const marker = this.snapshot.unreadable.get(key);
      if (marker?.state === "unreadable") {
        throw new WebAnnotationStorageError("record is not valid JSON", "record-invalid");
      }
      throw new WebAnnotationStorageError("record is missing", "record-unreadable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new WebAnnotationStorageError("record is not valid JSON", "record-invalid");
    }
    if (!isRecord(parsed) || parsed.kind !== kind || !Object.hasOwn(parsed, "value")) {
      throw new WebAnnotationStorageError("record does not match its reference", "record-invalid");
    }
    return parsed.value;
  }

  async readAsset(assetId: string): Promise<Buffer> {
    const asset = this.manifest.assets[assetId];
    if (!asset) throw new WebAnnotationStorageError("Asset not found in this environment");
    const path = this.assetPath(assetId);
    const info = await stat(path);
    if (info.size !== asset.bytes || info.size > WEB_ANNOTATION_LIMITS.imageBytes) {
      throw new WebAnnotationStorageError("Asset file does not match its record");
    }
    return readFile(path);
  }

  /** Write validated bytes to staging, outside any transaction. */
  async stageFile(bytes: Buffer): Promise<string> {
    this.refresh();
    this.assertWritable();
    const staging = join(this.dir, "staging");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const path = join(staging, `${randomUUID()}.png`);
    this.activeStaging.add(path);
    try {
      await writeDurable(path, bytes);
      if (this.options.syncDirectories !== false) await syncDirectory(staging);
    } catch (error) {
      this.activeStaging.delete(path);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return path;
  }
  async releaseStaged(path: string): Promise<void> {
    this.activeStaging.delete(path);
    await unlink(path).catch(() => undefined);
  }

  /**
   * Promote a staged upload to `assets/<assetId>.png` before the commit that
   * adds its row. Until that commit it is an uncommitted file: its mtime is
   * the staging time, so garbage collection leaves it alone for the grace
   * period, and `discardUncommittedAsset` removes it if the commit does not
   * happen.
   */
  async promoteStagedAsset(stagingPath: string, assetId: string): Promise<void> {
    const target = this.assetPath(assetId);
    await mkdir(join(this.dir, "assets"), { recursive: true, mode: 0o700 });
    await rename(stagingPath, target);
    this.activeStaging.delete(stagingPath);
    if (this.options.syncDirectories !== false) await syncDirectory(join(this.dir, "assets"));
  }

  /** Remove a promoted asset file unless a committed row (any process) references it. */
  discardUncommittedAsset(assetId: string): void {
    const path = this.assetPath(assetId);
    const database = this.db();
    database.transaction(() => {
      if (hasAssetRow(database, this.storeName, assetId)) return;
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    });
  }

  // -------------------------------------------------------------------------
  // Commits

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.pending >= WEB_ANNOTATION_LIMITS.queuedMutations) {
      return Promise.reject(
        storageCapacityError("too many queued annotation writes; retry shortly", "queued-writes", {
          used: this.pending,
          limit: WEB_ANNOTATION_LIMITS.queuedMutations,
        }),
      );
    }
    this.pending++;
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result.finally(() => {
      this.pending--;
    });
  }

  private fault(stage: WebAnnotationFaultStage): void {
    const outcome = this.options.faults?.(stage, this.environmentId);
    if (isThenable(outcome)) (outcome as Promise<void>).catch(() => undefined);
  }

  private assertQuota(total: number, previousTotal: number): void {
    if (total > WEB_ANNOTATION_LIMITS.environmentMetadataBytes && total > previousTotal) {
      throw storageCapacityError(
        `environment metadata would use ${total} of ${WEB_ANNOTATION_LIMITS.environmentMetadataBytes} bytes`,
        "metadata-bytes",
        {
          used: previousTotal,
          limit: WEB_ANNOTATION_LIMITS.environmentMetadataBytes,
          requested: Math.max(0, total - previousTotal),
        },
      );
    }
  }

  /** Writes record rows (replacing any with the same key); returns bytes freed. */
  private writeRecords(records: readonly PendingRecordWrite[]): number {
    const database = this.db();
    const freed = deleteRecordRows(
      database,
      this.storeName,
      records.map((record) => record.key),
    );
    writeRecordRows(database, this.storeName, records);
    return freed;
  }

  /**
   * Run one mutation. `work` edits a copy-on-write working manifest inside
   * the commit transaction and must be synchronous; if it marks the
   * transaction dirty, the rows it replaced commit atomically with the new
   * revision. Committed rows are frozen: replace them or use `tx.edit`.
   */
  async mutate<T>(
    work: WebAnnotationWork<WebAnnotationTransaction, T>,
  ): Promise<WebAnnotationCommitResult<T>> {
    this.refresh();
    this.assertWritable();
    return this.enqueue(() => this.run(work));
  }

  /**
   * Run one draft mutation. Only draft rows, draft text records and the
   * record byte count are written; the environment revision does not change
   * (drafts emit no change hints).
   */
  async mutateDrafts<T>(
    work: WebAnnotationWork<WebAnnotationDraftTransaction, T>,
  ): Promise<WebAnnotationCommitResult<T>> {
    this.refresh();
    this.assertDraftsWritable();
    return this.enqueue(() => this.runDrafts(work));
  }

  private async run<T>(
    work: WebAnnotationWork<WebAnnotationTransaction, T>,
  ): Promise<WebAnnotationCommitResult<T>> {
    const startedAt = Date.now();
    const outcome = this.db().transaction(() => this.commitManifest(work));
    this.flushHints();
    if (!outcome.committed || !outcome.next) {
      return { value: outcome.value, revision: this.snapshot.manifest.revision, committed: false };
    }
    const previous = outcome.previous!;
    const next = outcome.next;
    this.adopt(next, false);
    for (const assetId of outcome.dropAssets ?? []) {
      await unlink(this.assetPath(assetId)).catch(() => undefined);
    }
    this.observe({
      scope: "manifest",
      durationMs: Math.max(0, Date.now() - startedAt),
      indexBytes: next.indexBytes,
      records: outcome.records ?? 0,
      requestIds: outcome.requestIds ?? [],
      annotationIds: outcome.annotationIds ?? [],
      rowsSerialized: outcome.rowsSerialized ?? 0,
      collectionsCopied: outcome.collectionsCopied ?? 0,
      previous: previous.manifest,
      next: next.manifest,
    });
    this.emitHint({
      environmentId: this.environmentId,
      revision: next.manifest.revision,
      annotationIds: [...(outcome.annotationIds ?? [])],
      requestIds: [...(outcome.requestIds ?? [])],
    });
    await this.options.faults?.("after-commit", this.environmentId);
    return { value: outcome.value, revision: next.manifest.revision, committed: true };
  }

  /** Inside the commit transaction. */
  private commitManifest<T>(
    work: WebAnnotationWork<WebAnnotationTransaction, T>,
  ): CommitOutcome<T> {
    this.refresh();
    this.assertWritable();
    const base = this.snapshot;
    const nowMs = this.nowMs();
    // Copy-on-write: a throwing `work` leaves the frozen committed manifest
    // intact, and only the rows it replaced are planned below.
    const working = new WorkingManifest(base.manifest);
    const tx = new WebAnnotationTransaction(
      working,
      new Date(nowMs).toISOString(),
      nowMs,
      (kind, id, revision) => this.readRecordNow(kind, id, revision),
    );
    const value = work(tx) as T;
    if (isThenable(value)) {
      throw new WebAnnotationStorageError("Web annotation mutations must be synchronous");
    }
    if (!tx.dirty) return { value, committed: false };
    const draft = working.manifest;
    draft.revision = base.manifest.revision + 1;
    draft.updatedAt = tx.now;
    draft.consumedDrafts = [];
    for (const id of tx.annotationIds) draft.changedAt[id] = draft.revision;

    const database = this.db();
    this.fault("before-record-write");
    let freed = this.writeRecords(tx.records);
    freed += deleteRecordRows(database, this.storeName, [
      ...tx.dropRecords.map((drop) => recordKey(drop.id, drop.revision)),
      ...tx.dropDraftRecords.map((drop) => recordKey(drop.id, drop.revision)),
    ]);
    const written = tx.records.reduce((sum, record) => sum + record.bytes, 0);
    const recordBytes = Math.max(0, draft.usage.recordBytes + written - freed);
    draft.usage = { recordBytes };
    const meta: WebAnnotationStoreMeta = freezeRowValue({
      ...base.meta,
      createdAt: draft.createdAt,
      updatedAt: tx.now,
      revision: draft.revision,
      recordBytes,
    });
    const changes = working.changes();
    changes.rows.push({ collection: "meta", key: "state", value: meta });
    const plan = planChangedRows(base, changes);
    const next = working.commit(changes);
    if (this.verifyRowPlans) {
      assertSameRowPlan(planRows(base, next, meta, base.unreadable), plan);
    }
    if (!tx.essential) {
      this.assertQuota(
        plan.indexBytes + recordBytes,
        base.indexBytes + base.manifest.usage.recordBytes,
      );
    }
    writeIndexRows(database, this.storeName, plan.upserts, plan.deletes);
    this.fault("before-manifest-replace");
    if (plan.changedKeys.has("drafts")) this.fault("before-drafts-replace");
    const storeRevision = committedStoreRevision(database, this.storeName);
    return {
      value,
      committed: true,
      previous: base,
      next: {
        storeRevision,
        manifest: next,
        meta,
        unreadable: base.unreadable,
        rows: plan.rows,
        values: plan.values,
        indexBytes: plan.indexBytes,
        maxPosition: plan.maxPosition,
      },
      records: tx.records.length,
      rowsSerialized: plan.serialized,
      collectionsCopied: working.copiedCollections,
      dropAssets: tx.dropAssets,
      annotationIds: Array.from(tx.annotationIds),
      requestIds: Array.from(tx.requestIds),
    };
  }

  private async runDrafts<T>(
    work: WebAnnotationWork<WebAnnotationDraftTransaction, T>,
  ): Promise<WebAnnotationCommitResult<T>> {
    const startedAt = Date.now();
    const outcome = this.db().transaction(() => this.commitDrafts(work));
    this.flushHints();
    if (!outcome.committed || !outcome.next) {
      return { value: outcome.value, revision: this.snapshot.manifest.revision, committed: false };
    }
    this.adopt(outcome.next, false);
    this.observe({
      scope: "drafts",
      durationMs: Math.max(0, Date.now() - startedAt),
      indexBytes: outcome.next.indexBytes,
      records: outcome.records ?? 0,
      requestIds: [],
      annotationIds: [],
      rowsSerialized: outcome.rowsSerialized ?? 0,
      collectionsCopied: 0,
      previous: outcome.previous!.manifest,
      next: outcome.next.manifest,
    });
    return { value: outcome.value, revision: outcome.next.manifest.revision, committed: true };
  }

  /** Inside the commit transaction. */
  private commitDrafts<T>(
    work: WebAnnotationWork<WebAnnotationDraftTransaction, T>,
  ): CommitOutcome<T> {
    this.refresh();
    this.assertDraftsWritable();
    const base = this.snapshot;
    const nowMs = this.nowMs();
    const tx = new WebAnnotationDraftTransaction(
      base.manifest,
      structuredClone(base.manifest.drafts),
      new Date(nowMs).toISOString(),
      nowMs,
    );
    const value = work(tx) as T;
    if (isThenable(value)) {
      throw new WebAnnotationStorageError("Web annotation mutations must be synchronous");
    }
    if (!tx.dirty) return { value, committed: false };
    const database = this.db();
    this.fault("before-record-write");
    let freed = this.writeRecords(tx.records);
    freed += deleteRecordRows(
      database,
      this.storeName,
      tx.dropRecords.map((drop) => recordKey(drop.id, drop.revision)),
    );
    const written = tx.records.reduce((sum, record) => sum + record.bytes, 0);
    const recordBytes = Math.max(0, base.manifest.usage.recordBytes + written - freed);
    const next: WebAnnotationManifest = freezeRowValue({
      ...base.manifest,
      drafts: tx.drafts,
      usage: { recordBytes },
    });
    const meta: WebAnnotationStoreMeta = freezeRowValue({ ...base.meta, recordBytes });
    // The draft index is small (256 drafts per environment): plan all of it.
    const plan = planChangedRows(base, {
      rows: [
        { collection: "meta", key: "state", value: meta },
        { collection: "meta", key: "migration", value: next.migration },
        ...Object.entries(next.drafts).map(([key, value]) => ({
          collection: "drafts",
          key,
          value: value as unknown,
        })),
        ...Object.keys(base.manifest.drafts)
          .filter((key) => !Object.hasOwn(next.drafts, key))
          .map((key) => ({ collection: "drafts", key, value: undefined })),
      ],
      groups: [],
    });
    if (this.verifyRowPlans) {
      assertSameRowPlan(planRows(base, next, meta, base.unreadable, DRAFT_SCOPE), plan);
    }
    this.assertQuota(
      plan.indexBytes + recordBytes,
      base.indexBytes + base.manifest.usage.recordBytes,
    );
    writeIndexRows(database, this.storeName, plan.upserts, plan.deletes);
    this.fault("before-drafts-replace");
    const storeRevision = committedStoreRevision(database, this.storeName);
    return {
      value,
      committed: true,
      previous: base,
      next: {
        storeRevision,
        manifest: next,
        meta,
        unreadable: base.unreadable,
        rows: plan.rows,
        values: plan.values,
        indexBytes: plan.indexBytes,
        maxPosition: plan.maxPosition,
      },
      records: tx.records.length,
      rowsSerialized: plan.serialized,
    };
  }

  private observe(observation: Omit<WebAnnotationCommitObservation, "environmentId">): void {
    try {
      this.options.observeCommit?.({ environmentId: this.environmentId, ...observation });
    } catch {
      // Metrics never affect storage.
    }
  }

  /**
   * Remove uncommitted leftovers older than the staging grace period: staging
   * uploads, promoted asset files no committed row references, and abandoned
   * temp files. Asset rows are re-read inside the transaction that unlinks
   * them, so an asset another backend committed is never removed. Bounded per
   * call by `batch` and `deadline`.
   */
  async cleanup(options: { batch?: number; deadline?: number } = {}): Promise<number> {
    if (this.status !== "ready" || this.closed) return 0;
    const batch = options.batch ?? 50;
    const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    const cutoff = this.nowMs() - WEB_ANNOTATION_LIMITS.stagingGraceMs;
    let removed = 0;
    await this.options.faults?.("during-cleanup", this.environmentId);
    const expired = async (path: string) => {
      try {
        return (await stat(path)).mtimeMs <= cutoff;
      } catch {
        return false;
      }
    };
    const list = async (path: string) => readdir(path).catch(() => [] as string[]);
    const budgetLeft = () => removed < batch && Date.now() < deadline;

    for (const name of await list(join(this.dir, "staging"))) {
      if (!budgetLeft()) return removed;
      const path = join(this.dir, "staging", name);
      if (this.activeStaging.has(path) || !(await expired(path))) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      removed++;
    }
    const candidates: Array<{ path: string; assetId: string | null }> = [];
    for (const name of await list(join(this.dir, "assets"))) {
      if (removed + candidates.length >= batch || Date.now() >= deadline) break;
      const assetId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.png$/.test(name)
        ? name.slice(0, -4)
        : null;
      if (assetId && this.manifest.assets[assetId]) continue;
      const path = join(this.dir, "assets", name);
      if (!(await expired(path))) continue;
      candidates.push({ path, assetId });
    }
    if (candidates.length > 0) {
      const database = this.db();
      removed += database.transaction(() => {
        let count = 0;
        for (const candidate of candidates) {
          if (candidate.assetId && hasAssetRow(database, this.storeName, candidate.assetId))
            continue;
          try {
            unlinkSync(candidate.path);
            count++;
          } catch {
            // Already gone.
          }
        }
        return count;
      });
    }
    for (const directory of [this.dir, join(this.dir, "assets")]) {
      for (const name of await list(directory)) {
        if (!budgetLeft()) return removed;
        if (!name.endsWith(".tmp")) continue;
        const path = join(directory, name);
        if (!(await expired(path))) continue;
        await rm(path, { force: true }).catch(() => undefined);
        removed++;
      }
    }
    return removed;
  }

  /** Stop accepting writes and wait for the queue to settle. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail.catch(() => undefined);
  }
  get isClosed(): boolean {
    return this.closed;
  }
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined);
  }
}

/** Root of all environment stores for one backend process. */
export class WebAnnotationStorage {
  readonly root: string;
  private readonly stores = new Map<string, WebAnnotationEnvironmentStore>();
  private readonly loading = new Map<string, Promise<WebAnnotationEnvironmentStore>>();
  private readonly deleted = new Set<string>();
  private connection: StorageDatabase | null = null;
  private readonly host: EnvironmentHost;

  constructor(private readonly options: WebAnnotationStorageOptions) {
    this.root = join(options.dataDir, "web-annotations");
    this.host = {
      database: () => this.database(),
      deletedElsewhere: (environmentId) => {
        this.deleted.add(environmentId);
        this.stores.delete(environmentId);
      },
    };
  }

  /** The database connection (opened lazily; reopened after `close`). */
  database(): StorageDatabase {
    if (this.options.database) return this.options.database;
    if (!this.connection || this.connection.isClosed()) {
      this.connection = openBackendDatabase(this.options.dataDir);
    }
    return this.connection;
  }

  /**
   * Load every persisted environment so background work runs unmounted.
   *
   * `environmentExists` lets the host drop stores whose environment was
   * deleted while their removal failed or was interrupted; loading them would
   * restart background work for an environment nobody can see. It must
   * resolve `true` when it cannot tell, so an unreadable environment store
   * never deletes annotations.
   */
  async init(
    options: { environmentExists?: (environmentId: string) => Promise<boolean> } = {},
  ): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = new Set<string>();
    for (const store of this.database().listStores(WEB_ANNOTATION_STORE_PREFIX)) {
      names.add(store.slice(WEB_ANNOTATION_STORE_PREFIX.length));
    }
    for (const name of await readdir(this.root).catch(() => [] as string[])) names.add(name);
    for (const name of Array.from(names).sort()) {
      if (!isEnvironmentDirectoryName(name)) continue;
      if (options.environmentExists && !(await options.environmentExists(name))) {
        await this.deleteEnvironment(name).catch((error: unknown) => {
          console.warn(
            "[web-annotations] Failed to remove orphaned environment storage:",
            error instanceof Error ? error.name : "unknown",
          );
        });
        continue;
      }
      await this.environment(name).catch((error: unknown) => {
        console.warn(
          "[web-annotations] Failed to load environment storage:",
          error instanceof Error ? error.name : "unknown",
        );
      });
    }
  }

  loadedEnvironmentIds(): string[] {
    return Array.from(this.stores.keys());
  }

  isDeleted(environmentId: string): boolean {
    return (
      this.deleted.has(environmentId) ||
      !!deletionMarker(this.database(), "annotations", environmentId)
    );
  }

  async environment(environmentId: string): Promise<WebAnnotationEnvironmentStore> {
    if (!isEnvironmentDirectoryName(environmentId)) {
      throw new WebAnnotationStorageError("Environment id is invalid");
    }
    if (this.isDeleted(environmentId)) {
      throw new WebAnnotationStorageError("Environment was deleted");
    }
    const existing = this.stores.get(environmentId);
    if (existing) return existing;
    let loading = this.loading.get(environmentId);
    if (!loading) {
      loading = (async () => {
        const store = new WebAnnotationEnvironmentStore(
          environmentId,
          this.root,
          this.options,
          this.host,
        );
        await store.load();
        if (this.isDeleted(environmentId)) {
          throw new WebAnnotationStorageError("Environment was deleted");
        }
        this.stores.set(environmentId, store);
        return store;
      })().finally(() => this.loading.delete(environmentId));
      this.loading.set(environmentId, loading);
    }
    return loading;
  }

  /**
   * Environment deletion: reject further writes, let the in-flight commit
   * finish, then delete the store (scrubbing freed pages and the WAL), the
   * files and any archived legacy copy. Idempotent.
   */
  async deleteEnvironment(environmentId: string): Promise<void> {
    if (!isEnvironmentDirectoryName(environmentId)) return;
    this.deleted.add(environmentId);
    const store =
      this.stores.get(environmentId) ??
      (await this.loading.get(environmentId)?.catch(() => undefined));
    await store?.close();
    this.stores.delete(environmentId);
    const database = this.database();
    database.transaction(() => {
      markDeletion(database, "annotations", environmentId);
      database.deleteStoreInTransaction(webAnnotationStoreName(environmentId));
    });
    database.scrubDeletedContent();
    await rm(join(this.root, environmentId), { recursive: true, force: true });
    await removeArchivedLegacyEnvironment(this.options.dataDir, environmentId);
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.stores.values()).map((store) => store.drain()));
    if (!this.options.database) {
      this.connection?.close();
      this.connection = null;
    }
  }
}

export function isEnvironmentDirectoryName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= WEB_ANNOTATION_LIMITS.idChars &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes("..")
  );
}

export function utf8(value: string): number {
  return webAnnotationUtf8Bytes(value);
}
