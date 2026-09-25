/**
 * Web annotation service: storage-facing base layer.
 *
 * Lifecycle, capabilities, the rollout switch, change hints, operation
 * receipts, editor drafts, assets, and garbage collection. Threads extend
 * this in `web-annotation-service-core.ts`; requests and migration extend
 * that in turn.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_WEB_ANNOTATION_ROLLOUT_MODE,
  WEB_ANNOTATION_CONTRACT_VERSION,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_SUBMITTABLE_TARGET_KINDS,
  WEB_ANNOTATIONS_CHANGED_EVENT,
  webAnnotationUtf8Bytes,
  type WebAnnotation,
  type WebAnnotationAsset,
  type WebAnnotationAssetStageInput,
  type WebAnnotationAssetStageResult,
  type WebAnnotationCapabilities,
  type WebAnnotationChanges,
  type WebAnnotationDraft,
  type WebAnnotationDraftSaveInput,
  type WebAnnotationOperationReceipt,
  type WebAnnotationRolloutMode,
} from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationDestination,
  isWebAnnotationId,
} from "@orkestrator/protocol/web-annotations-validation";
import type {
  CompileBriefInput,
  CompiledBrief,
  ComposeDispatchText,
  WebAnnotationDispatchPort,
} from "./web-annotation-contracts.js";
import {
  decodeBase64Png,
  environmentImageUsage,
  planAssetCollection,
} from "./web-annotation-assets.js";
import {
  planMaterializedCleanup,
  removeMaterializedEvidence,
} from "./web-annotation-materialization.js";
import { WebAnnotationMetrics } from "./web-annotation-metrics.js";
import {
  WebAnnotationServiceError,
  capacityError,
  conflictError,
  degradedError,
  notFound,
} from "./web-annotation-service-errors.js";
import {
  WebAnnotationStorage,
  type ManifestAsset,
  type ManifestDraft,
  type WebAnnotationEnvironmentStore,
  type WebAnnotationFaultHook,
  type WebAnnotationManifest,
  type WebAnnotationTransaction,
} from "./web-annotation-storage.js";
import { WebAnnotationChangeRing } from "./web-annotation-sync.js";

export {
  WebAnnotationServiceError,
  archivedError,
  capacityError,
  conflictError,
  degradedError,
  errorOutcome,
  notFound,
  rolloutError,
} from "./web-annotation-service-errors.js";

/** Narrow view of `StorageService` used by annotations. */
export interface WebAnnotationHostEnvironment {
  id: string;
  environmentType: string;
  worktreePath?: string;
  containerId: string | null;
  deletionRequestedAt?: string;
}

export interface WebAnnotationHostComposeDraft {
  draftKey: string;
  ownerType: "environment" | "project";
  ownerId: string;
  value: unknown;
  revision: number;
  updatedAt: string;
}

export interface WebAnnotationHostStorage {
  getEnvironment(environmentId: string): Promise<WebAnnotationHostEnvironment | null>;
  listComposeDrafts?(
    ownerType: "environment" | "project",
    ownerId: string,
  ): Promise<WebAnnotationHostComposeDraft[]>;
  getComposeDraft?(draftKey: string): Promise<WebAnnotationHostComposeDraft | null>;
  saveComposeDraft?(
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
    value: unknown,
    expectedRevision?: number,
  ): Promise<WebAnnotationHostComposeDraft>;
  listNativeAgentSessions?(): Promise<
    Array<{ environmentId: string; logicalSessionKey: string; pendingDispatch?: unknown }>
  >;
}

export interface WebAnnotationServiceOptions {
  dataDir: string;
  emit?: (event: string, payload: unknown) => void;
  clock?: () => number;
  faults?: WebAnnotationFaultHook;
  storage?: WebAnnotationHostStorage;
  dispatch?: WebAnnotationDispatchPort;
  compileBrief?: (input: CompileBriefInput) => CompiledBrief;
  composeText?: ComposeDispatchText;
  /** Runs a registered backend command (container reads/cleanup, migration). */
  invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  reconcileIntervalMs?: number;
  /** Advertise agent result tools (the tools server must also be wired). */
  resultTools?: boolean;
  syncDirectories?: boolean;
  generation?: string;
  /** Rollout switch; defaults to `enabled`. Read on every capabilities call. */
  rolloutMode?: () => WebAnnotationRolloutMode;
  /** Shared metrics sink (one per backend). */
  metrics?: WebAnnotationMetrics;
  /** Retention of materialized evidence after a request settles. */
  materializedRetentionMs?: number;
}

/** Deterministic JSON for body hashes: object keys sorted, undefined dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function hashBody(kind: string, body: unknown): string {
  return createHash("sha256").update(kind).update("\0").update(stableStringify(body)).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

const MAX_DRAFTS_PER_ENVIRONMENT = 256;
const EDITOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/;

export abstract class WebAnnotationServiceBase {
  readonly storage: WebAnnotationStorage;
  readonly ring: WebAnnotationChangeRing;
  readonly metrics: WebAnnotationMetrics;
  protected readonly options: WebAnnotationServiceOptions;
  private initialization: Promise<void> | undefined;
  private initialized = false;
  /** Asset ids referenced by in-memory work that GC must keep. */
  protected readonly pendingAssetIds = new Map<string, number>();

  constructor(options: WebAnnotationServiceOptions) {
    this.options = options;
    this.metrics = options.metrics ?? new WebAnnotationMetrics();
    this.ring = new WebAnnotationChangeRing({}, options.generation);
    this.storage = new WebAnnotationStorage({
      dataDir: options.dataDir,
      clock: options.clock,
      faults: options.faults,
      syncDirectories: options.syncDirectories,
      observeCommit: (observation) => this.metrics.observeCommit(observation),
      onCommit: (commit) => {
        const hint = this.ring.record(
          commit.environmentId,
          commit.revision,
          commit.annotationIds,
          commit.requestIds,
        );
        try {
          this.options.emit?.(WEB_ANNOTATIONS_CHANGED_EVENT, hint);
        } catch {
          // Hints are advisory; clients reconcile from snapshots.
        }
      },
    });
  }

  get generation(): string {
    return this.ring.generation;
  }

  /** The rollout mode in force for client entry points. */
  get rolloutMode(): WebAnnotationRolloutMode {
    return this.options.rolloutMode?.() ?? DEFAULT_WEB_ANNOTATION_ROLLOUT_MODE;
  }

  protected nowMs(): number {
    return this.options.clock?.() ?? Date.now();
  }
  protected nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= this.storage.init().then(
      () => {
        this.initialized = true;
      },
      (error: unknown) => {
        this.initialization = undefined;
        throw error;
      },
    );
    await this.initialization;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  protected async env(environmentId: string): Promise<WebAnnotationEnvironmentStore> {
    if (!isWebAnnotationId(environmentId))
      throw new WebAnnotationServiceError("environmentId is invalid");
    await this.initialize();
    return this.storage.environment(environmentId);
  }

  protected async hostEnvironment(
    environmentId: string,
  ): Promise<WebAnnotationHostEnvironment | null> {
    if (this.storage.isDeleted(environmentId)) return null;
    if (!this.options.storage) {
      return { id: environmentId, environmentType: "unknown", containerId: null };
    }
    const environment = await this.options.storage.getEnvironment(environmentId);
    if (!environment || environment.deletionRequestedAt) return null;
    return environment;
  }

  // -------------------------------------------------------------------------
  // Capabilities and synchronization

  async capabilities(environmentId?: string): Promise<WebAnnotationCapabilities> {
    const mode = this.rolloutMode;
    let storage: WebAnnotationCapabilities["storage"] = "ready";
    let degradedReason: string | undefined;
    try {
      if (environmentId) {
        const store = await this.env(environmentId);
        storage = store.status;
        degradedReason = store.degradedReason;
      } else {
        await this.initialize();
      }
    } catch (error) {
      storage = "unavailable";
      degradedReason = error instanceof Error ? error.message : "storage unavailable";
    }
    const readable = storage !== "unavailable" && mode !== "disabled";
    const writable = storage === "ready";
    const authoring = writable && mode === "enabled";
    const dispatchWired = Boolean(
      this.options.dispatch && this.options.compileBrief && this.options.composeText,
    );
    const dispatch = authoring && dispatchWired;
    return {
      contractVersion: WEB_ANNOTATION_CONTRACT_VERSION,
      storage,
      ...(degradedReason ? { degradedReason } : {}),
      mode,
      operations: {
        read: readable,
        author: authoring,
        captureAccept: authoring,
        dispatch,
        batch: dispatch,
        resultTools: dispatch && this.options.resultTools === true,
        // Side-by-side after-captures (`web_annotation_result_capture`). Pixel
        // differences are not implemented and are never advertised here.
        comparison: dispatch,
        migration: authoring && Boolean(this.options.storage?.listComposeDrafts),
        // Recovery mode keeps resolution and in-flight request handling.
        resolve: writable && mode !== "disabled",
        recover: readable && dispatchWired,
        archive: authoring,
      },
      targets: authoring ? [...WEB_ANNOTATION_SUBMITTABLE_TARGET_KINDS] : [],
      maxRequestAnnotations: dispatch ? WEB_ANNOTATION_LIMITS.briefAnnotations : 0,
      limits: WEB_ANNOTATION_LIMITS,
    };
  }

  async changes(
    environmentId: string,
    generation: string | undefined,
    after: number,
  ): Promise<WebAnnotationChanges> {
    const store = await this.env(environmentId);
    // Reading the manifest asserts readability.
    const revision = store.manifest.revision;
    const changes = this.ring.changes(environmentId, generation, after, revision);
    this.metrics.recordChanges(changes.resetRequired);
    return changes;
  }

  // -------------------------------------------------------------------------
  // Receipts

  protected lookupReceipt(
    manifest: WebAnnotationManifest,
    operationId: string,
    kind: string,
    bodyHash: string,
  ) {
    const found = manifest.receipts.find((receipt) => receipt.operationId === operationId);
    if (!found) return null;
    if (found.kind !== kind || found.bodyHash !== bodyHash) {
      throw conflictError(
        `operation ${operationId} was already used with a different request body`,
      );
    }
    return found;
  }

  protected pushReceipt(
    tx: WebAnnotationTransaction,
    receipt: WebAnnotationManifest["receipts"][number],
  ): void {
    tx.manifest.receipts.push(receipt);
    const overflow = tx.manifest.receipts.length - WEB_ANNOTATION_LIMITS.operationReceipts;
    if (overflow > 0) tx.manifest.receipts.splice(0, overflow);
    tx.markDirty();
  }

  async receipt(
    environmentId: string,
    operationId: string,
  ): Promise<WebAnnotationOperationReceipt | null> {
    const store = await this.env(environmentId);
    return (
      store.manifest.receipts.find((receipt) => receipt.operationId === operationId)?.receipt ??
      null
    );
  }

  protected assertOperationId(operationId: unknown): asserts operationId is string {
    if (!isWebAnnotationId(operationId))
      throw new WebAnnotationServiceError("operationId is invalid");
  }

  /**
   * Shared shape of every annotation mutation that returns an operation
   * receipt. A repeated operation id with the same body returns the original
   * receipt without committing; a changed body conflicts.
   */
  protected async annotationMutation(
    environmentId: string,
    operationId: string,
    kind: string,
    body: unknown,
    work: (
      tx: WebAnnotationTransaction,
      store: WebAnnotationEnvironmentStore,
    ) => {
      annotation: WebAnnotation;
      captureId?: string | null;
      entryId?: string | null;
    },
  ): Promise<WebAnnotationOperationReceipt> {
    this.assertOperationId(operationId);
    const store = await this.env(environmentId);
    const bodyHash = hashBody(kind, body);
    const result = await store.mutate((tx) => {
      const existing = this.lookupReceipt(tx.manifest, operationId, kind, bodyHash);
      if (existing?.receipt) return existing.receipt;
      const out = work(tx, store);
      const receipt: WebAnnotationOperationReceipt = {
        operationId,
        annotationId: out.annotation.id,
        captureId: out.captureId === undefined ? out.annotation.currentCaptureId : out.captureId,
        entryId: out.entryId ?? null,
        contentRevision: out.annotation.contentRevision,
        metadataRevision: out.annotation.metadataRevision,
        captureRevision: out.annotation.captureRevision,
        environmentRevision: tx.manifest.revision + 1,
      };
      this.pushReceipt(tx, { operationId, kind, bodyHash, recordedAt: tx.now, receipt });
      tx.touch({ annotationIds: [out.annotation.id] });
      return receipt;
    });
    return result.value;
  }

  // -------------------------------------------------------------------------
  // Drafts: persisted in the draft index (`drafts.json`), never the listing
  // index, so autosave writes stay small.

  /** Remove drafts inside a manifest transaction (a note published from them). */
  protected removeDraftInTx(
    tx: WebAnnotationTransaction,
    predicate: (draft: ManifestDraft) => boolean,
  ): void {
    for (const [editorId, draft] of Array.from(Object.entries(tx.manifest.drafts))) {
      if (!predicate(draft)) continue;
      delete tx.manifest.drafts[editorId];
      tx.dropDraftRecordAfterCommit(draft.id, draft.revision, draft.bytes);
    }
  }

  private draftProjection(
    environmentId: string,
    draft: ManifestDraft,
    text: string,
  ): WebAnnotationDraft {
    return {
      id: draft.id,
      environmentId,
      editorId: draft.editorId,
      revision: draft.revision,
      annotationId: draft.annotationId,
      captureId: draft.captureId,
      pendingCaptureId: draft.pendingCaptureId,
      text,
      operation: draft.operation,
      destination: draft.destination,
      updatedAt: draft.updatedAt,
    };
  }

  private assertEditorId(editorId: unknown): asserts editorId is string {
    if (typeof editorId !== "string" || !EDITOR_ID.test(editorId)) {
      throw new WebAnnotationServiceError("editorId is invalid");
    }
  }

  async getDraft(environmentId: string, editorId: string): Promise<WebAnnotationDraft | null> {
    this.assertEditorId(editorId);
    const store = await this.env(environmentId);
    store.assertDraftsReadable();
    const draft = store.manifest.drafts[editorId];
    if (!draft) return null;
    const record = await store
      .readRecord<{ text: string }>("draft", draft.id, draft.revision)
      .catch(() => {
        throw degradedError("draft record is unreadable");
      });
    return this.draftProjection(environmentId, draft, record.text);
  }

  async saveDraft(input: WebAnnotationDraftSaveInput): Promise<WebAnnotationDraft> {
    this.assertEditorId(input.editorId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new WebAnnotationServiceError("expectedRevision is invalid");
    }
    if (
      typeof input.text !== "string" ||
      input.text.length > WEB_ANNOTATION_LIMITS.entryChars ||
      webAnnotationUtf8Bytes(input.text) > WEB_ANNOTATION_LIMITS.entryChars * 4
    ) {
      throw capacityError(`draft text exceeds ${WEB_ANNOTATION_LIMITS.entryChars} characters`, {
        resource: "draft-text",
        used: typeof input.text === "string" ? input.text.length : 0,
        limit: WEB_ANNOTATION_LIMITS.entryChars,
      });
    }
    for (const [name, value] of [
      ["annotationId", input.annotationId],
      ["captureId", input.captureId],
      ["pendingCaptureId", input.pendingCaptureId],
    ] as const) {
      if (value !== undefined && value !== null && !isWebAnnotationId(value)) {
        throw new WebAnnotationServiceError(`${name} is invalid`);
      }
    }
    if (
      input.operation !== undefined &&
      input.operation !== null &&
      input.operation !== "discuss" &&
      input.operation !== "implement"
    ) {
      throw new WebAnnotationServiceError("operation is invalid");
    }
    if (
      input.destination !== undefined &&
      input.destination !== null &&
      !isWebAnnotationDestination(input.destination)
    ) {
      throw new WebAnnotationServiceError("destination is invalid");
    }
    const store = await this.env(input.environmentId);
    const result = await store.mutateDrafts((tx) => {
      const previous = tx.drafts[input.editorId];
      const current = previous?.revision ?? 0;
      if (current !== input.expectedRevision) {
        throw conflictError(
          `draft revision ${input.expectedRevision} is stale (current ${current})`,
        );
      }
      const count = Object.keys(tx.drafts).length;
      if (!previous && count >= MAX_DRAFTS_PER_ENVIRONMENT) {
        throw capacityError(`environment has ${MAX_DRAFTS_PER_ENVIRONMENT} saved drafts`, {
          resource: "drafts",
          used: count,
          limit: MAX_DRAFTS_PER_ENVIRONMENT,
        });
      }
      if (input.annotationId && !tx.manifest.annotations[input.annotationId])
        throw notFound("Annotation");
      if (input.captureId && !tx.manifest.captures[input.captureId]) throw notFound("Capture");
      const id = previous?.id ?? newId("draft");
      const revision = current + 1;
      const bytes = tx.writeRecord(id, revision, { text: input.text });
      if (previous) tx.dropRecordAfterCommit(previous.id, previous.revision, previous.bytes);
      const draft: ManifestDraft = {
        id,
        editorId: input.editorId,
        revision,
        annotationId: input.annotationId ?? null,
        captureId: input.captureId ?? null,
        pendingCaptureId: input.pendingCaptureId ?? null,
        operation: input.operation ?? null,
        destination: input.destination ?? null,
        updatedAt: tx.now,
        bytes,
      };
      tx.drafts[input.editorId] = draft;
      return this.draftProjection(input.environmentId, draft, input.text);
    });
    return result.value;
  }

  async deleteDraft(
    environmentId: string,
    editorId: string,
    expectedRevision: number,
  ): Promise<{ deleted: boolean }> {
    this.assertEditorId(editorId);
    const store = await this.env(environmentId);
    const result = await store.mutateDrafts((tx) => {
      const draft = tx.drafts[editorId];
      if (!draft) return { deleted: false };
      if (draft.revision !== expectedRevision) {
        throw conflictError(
          `draft revision ${expectedRevision} is stale (current ${draft.revision})`,
        );
      }
      delete tx.drafts[editorId];
      tx.dropRecordAfterCommit(draft.id, draft.revision, draft.bytes);
      return { deleted: true };
    });
    return result.value;
  }

  // -------------------------------------------------------------------------
  // Assets

  protected publicAsset(environmentId: string, asset: ManifestAsset): WebAnnotationAsset {
    return {
      id: asset.id,
      environmentId,
      digest: asset.digest,
      mediaType: "image/png",
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
      createdAt: asset.createdAt,
    };
  }

  /** Store validated PNG bytes (already decoded) with digest dedupe and quota. */
  protected async storeAssetBytes(
    store: WebAnnotationEnvironmentStore,
    png: { bytes: Buffer; width: number; height: number; digest: string },
  ): Promise<WebAnnotationAssetStageResult> {
    const environmentId = store.environmentId;
    const findExisting = (manifest: WebAnnotationManifest) =>
      Object.values(manifest.assets).find((asset) => asset.digest === png.digest);
    const quick = findExisting(store.manifest);
    if (quick) return { asset: this.publicAsset(environmentId, quick), deduplicated: true };
    const staging = await store.stageFile(png.bytes);
    try {
      const result = await store.mutate((tx) => {
        const existing = findExisting(tx.manifest);
        if (existing)
          return { asset: this.publicAsset(environmentId, existing), deduplicated: true };
        const usage = environmentImageUsage(tx.manifest);
        const limit = WEB_ANNOTATION_LIMITS.environmentImageBytes;
        if (usage + png.bytes.byteLength > limit) {
          throw capacityError(
            `environment images would use ${usage + png.bytes.byteLength} of ${limit} bytes`,
            { resource: "image-bytes", used: usage, limit, requested: png.bytes.byteLength },
          );
        }
        const asset: ManifestAsset = {
          id: newId("asset"),
          digest: png.digest,
          bytes: png.bytes.byteLength,
          width: png.width,
          height: png.height,
          createdAt: tx.now,
          // Unreferenced until a capture/result uses it; the grace period starts now.
          orphanedAt: tx.now,
        };
        tx.manifest.assets[asset.id] = asset;
        tx.promoteStagedAsset(staging, asset.id);
        return { asset: this.publicAsset(environmentId, asset), deduplicated: false };
      });
      return result.value;
    } finally {
      await store.releaseStaged(staging);
    }
  }

  async stageAsset(input: WebAnnotationAssetStageInput): Promise<WebAnnotationAssetStageResult> {
    this.assertOperationId(input.operationId);
    if (input.mediaType !== "image/png")
      throw new WebAnnotationServiceError("Only PNG images are supported");
    const png = decodeBase64Png(input.data);
    const store = await this.env(input.environmentId);
    return this.storeAssetBytes(store, png);
  }

  async getAsset(
    environmentId: string,
    assetId: string,
  ): Promise<{ asset: WebAnnotationAsset; data: string }> {
    const store = await this.env(environmentId);
    const asset = isWebAnnotationId(assetId) ? store.manifest.assets[assetId] : undefined;
    if (!asset) throw notFound("Asset");
    const bytes = await store.readAsset(assetId);
    return { asset: this.publicAsset(environmentId, asset), data: bytes.toString("base64") };
  }

  protected holdAssets(assetIds: Iterable<string>): void {
    for (const id of assetIds)
      this.pendingAssetIds.set(id, (this.pendingAssetIds.get(id) ?? 0) + 1);
  }
  protected releaseAssets(assetIds: Iterable<string>): void {
    for (const id of assetIds) {
      const count = (this.pendingAssetIds.get(id) ?? 0) - 1;
      if (count > 0) this.pendingAssetIds.set(id, count);
      else this.pendingAssetIds.delete(id);
    }
  }

  /**
   * One bounded GC pass for an environment: orphan marks, asset removals,
   * settled materialized evidence, and uncommitted staging/record leftovers.
   */
  async collectGarbage(
    environmentId: string,
    options: { deadline?: number } = {},
  ): Promise<{ removedAssets: number; removedFiles: number; removedEvidence: number }> {
    const startedAt = Date.now();
    const store = await this.env(environmentId);
    if (store.status !== "ready" || store.isClosed) {
      return { removedAssets: 0, removedFiles: 0, removedEvidence: 0 };
    }
    let removedAssets = 0;
    const initial = planAssetCollection(store.manifest, this.nowMs(), {
      pending: this.pendingAssetIds.keys(),
    });
    if (initial.markOrphaned.length + initial.unmark.length + initial.remove.length > 0) {
      const result = await store.mutate((tx) => {
        tx.markEssential();
        const plan = planAssetCollection(tx.manifest, tx.nowMs, {
          pending: this.pendingAssetIds.keys(),
        });
        for (const id of plan.unmark) tx.manifest.assets[id]!.orphanedAt = null;
        for (const id of plan.markOrphaned) tx.manifest.assets[id]!.orphanedAt = tx.now;
        for (const id of plan.remove) {
          delete tx.manifest.assets[id];
          tx.dropAssetAfterCommit(id);
        }
        if (plan.unmark.length + plan.markOrphaned.length > 0) tx.markDirty();
        return plan.remove.length;
      });
      removedAssets = result.value;
    }
    const removedEvidence = await this.collectMaterializedEvidence(store, options.deadline);
    const removedFiles = await store.cleanup({ deadline: options.deadline });
    const outcome = { removedAssets, removedFiles, removedEvidence };
    this.metrics.recordGc(outcome, Math.max(0, Date.now() - startedAt));
    return outcome;
  }

  /** Remove settled evidence files this backend wrote, then stop tracking them. */
  private async collectMaterializedEvidence(
    store: WebAnnotationEnvironmentStore,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<number> {
    const plan = planMaterializedCleanup(store.manifest, this.nowMs(), {
      retentionMs: this.options.materializedRetentionMs,
    });
    if (plan.length === 0) return 0;
    const environment = await this.hostEnvironment(store.environmentId);
    const done: typeof plan = [];
    let removed = 0;
    for (const item of plan) {
      if (Date.now() >= deadline) break;
      const outcome = await removeMaterializedEvidence(environment, item, this.options.invoke);
      if (outcome === "retry") continue;
      if (outcome === "removed") removed++;
      this.metrics.increment(`evidence_cleanup|outcome=${outcome}`);
      done.push(item);
    }
    if (done.length === 0) return 0;
    await store.mutate((tx) => {
      tx.markEssential();
      for (const item of done) {
        const request = tx.manifest.requests[item.requestId];
        if (!request) continue;
        let changed = false;
        request.attachments = request.attachments.map((attachment) => {
          if (attachment.assetId !== item.assetId || attachment.removedAt) return attachment;
          changed = true;
          return { ...attachment, removedAt: tx.now };
        });
        if (!changed) continue;
        request.revision++;
        request.updatedAt = tx.now;
        tx.touch({ requestIds: [request.id] });
      }
    });
    return removed;
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  async deleteEnvironment(environmentId: string): Promise<void> {
    await this.initialize().catch(() => undefined);
    await this.storage.deleteEnvironment(environmentId);
    this.ring.forget(environmentId);
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
