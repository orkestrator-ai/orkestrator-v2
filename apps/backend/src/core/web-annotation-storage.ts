/**
 * Durable per-environment storage for web annotations.
 *
 * Layout under `<dataDir>/web-annotations/<environment-id>/`:
 *
 *   manifest.json            bounded listing index + mutable state (the commit point)
 *   manifest.prev.json       previous committed manifest, kept for recovery
 *   drafts.json              editor draft index (autosave commits touch only this)
 *   drafts.prev.json         previous committed draft index
 *   records/<opaque>/<rev>.json   immutable records: captures, entries, briefs,
 *                            request text, results, draft text
 *   assets/<asset-id>.png    validated images
 *   staging/                 uncommitted uploads
 *
 * Every mutation runs through one bounded serialized queue per environment.
 * Expected revisions are validated inside that queue, new record files are
 * written and fsynced first, and the index replacement (temp + fsync + rename
 * + directory fsync) is the commit point. The previous index generation is
 * preserved with a hard link (a durable copy where links are unsupported),
 * and records it references are deleted only after the following commit.
 * Nothing external (agents, Docker, file materialization) ever runs while the
 * queue is held. See `web-annotation-storage-format.ts` for the formats.
 */
import { randomUUID } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
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
  type WebAnnotationRequest,
  type WebAnnotationStorageStatus,
} from "@orkestrator/protocol/web-annotations";
import {
  CONSUMED_DRAFT_IDS,
  WEB_ANNOTATION_DRAFTS_FORMAT,
  WEB_ANNOTATION_DRAFTS_VERSION,
  WebAnnotationStorageError,
  emptyManifest,
  isRecord,
  parseDrafts,
  parseManifest,
  persistManifest,
  recordDirectoryName,
  requestTextRecordId,
  sameRequestText,
  type ManifestDraft,
  type RequestTextRef,
  type RequestTextValue,
  type StorageErrorCode,
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

/** Upper bound for any single immutable record file. */
export const WEB_ANNOTATION_MAX_RECORD_BYTES = 1024 * 1024;
/** Upper bound for the manifest itself; the metadata quota is the real limit. */
const MAX_MANIFEST_BYTES = WEB_ANNOTATION_LIMITS.environmentMetadataBytes + 1024 * 1024;
const MAX_DRAFTS_BYTES = 4 * 1024 * 1024;
const LOAD_CONCURRENCY = 16;
/** Startup parses referenced records up to this many bytes; beyond it, existence only. */
const LOAD_VERIFY_BYTES = 64 * 1024 * 1024;

export type WebAnnotationFaultStage =
  | "before-record-write"
  | "before-manifest-replace"
  | "after-commit"
  | "before-drafts-replace"
  | "during-cleanup";

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
  indexBytes: number;
  records: number;
  requestIds: readonly string[];
  previous: Readonly<WebAnnotationManifest>;
  next: Readonly<WebAnnotationManifest>;
}

export interface WebAnnotationStorageOptions {
  dataDir: string;
  clock?: () => number;
  faults?: WebAnnotationFaultHook;
  onCommit?: (hint: WebAnnotationCommitHint) => void;
  /** Synchronous, must not throw; failures are swallowed. */
  observeCommit?: (observation: WebAnnotationCommitObservation) => void;
  /** Directory fsync is best-effort; tests may disable it. */
  syncDirectories?: boolean;
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

/**
 * Keep the committed index as its `.prev` generation. The committed file is
 * never modified in place (every write renames a new inode over it), so a
 * hard link preserves the old bytes without rewriting them. Filesystems that
 * refuse hard links get a synced copy.
 */
async function preservePrevious(path: string, previousPath: string): Promise<void> {
  const temp = `${previousPath}.${randomUUID()}.tmp`;
  try {
    try {
      await link(path, temp);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      await copyFile(path, temp);
      const handle = await open(temp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await rename(temp, previousPath);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Directory fsync is unsupported on some platforms; the rename remains the
  // commit point and this only narrows the power-loss window where supported.
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Best-effort.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function storageCode(error: unknown): StorageErrorCode {
  if (error instanceof WebAnnotationStorageError && error.code) return error.code;
  return errorCode(error) === "ENOENT" ? "manifest-missing" : "manifest-unreadable";
}

async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) await work(items[cursor++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

interface PendingRecordWrite {
  kind: WebAnnotationRecordKind;
  id: string;
  revision: number;
  json: string;
}

function encodeRecord(
  kind: WebAnnotationRecordKind,
  id: string,
  revision: number,
  value: unknown,
): PendingRecordWrite {
  const json = JSON.stringify({ kind, id, revision, value });
  const bytes = Buffer.byteLength(json);
  if (bytes > WEB_ANNOTATION_MAX_RECORD_BYTES) {
    throw storageCapacityError("record exceeds 1 MiB", "record-bytes", {
      used: bytes,
      limit: WEB_ANNOTATION_MAX_RECORD_BYTES,
    });
  }
  return { kind, id, revision, json };
}

/** One mutation's working set. The manifest is a private clone until commit. */
export class WebAnnotationTransaction {
  readonly records: PendingRecordWrite[] = [];
  readonly dropRecords: Array<{ id: string; revision: number }> = [];
  readonly dropDraftRecords: Array<{ id: string; revision: number; bytes: number }> = [];
  readonly promotions: Array<{ stagingPath: string; assetId: string }> = [];
  readonly dropAssets: string[] = [];
  readonly annotationIds = new Set<string>();
  readonly requestIds = new Set<string>();
  private changed = false;
  private bypassQuota = false;

  constructor(
    readonly manifest: WebAnnotationManifest,
    readonly now: string,
    readonly nowMs: number,
  ) {}

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
  writeRecord(kind: WebAnnotationRecordKind, id: string, revision: number, value: unknown): number {
    const record = encodeRecord(kind, id, revision, value);
    const bytes = Buffer.byteLength(record.json);
    this.records.push(record);
    this.manifest.usage.recordBytes += bytes;
    this.changed = true;
    return bytes;
  }
  /** A record referenced by the listing index that this commit supersedes. */
  dropRecordAfterCommit(id: string, revision: number, bytes: number): void {
    this.dropRecords.push({ id, revision });
    this.manifest.usage.recordBytes = Math.max(0, this.manifest.usage.recordBytes - bytes);
    this.changed = true;
  }
  /** A draft text record whose draft this commit removes from the draft index. */
  dropDraftRecordAfterCommit(id: string, revision: number, bytes: number): void {
    this.dropDraftRecords.push({ id, revision, bytes });
    this.changed = true;
  }
  promoteStagedAsset(stagingPath: string, assetId: string): void {
    this.promotions.push({ stagingPath, assetId });
    this.changed = true;
  }
  dropAssetAfterCommit(assetId: string): void {
    this.dropAssets.push(assetId);
    this.changed = true;
  }
}

/**
 * A draft-index-only mutation: reads the committed manifest, edits a private
 * copy of the draft index, and commits `drafts.json` alone.
 */
export class WebAnnotationDraftTransaction {
  readonly records: PendingRecordWrite[] = [];
  readonly dropRecords: Array<{ id: string; revision: number; bytes: number }> = [];
  addedBytes = 0;
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
    const bytes = Buffer.byteLength(record.json);
    this.records.push(record);
    this.addedBytes += bytes;
    this.changed = true;
    return bytes;
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

interface PersistedText extends RequestTextValue {
  revision: number;
  bytes: number;
  damaged?: boolean;
}

/** Storage for one environment. Created and owned by `WebAnnotationStorage`. */
export class WebAnnotationEnvironmentStore {
  readonly dir: string;
  private current: WebAnnotationManifest;
  private committedManifestBytes = 0;
  private committedDraftsBytes = 0;
  private draftsSequence = 0;
  private draftRecordBytes = 0;
  /** The draft index must be written by the next commit (v1 import or repair). */
  private draftsDirty = false;
  private draftsStatus: WebAnnotationStorageStatus = "ready";
  private readonly persistedText = new Map<string, PersistedText>();
  /** Superseded record paths, removed after the next commit of the same index. */
  private manifestDeferred: string[] = [];
  private draftsDeferred: string[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private storageStatus: WebAnnotationStorageStatus = "ready";
  private reason: string | undefined;
  private reasonDetail: WebAnnotationErrorDetail | undefined;
  private readonly unavailable = new Map<string, string>();
  private readonly activeStaging = new Set<string>();
  private readonly inFlightRecords = new Set<string>();
  private readonly active = new Set<string>();

  constructor(
    readonly environmentId: string,
    root: string,
    private readonly options: WebAnnotationStorageOptions,
  ) {
    this.dir = join(root, environmentId);
    this.current = emptyManifest(environmentId, new Date(this.nowMs()).toISOString());
  }

  private nowMs(): number {
    return this.options.clock?.() ?? Date.now();
  }

  get manifest(): Readonly<WebAnnotationManifest> {
    this.assertReadable();
    return this.current;
  }
  get status(): WebAnnotationStorageStatus {
    return this.storageStatus;
  }
  get degradedReason(): string | undefined {
    return this.reason;
  }
  get draftStatus(): WebAnnotationStorageStatus {
    return this.storageStatus === "ready" ? this.draftsStatus : this.storageStatus;
  }
  get revision(): number {
    return this.current.revision;
  }
  /** Committed metadata bytes: listing index, draft index, and their records. */
  get metadataBytes(): number {
    return (
      this.committedManifestBytes +
      this.current.usage.recordBytes +
      this.committedDraftsBytes +
      this.draftRecordBytes
    );
  }
  /** Ids of requests that are still active (may execute or are unsettled). */
  activeRequestIds(): string[] {
    return Array.from(this.active);
  }
  unavailableReason(annotationId: string): string | undefined {
    return this.unavailable.get(annotationId);
  }
  /** In-memory only: an unreadable referenced record degrades that item. */
  markUnavailable(annotationId: string, reason: string): void {
    if (!this.unavailable.has(annotationId)) {
      console.warn(`[web-annotations] Record unavailable (${reason})`);
    }
    this.unavailable.set(annotationId, reason);
  }

  private assertReadable(): void {
    if (this.storageStatus === "unavailable") {
      throw degradedError(this.reason ?? "environment storage is unreadable", this.reasonDetail);
    }
  }
  private assertWritable(): void {
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
    this.assertReadable();
    if (this.draftsStatus === "unavailable") throw degradedError("the draft index is unreadable");
  }

  private manifestPath() {
    return join(this.dir, "manifest.json");
  }
  private previousPath() {
    return join(this.dir, "manifest.prev.json");
  }
  private draftsPath() {
    return join(this.dir, "drafts.json");
  }
  private draftsPreviousPath() {
    return join(this.dir, "drafts.prev.json");
  }
  recordPath(id: string, revision: number): string {
    return join(this.dir, "records", recordDirectoryName(id), `${revision}.json`);
  }
  assetPath(assetId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(assetId) || assetId.includes("..")) {
      throw new WebAnnotationStorageError("Asset id is invalid");
    }
    return join(this.dir, "assets", `${assetId}.png`);
  }

  private async readJson(
    path: string,
    maxBytes: number,
  ): Promise<{ value: unknown; bytes: number }> {
    const info = await stat(path);
    if (info.size > maxBytes) {
      throw new WebAnnotationStorageError("index is too large", "manifest-too-large");
    }
    const json = await readFile(path, "utf8");
    try {
      return { value: JSON.parse(json), bytes: Buffer.byteLength(json) };
    } catch {
      throw new WebAnnotationStorageError("manifest is not valid JSON", "manifest-invalid-json");
    }
  }

  private async readManifestFile(path: string) {
    const { value, bytes } = await this.readJson(path, MAX_MANIFEST_BYTES);
    return { parsed: parseManifest(value, this.environmentId), bytes };
  }

  private setUnavailable(error: unknown, fallbackReason: string): void {
    this.storageStatus = "unavailable";
    this.reason = error instanceof WebAnnotationStorageError ? error.message : fallbackReason;
    this.reasonDetail = error instanceof WebAnnotationStorageError ? error.detail : undefined;
  }

  /**
   * Load the committed manifest. Unreadable storage becomes a degraded or
   * unavailable state — never an empty collection that could lose data or
   * drop a request reservation. A manifest written by a newer version is
   * refused outright (never replaced by the previous copy and overwritten).
   */
  async load(): Promise<void> {
    let loaded: Awaited<ReturnType<WebAnnotationEnvironmentStore["readManifestFile"]>> | null =
      null;
    try {
      loaded = await this.readManifestFile(this.manifestPath());
      this.storageStatus = "ready";
    } catch (error) {
      const code = storageCode(error);
      if (code === "unsupported-version") {
        this.setUnavailable(error, "manifest uses an unsupported version");
        console.warn(`[web-annotations] Storage unavailable (code=${code})`);
        return;
      }
      const previous = await this.readManifestFile(this.previousPath()).catch(
        (previousError: unknown) => previousError,
      );
      if (previous instanceof Error || !isRecord(previous)) {
        if (code === "manifest-missing" && errorCode(previous) === "ENOENT") {
          // A fresh environment: nothing was ever committed.
          this.current = emptyManifest(this.environmentId, new Date(this.nowMs()).toISOString());
          this.storageStatus = "ready";
        } else if (storageCode(previous) === "unsupported-version") {
          this.setUnavailable(previous, "manifest uses an unsupported version");
        } else {
          this.setUnavailable(error, "manifest is unreadable");
        }
      } else {
        loaded = previous as Awaited<ReturnType<WebAnnotationEnvironmentStore["readManifestFile"]>>;
        this.storageStatus = "degraded";
        this.reason =
          code === "manifest-missing"
            ? "manifest is missing; serving the previous committed copy read-only"
            : `${error instanceof WebAnnotationStorageError ? error.message : "manifest is unreadable"}; serving the previous committed copy read-only`;
      }
      if (code !== "manifest-missing" || this.storageStatus !== "ready") {
        console.warn(
          `[web-annotations] Storage ${this.storageStatus} (code=${code === "manifest-missing" ? "manifest-missing" : code})`,
        );
      }
    }
    if (this.storageStatus === "unavailable") return;
    if (loaded) {
      this.current = loaded.parsed.manifest;
      this.committedManifestBytes = loaded.bytes;
      await this.hydrateRequestText(loaded.parsed.textRefs);
      await this.loadDrafts(loaded.parsed.sourceVersion);
    } else {
      await this.loadDrafts(2);
    }
    this.refreshActive(Object.keys(this.current.requests));
    await this.verifyReferencedRecords();
  }

  /** Instructions and response excerpts live in per-request text records. */
  private async hydrateRequestText(
    refs: ReadonlyMap<string, RequestTextRef | null>,
  ): Promise<void> {
    await mapBounded(Array.from(refs), LOAD_CONCURRENCY, async ([requestId, ref]) => {
      const request = this.current.requests[requestId];
      if (!request) return;
      const damage = () => {
        this.persistedText.set(requestId, {
          revision: ref?.revision ?? 0,
          bytes: ref?.bytes ?? 0,
          instruction: "",
          response: null,
          damaged: true,
        });
        for (const selection of request.selections) {
          this.markUnavailable(selection.annotationId, "request record unreadable");
        }
      };
      if (!ref) return damage();
      try {
        const value = await this.readRecord<unknown>(
          "request-text",
          requestTextRecordId(requestId),
          ref.revision,
        );
        if (
          !isRecord(value) ||
          typeof value.instruction !== "string" ||
          (value.response !== null && !isRecord(value.response))
        ) {
          return damage();
        }
        request.instruction = value.instruction;
        request.response = value.response as WebAnnotationRequest["response"];
        this.persistedText.set(requestId, {
          revision: ref.revision,
          bytes: ref.bytes,
          instruction: request.instruction,
          response: request.response,
        });
      } catch {
        damage();
      }
    });
  }

  private async loadDrafts(sourceVersion: 1 | 2): Promise<void> {
    if (sourceVersion === 1) {
      // Version 1 kept drafts inline; move their accounting to the draft index.
      let bytes = 0;
      for (const draft of Object.values(this.current.drafts)) bytes += draft.bytes;
      this.draftRecordBytes = bytes;
      this.current.usage.recordBytes = Math.max(0, this.current.usage.recordBytes - bytes);
      this.draftsDirty = true;
      return;
    }
    const read = async (path: string) => {
      const { value, bytes } = await this.readJson(path, MAX_DRAFTS_BYTES);
      return { drafts: parseDrafts(value, this.environmentId), bytes };
    };
    let loaded: Awaited<ReturnType<typeof read>> | null = null;
    try {
      loaded = await read(this.draftsPath());
    } catch (error) {
      const previous = await read(this.draftsPreviousPath()).catch((previousError: unknown) =>
        previousError instanceof Error ? previousError : new Error("unreadable"),
      );
      const missing = errorCode(error) === "ENOENT";
      if (!(previous instanceof Error)) {
        loaded = previous;
        // A missing or damaged current index: serve the previous one read-only.
        this.draftsStatus = "degraded";
      } else if (!(missing && errorCode(previous) === "ENOENT")) {
        this.draftsStatus = "unavailable";
      }
      if (this.draftsStatus !== "ready") {
        console.warn(
          `[web-annotations] Draft index ${this.draftsStatus} (code=${storageCode(error)})`,
        );
      }
    }
    if (loaded) {
      this.current.drafts = loaded.drafts.drafts;
      this.draftsSequence = loaded.drafts.sequence;
      this.draftRecordBytes = loaded.drafts.recordBytes;
      this.committedDraftsBytes = loaded.bytes;
    }
    // Repair a crash between a manifest commit and its draft index write.
    const consumed = new Set(this.current.consumedDrafts ?? []);
    for (const [editorId, draft] of Object.entries(this.current.drafts)) {
      if (!consumed.has(draft.id)) continue;
      delete this.current.drafts[editorId];
      this.draftRecordBytes = Math.max(0, this.draftRecordBytes - draft.bytes);
      this.draftsDirty = true;
    }
  }

  /**
   * Parse and validate the records current state depends on: every live
   * annotation's current capture and every active request's frozen brief. A
   * missing or malformed record marks only its annotation unavailable
   * (read-only); it never clears a reservation or fabricates a record.
   * Parsing is bounded by a byte budget; past it, only existence is checked.
   */
  private async verifyReferencedRecords(): Promise<void> {
    interface Check {
      annotationIds: string[];
      kind: WebAnnotationRecordKind;
      id: string;
      label: "capture" | "request";
      valid: (value: unknown) => boolean;
    }
    const checks: Check[] = [];
    for (const annotation of Object.values(this.current.annotations)) {
      if (annotation.state === "deleted") continue;
      checks.push({
        annotationIds: [annotation.id],
        kind: "capture",
        id: annotation.currentCaptureId,
        label: "capture",
        valid: (value) =>
          isRecord(value) &&
          value.id === annotation.currentCaptureId &&
          value.annotationId === annotation.id &&
          value.schemaVersion === 1 &&
          isRecord(value.target) &&
          isRecord(value.page),
      });
    }
    for (const requestId of this.active) {
      const request = this.current.requests[requestId];
      if (!request) continue;
      checks.push({
        annotationIds: request.selections.map((selection) => selection.annotationId),
        kind: "brief",
        id: request.id,
        label: "request",
        valid: (value) =>
          isRecord(value) && typeof value.body === "string" && value.bodyHash === request.bodyHash,
      });
    }
    let budget = LOAD_VERIFY_BYTES;
    await mapBounded(checks, LOAD_CONCURRENCY, async (check) => {
      const mark = (state: "missing" | "unreadable") => {
        for (const id of check.annotationIds)
          this.markUnavailable(id, `${check.label} record ${state}`);
      };
      let size: number;
      try {
        size = (await stat(this.recordPath(check.id, 1))).size;
      } catch {
        return mark("missing");
      }
      if (size > WEB_ANNOTATION_MAX_RECORD_BYTES) return mark("unreadable");
      if (size > budget) return;
      budget -= size;
      try {
        const value = await this.readRecord<unknown>(check.kind, check.id, 1);
        if (!check.valid(value)) mark("unreadable");
      } catch {
        mark("unreadable");
      }
    });
  }

  private refreshActive(requestIds: Iterable<string>): void {
    for (const id of requestIds) {
      const request = this.current.requests[id];
      if (request && isWebAnnotationRequestActive(request.state)) this.active.add(id);
      else this.active.delete(id);
    }
  }

  /** Read an immutable record; malformed content is reported, never guessed. */
  async readRecord<T>(kind: WebAnnotationRecordKind, id: string, revision: number): Promise<T> {
    this.assertReadable();
    const path = this.recordPath(id, revision);
    const info = await stat(path);
    if (info.size > WEB_ANNOTATION_MAX_RECORD_BYTES) {
      throw new WebAnnotationStorageError("record exceeds its size bound", "record-too-large");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new WebAnnotationStorageError("record is not valid JSON", "record-invalid");
    }
    if (
      !isRecord(parsed) ||
      parsed.kind !== kind ||
      parsed.id !== id ||
      parsed.revision !== revision ||
      !Object.hasOwn(parsed, "value")
    ) {
      throw new WebAnnotationStorageError("record does not match its reference", "record-invalid");
    }
    return parsed.value as T;
  }

  async readAsset(assetId: string): Promise<Buffer> {
    this.assertReadable();
    const asset = this.current.assets[assetId];
    if (!asset) throw new WebAnnotationStorageError("Asset not found in this environment");
    const path = this.assetPath(assetId);
    const info = await stat(path);
    if (info.size !== asset.bytes || info.size > WEB_ANNOTATION_LIMITS.imageBytes) {
      throw new WebAnnotationStorageError("Asset file does not match its record");
    }
    return readFile(path);
  }

  /** Write validated bytes outside the queue; promote them inside a commit. */
  async stageFile(bytes: Buffer): Promise<string> {
    this.assertWritable();
    const staging = join(this.dir, "staging");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const path = join(staging, `${randomUUID()}.png`);
    this.activeStaging.add(path);
    try {
      await writeDurable(path, bytes);
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

  /**
   * Run one serialized mutation. `work` edits a private clone of the manifest;
   * if it marks the transaction dirty the clone becomes the committed state.
   */
  async mutate<T>(
    work: (tx: WebAnnotationTransaction) => T | Promise<T>,
  ): Promise<WebAnnotationCommitResult<T>> {
    this.assertWritable();
    return this.enqueue(() => this.run(work));
  }

  /**
   * Run one serialized draft-index mutation. Only `drafts.json` and new draft
   * text records are written; the listing index is not rewritten and the
   * environment revision does not change (drafts emit no change hints).
   */
  async mutateDrafts<T>(
    work: (tx: WebAnnotationDraftTransaction) => T | Promise<T>,
  ): Promise<WebAnnotationCommitResult<T>> {
    this.assertDraftsWritable();
    return this.enqueue(() => this.runDrafts(work));
  }

  private async writeRecords(records: readonly PendingRecordWrite[]): Promise<void> {
    for (const record of records) {
      const directory = join(this.dir, "records", recordDirectoryName(record.id));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeDurable(this.recordPath(record.id, record.revision), record.json);
    }
    if (this.options.syncDirectories !== false && records.length > 0) {
      await syncDirectory(join(this.dir, "records"));
    }
  }

  private async flushDeferred(paths: string[]): Promise<void> {
    for (const path of paths) await unlink(path).catch(() => undefined);
  }

  private observe(observation: Omit<WebAnnotationCommitObservation, "environmentId">): void {
    try {
      this.options.observeCommit?.({ environmentId: this.environmentId, ...observation });
    } catch {
      // Metrics never affect storage.
    }
  }

  private draftIndexJson(drafts: Record<string, ManifestDraft>, recordBytes: number): string {
    return JSON.stringify({
      format: WEB_ANNOTATION_DRAFTS_FORMAT,
      version: WEB_ANNOTATION_DRAFTS_VERSION,
      environmentId: this.environmentId,
      sequence: this.draftsSequence + 1,
      drafts,
      recordBytes,
    });
  }

  private async replaceDraftIndex(json: string): Promise<void> {
    await this.options.faults?.("before-drafts-replace", this.environmentId);
    await preservePrevious(this.draftsPath(), this.draftsPreviousPath());
    await writeDurable(this.draftsPath(), json);
    if (this.options.syncDirectories !== false) await syncDirectory(this.dir);
  }

  /** Request text records to write for `next`; returns the listing-index references. */
  private planRequestText(tx: WebAnnotationTransaction): {
    refs: Map<string, RequestTextRef | null>;
    written: Map<string, PersistedText>;
  } {
    const refs = new Map<string, RequestTextRef | null>();
    const written = new Map<string, PersistedText>();
    for (const [id, request] of Object.entries(tx.manifest.requests)) {
      const persisted = this.persistedText.get(id);
      if (persisted && (persisted.damaged || sameRequestText(persisted, request))) {
        refs.set(
          id,
          persisted.revision > 0 ? { revision: persisted.revision, bytes: persisted.bytes } : null,
        );
        continue;
      }
      const revision = (persisted?.revision ?? 0) + 1;
      const value: RequestTextValue = {
        instruction: request.instruction,
        response: request.response,
      };
      const bytes = tx.writeRecord("request-text", requestTextRecordId(id), revision, value);
      if (persisted)
        tx.dropRecordAfterCommit(requestTextRecordId(id), persisted.revision, persisted.bytes);
      refs.set(id, { revision, bytes });
      written.set(id, { ...value, revision, bytes });
    }
    return { refs, written };
  }

  private async run<T>(
    work: (tx: WebAnnotationTransaction) => T | Promise<T>,
  ): Promise<WebAnnotationCommitResult<T>> {
    this.assertWritable();
    const startedAt = Date.now();
    const nowMs = this.nowMs();
    const tx = new WebAnnotationTransaction(
      structuredClone(this.current),
      new Date(nowMs).toISOString(),
      nowMs,
    );
    const value = await work(tx);
    if (!tx.dirty) return { value, revision: this.current.revision, committed: false };
    const previous = this.current;
    const next = tx.manifest;
    next.revision = previous.revision + 1;
    next.updatedAt = tx.now;
    for (const id of tx.annotationIds) next.changedAt[id] = next.revision;

    // Draft index changes made by this commit (removals when a note is
    // published from its draft). The listing index records the removed ids
    // first so a crash before `drafts.json` is written is repaired on load.
    let draftRecordBytes = this.draftRecordBytes;
    for (const drop of tx.dropDraftRecords)
      draftRecordBytes = Math.max(0, draftRecordBytes - drop.bytes);
    const removedDraftIds = Object.values(previous.drafts)
      .filter((draft) => next.drafts[draft.editorId]?.id !== draft.id)
      .map((draft) => draft.id);
    const draftsChanged =
      this.draftsDirty ||
      removedDraftIds.length > 0 ||
      Object.values(next.drafts).some((draft) =>
        previous.drafts[draft.editorId] !== undefined
          ? previous.drafts[draft.editorId]!.revision !== draft.revision
          : true,
      );
    if (removedDraftIds.length > 0) {
      next.consumedDrafts = [...(previous.consumedDrafts ?? []), ...removedDraftIds].slice(
        -CONSUMED_DRAFT_IDS,
      );
    }
    const writeDrafts = draftsChanged && this.draftsStatus === "ready";

    const text = this.planRequestText(tx);
    const json = JSON.stringify(persistManifest(next, text.refs));
    const bytes = Buffer.byteLength(json);
    const draftsJson = writeDrafts ? this.draftIndexJson(next.drafts, draftRecordBytes) : null;
    const draftsBytes = draftsJson ? Buffer.byteLength(draftsJson) : this.committedDraftsBytes;
    const total = bytes + next.usage.recordBytes + draftsBytes + draftRecordBytes;
    const previousTotal = this.metadataBytes;
    if (
      !tx.essential &&
      total > WEB_ANNOTATION_LIMITS.environmentMetadataBytes &&
      total > previousTotal
    ) {
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
    const recordKeys = tx.records.map((record) => this.recordPath(record.id, record.revision));
    for (const key of recordKeys) this.inFlightRecords.add(key);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.options.faults?.("before-record-write", this.environmentId);
      await this.writeRecords(tx.records);
      if (tx.promotions.length > 0) {
        await mkdir(join(this.dir, "assets"), { recursive: true, mode: 0o700 });
        for (const promotion of tx.promotions) {
          await rename(promotion.stagingPath, this.assetPath(promotion.assetId));
          this.activeStaging.delete(promotion.stagingPath);
        }
      }
      await this.options.faults?.("before-manifest-replace", this.environmentId);
      await preservePrevious(this.manifestPath(), this.previousPath());
      await writeDurable(this.manifestPath(), json);
      if (this.options.syncDirectories !== false) await syncDirectory(this.dir);
    } finally {
      for (const key of recordKeys) this.inFlightRecords.delete(key);
    }
    // Commit point passed: publish in-memory state synchronously.
    this.current = next;
    this.committedManifestBytes = bytes;
    for (const [id, entry] of text.written) this.persistedText.set(id, entry);
    for (const id of Array.from(this.persistedText.keys())) {
      if (!next.requests[id]) this.persistedText.delete(id);
    }
    this.draftRecordBytes = draftRecordBytes;
    this.refreshActive(tx.requestIds);
    for (const id of tx.annotationIds) {
      if (!next.annotations[id]) this.unavailable.delete(id);
    }
    // Records the previous listing index referenced survive one more commit.
    const manifestDeferred = this.manifestDeferred;
    this.manifestDeferred = tx.dropRecords.map((drop) => this.recordPath(drop.id, drop.revision));
    await this.flushDeferred(manifestDeferred);
    for (const assetId of tx.dropAssets) {
      await unlink(this.assetPath(assetId)).catch(() => undefined);
    }
    if (draftsJson) {
      try {
        await this.replaceDraftIndex(draftsJson);
        this.committedDraftsBytes = Buffer.byteLength(draftsJson);
        this.draftsSequence++;
        this.draftsDirty = false;
        const draftsDeferred = this.draftsDeferred;
        this.draftsDeferred = tx.dropDraftRecords.map((drop) =>
          this.recordPath(drop.id, drop.revision),
        );
        await this.flushDeferred(draftsDeferred);
      } catch (error) {
        // The listing index is committed; `consumedDrafts` repairs the draft
        // index on the next load or draft commit.
        this.draftsDirty = true;
        console.warn(
          `[web-annotations] Draft index write deferred: ${error instanceof Error ? error.name : "unknown"}`,
        );
      }
    }
    this.observe({
      scope: "manifest",
      durationMs: Math.max(0, Date.now() - startedAt),
      indexBytes: bytes,
      records: tx.records.length,
      requestIds: Array.from(tx.requestIds),
      previous,
      next,
    });
    try {
      this.options.onCommit?.({
        environmentId: this.environmentId,
        revision: next.revision,
        annotationIds: Array.from(tx.annotationIds),
        requestIds: Array.from(tx.requestIds),
      });
    } catch (error) {
      console.warn(
        "[web-annotations] Change hint listener failed:",
        error instanceof Error ? error.name : "unknown",
      );
    }
    await this.options.faults?.("after-commit", this.environmentId);
    return { value, revision: next.revision, committed: true };
  }

  private async runDrafts<T>(
    work: (tx: WebAnnotationDraftTransaction) => T | Promise<T>,
  ): Promise<WebAnnotationCommitResult<T>> {
    this.assertDraftsWritable();
    const startedAt = Date.now();
    const nowMs = this.nowMs();
    const tx = new WebAnnotationDraftTransaction(
      this.current,
      structuredClone(this.current.drafts),
      new Date(nowMs).toISOString(),
      nowMs,
    );
    const value = await work(tx);
    if (!tx.dirty && !this.draftsDirty) {
      return { value, revision: this.current.revision, committed: false };
    }
    let recordBytes = this.draftRecordBytes + tx.addedBytes;
    for (const drop of tx.dropRecords) recordBytes = Math.max(0, recordBytes - drop.bytes);
    const json = this.draftIndexJson(tx.drafts, recordBytes);
    const bytes = Buffer.byteLength(json);
    const previousTotal = this.metadataBytes;
    const total =
      this.committedManifestBytes + this.current.usage.recordBytes + bytes + recordBytes;
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
    const recordKeys = tx.records.map((record) => this.recordPath(record.id, record.revision));
    for (const key of recordKeys) this.inFlightRecords.add(key);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.options.faults?.("before-record-write", this.environmentId);
      await this.writeRecords(tx.records);
      await this.replaceDraftIndex(json);
    } finally {
      for (const key of recordKeys) this.inFlightRecords.delete(key);
    }
    const previous = this.current;
    this.current = { ...this.current, drafts: tx.drafts };
    this.committedDraftsBytes = bytes;
    this.draftsSequence++;
    this.draftRecordBytes = recordBytes;
    this.draftsDirty = false;
    const deferred = this.draftsDeferred;
    this.draftsDeferred = tx.dropRecords.map((drop) => this.recordPath(drop.id, drop.revision));
    await this.flushDeferred(deferred);
    this.observe({
      scope: "drafts",
      durationMs: Math.max(0, Date.now() - startedAt),
      indexBytes: bytes,
      records: tx.records.length,
      requestIds: [],
      previous,
      next: this.current,
    });
    return { value, revision: this.current.revision, committed: true };
  }

  /**
   * Remove uncommitted leftovers older than the staging grace period: staging
   * uploads, record directories and asset files the manifest never referenced,
   * superseded text/draft revisions no index generation references, and
   * abandoned temp files. Bounded per call by `batch` and `deadline`.
   */
  async cleanup(options: { batch?: number; deadline?: number } = {}): Promise<number> {
    if (this.storageStatus !== "ready" || this.closed) return 0;
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
    const referenced = new Set<string>();
    const manifest = this.current;
    const add = (id: string) => referenced.add(recordDirectoryName(id));
    for (const id of Object.keys(manifest.captures)) add(id);
    for (const entries of Object.values(manifest.entries))
      for (const entry of entries) add(entry.id);
    for (const id of Object.keys(manifest.requests)) {
      add(id);
      add(requestTextRecordId(id));
    }
    for (const id of Object.keys(manifest.results)) add(id);
    for (const draft of Object.values(manifest.drafts)) add(draft.id);
    const inFlightDirs = new Set(
      Array.from(this.inFlightRecords).map((path) => path.split(/[\\/]/).at(-2)),
    );
    for (const name of await list(join(this.dir, "records"))) {
      if (!budgetLeft()) return removed;
      if (referenced.has(name) || inFlightDirs.has(name)) continue;
      const path = join(this.dir, "records", name);
      if (!(await expired(path))) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      removed++;
    }
    // Revisions older than current-1 are referenced by neither index
    // generation (a crash can leave them behind before deferred removal).
    const revisioned: Array<{ id: string; revision: number }> = [];
    for (const [id, text] of this.persistedText) {
      if (text.revision >= 3)
        revisioned.push({ id: requestTextRecordId(id), revision: text.revision });
    }
    for (const draft of Object.values(manifest.drafts)) {
      if (draft.revision >= 3) revisioned.push({ id: draft.id, revision: draft.revision });
    }
    for (const item of revisioned) {
      if (!budgetLeft()) return removed;
      const directory = join(this.dir, "records", recordDirectoryName(item.id));
      for (const name of await list(directory)) {
        const match = /^(\d+)\.json$/.exec(name);
        if (!match || Number(match[1]) >= item.revision - 1) continue;
        await rm(join(directory, name), { force: true }).catch(() => undefined);
        removed++;
        if (!budgetLeft()) return removed;
      }
    }
    for (const name of await list(join(this.dir, "assets"))) {
      if (!budgetLeft()) return removed;
      const id = name.endsWith(".png") ? name.slice(0, -4) : null;
      if (id && manifest.assets[id]) continue;
      const path = join(this.dir, "assets", name);
      if (!(await expired(path))) continue;
      await rm(path, { force: true }).catch(() => undefined);
      removed++;
    }
    for (const name of await list(this.dir)) {
      if (!budgetLeft()) return removed;
      if (!name.endsWith(".tmp")) continue;
      const path = join(this.dir, name);
      if (!(await expired(path))) continue;
      await rm(path, { force: true }).catch(() => undefined);
      removed++;
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

  constructor(private readonly options: WebAnnotationStorageOptions) {
    this.root = join(options.dataDir, "web-annotations");
  }

  /** Load every persisted environment so background work runs unmounted. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = await readdir(this.root).catch(() => [] as string[]);
    for (const name of names) {
      if (!isEnvironmentDirectoryName(name)) continue;
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
    return this.deleted.has(environmentId);
  }

  async environment(environmentId: string): Promise<WebAnnotationEnvironmentStore> {
    if (!isEnvironmentDirectoryName(environmentId)) {
      throw new WebAnnotationStorageError("Environment id is invalid");
    }
    if (this.deleted.has(environmentId)) {
      throw new WebAnnotationStorageError("Environment was deleted");
    }
    const existing = this.stores.get(environmentId);
    if (existing) return existing;
    let loading = this.loading.get(environmentId);
    if (!loading) {
      loading = (async () => {
        const store = new WebAnnotationEnvironmentStore(environmentId, this.root, this.options);
        await store.load();
        this.stores.set(environmentId, store);
        return store;
      })().finally(() => this.loading.delete(environmentId));
      this.loading.set(environmentId, loading);
    }
    return loading;
  }

  /**
   * Environment deletion: reject further writes, let the in-flight commit
   * finish, then remove the directory. Idempotent.
   */
  async deleteEnvironment(environmentId: string): Promise<void> {
    if (!isEnvironmentDirectoryName(environmentId)) return;
    this.deleted.add(environmentId);
    const store =
      this.stores.get(environmentId) ??
      (await this.loading.get(environmentId)?.catch(() => undefined));
    await store?.close();
    this.stores.delete(environmentId);
    await rm(join(this.root, environmentId), { recursive: true, force: true });
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.stores.values()).map((store) => store.drain()));
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
