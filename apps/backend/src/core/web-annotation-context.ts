/**
 * Web annotation service: shared context.
 *
 * The state every part of `WebAnnotationService` works on (storage, change
 * ring, metrics, options, held asset ids) and the helpers they share:
 * initialization, environment lookup, operation receipts, draft removal inside
 * a transaction, and asset storage. Each part (`web-annotation-service-store.ts`,
 * `-threads.ts`, `-results.ts`, `-requests.ts`, `web-annotation-migration.ts`)
 * is a collaborator that takes this context; none of them extends another.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_WEB_ANNOTATION_ROLLOUT_MODE,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATIONS_CHANGED_EVENT,
  type WebAnnotation,
  type WebAnnotationAsset,
  type WebAnnotationAssetStageResult,
  type WebAnnotationFileCheck,
  type WebAnnotationOperationReceipt,
  type WebAnnotationRolloutMode,
} from "@orkestrator/protocol/web-annotations";
import { isWebAnnotationId } from "@orkestrator/protocol/web-annotations-validation";
import type {
  CompileBriefInput,
  CompiledBrief,
  ComposeDispatchText,
  WebAnnotationDispatchPort,
} from "./web-annotation-contracts.js";
import { environmentImageUsage } from "./web-annotation-assets.js";
import { WebAnnotationMetrics } from "./web-annotation-metrics.js";
import {
  WebAnnotationServiceError,
  capacityError,
  conflictError,
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
  /** See `WebAnnotationStorageOptions.verifyRowPlans` (on under `bun test`). */
  verifyRowPlans?: boolean;
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

export class WebAnnotationContext {
  readonly storage: WebAnnotationStorage;
  readonly ring: WebAnnotationChangeRing;
  readonly metrics: WebAnnotationMetrics;
  readonly options: WebAnnotationServiceOptions;
  private initialization: Promise<void> | undefined;
  private initialized = false;

  /** Asset ids referenced by in-memory work that GC must keep. */
  readonly pendingAssetIds = new Map<string, number>();

  constructor(options: WebAnnotationServiceOptions) {
    this.options = options;
    this.metrics = options.metrics ?? new WebAnnotationMetrics();
    this.ring = new WebAnnotationChangeRing({}, options.generation);
    this.storage = new WebAnnotationStorage({
      dataDir: options.dataDir,
      clock: options.clock,
      faults: options.faults,
      syncDirectories: options.syncDirectories,
      verifyRowPlans: options.verifyRowPlans,
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

  nowMs(): number {
    return this.options.clock?.() ?? Date.now();
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const hostStorage = this.options.storage;
    this.initialization ??= this.storage
      .init({
        environmentExists: hostStorage
          ? (environmentId) =>
              hostStorage.getEnvironment(environmentId).then(
                (environment) => environment !== null,
                () => true,
              )
          : undefined,
      })
      .then(
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

  async env(environmentId: string): Promise<WebAnnotationEnvironmentStore> {
    if (!isWebAnnotationId(environmentId))
      throw new WebAnnotationServiceError("environmentId is invalid");
    await this.initialize();
    return this.storage.environment(environmentId);
  }

  async hostEnvironment(environmentId: string): Promise<WebAnnotationHostEnvironment | null> {
    if (this.storage.isDeleted(environmentId)) return null;
    if (!this.options.storage) {
      return { id: environmentId, environmentType: "unknown", containerId: null };
    }
    const environment = await this.options.storage.getEnvironment(environmentId);
    if (!environment || environment.deletionRequestedAt) return null;
    return environment;
  }

  /**
   * Workspace containment/existence of repository-relative paths, through the
   * dispatch port (outside the write queue). Undefined when no check is wired,
   * the environment is gone, or the check fails.
   */
  async checkWorkspacePaths(
    environmentId: string,
    paths: readonly string[],
  ): Promise<WebAnnotationFileCheck[] | undefined> {
    const check = this.options.dispatch?.checkWorkspacePaths;
    if (paths.length === 0 || !check) return undefined;
    const environment = await this.hostEnvironment(environmentId).catch(() => null);
    if (!environment) return undefined;
    return check
      .call(
        this.options.dispatch,
        {
          id: environment.id,
          environmentType: environment.environmentType,
          ...(environment.worktreePath ? { worktreePath: environment.worktreePath } : {}),
          ...(environment.containerId ? { containerId: environment.containerId } : {}),
        },
        paths,
      )
      .catch(() => undefined);
  }

  lookupReceipt(
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

  pushReceipt(
    tx: WebAnnotationTransaction,
    receipt: WebAnnotationManifest["receipts"][number],
  ): void {
    tx.manifest.receipts.push(receipt);
    const overflow = tx.manifest.receipts.length - WEB_ANNOTATION_LIMITS.operationReceipts;
    if (overflow > 0) tx.manifest.receipts.splice(0, overflow);
    tx.markDirty();
  }

  assertOperationId(operationId: unknown): asserts operationId is string {
    if (!isWebAnnotationId(operationId))
      throw new WebAnnotationServiceError("operationId is invalid");
  }

  /**
   * Shared shape of every annotation mutation that returns an operation
   * receipt. A repeated operation id with the same body returns the original
   * receipt without committing; a changed body conflicts.
   */
  async annotationMutation(
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

  /** Remove drafts inside a manifest transaction (a note published from them). */
  removeDraftInTx(
    tx: WebAnnotationTransaction,
    predicate: (draft: ManifestDraft) => boolean,
  ): void {
    for (const [editorId, draft] of Array.from(Object.entries(tx.manifest.drafts))) {
      if (!predicate(draft)) continue;
      delete tx.manifest.drafts[editorId];
      tx.dropDraftRecordAfterCommit(draft.id, draft.revision, draft.bytes);
    }
  }

  publicAsset(environmentId: string, asset: ManifestAsset): WebAnnotationAsset {
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
  async storeAssetBytes(
    store: WebAnnotationEnvironmentStore,
    png: { bytes: Buffer; width: number; height: number; digest: string },
  ): Promise<WebAnnotationAssetStageResult> {
    const environmentId = store.environmentId;
    const findExisting = (manifest: WebAnnotationManifest) =>
      Object.values(manifest.assets).find((asset) => asset.digest === png.digest);
    const quick = findExisting(store.manifest);
    if (quick) return { asset: this.publicAsset(environmentId, quick), deduplicated: true };
    // File work happens before the commit: stage, then promote into assets/
    // under a fresh id. The commit only adds the row; a commit that does not
    // add it (deduplicated or failed) discards the promoted file, unless a
    // committed row references it after all.
    const staging = await store.stageFile(png.bytes);
    const assetId = newId("asset");
    let keep = false;
    try {
      await store.promoteStagedAsset(staging, assetId);
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
          id: assetId,
          digest: png.digest,
          bytes: png.bytes.byteLength,
          width: png.width,
          height: png.height,
          createdAt: tx.now,
          // Unreferenced until a capture/result uses it; the grace period starts now.
          orphanedAt: tx.now,
        };
        tx.manifest.assets[asset.id] = asset;
        tx.markDirty();
        return { asset: this.publicAsset(environmentId, asset), deduplicated: false };
      });
      keep = !result.value.deduplicated;
      return result.value;
    } finally {
      await store.releaseStaged(staging);
      if (!keep) {
        try {
          store.discardUncommittedAsset(assetId);
        } catch {
          // Collected as an orphan after the grace period.
        }
      }
    }
  }

  holdAssets(assetIds: Iterable<string>): void {
    for (const id of assetIds)
      this.pendingAssetIds.set(id, (this.pendingAssetIds.get(id) ?? 0) + 1);
  }

  releaseAssets(assetIds: Iterable<string>): void {
    for (const id of assetIds) {
      const count = (this.pendingAssetIds.get(id) ?? 0) - 1;
      if (count > 0) this.pendingAssetIds.set(id, count);
      else this.pendingAssetIds.delete(id);
    }
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    await this.initialize().catch(() => undefined);
    await this.storage.deleteEnvironment(environmentId);
    this.ring.forget(environmentId);
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
