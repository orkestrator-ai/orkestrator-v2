/**
 * Web annotation service: per-environment store operations.
 *
 * Capabilities, change hints, receipt reads, editor drafts, asset staging and
 * reads, and garbage collection. Shared state and helpers live in
 * `web-annotation-context.ts`.
 */
import {
  WEB_ANNOTATION_CONTRACT_VERSION,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_SUBMITTABLE_TARGET_KINDS,
  webAnnotationUtf8Bytes,
  type WebAnnotationAsset,
  type WebAnnotationAssetStageInput,
  type WebAnnotationAssetStageResult,
  type WebAnnotationCapabilities,
  type WebAnnotationChanges,
  type WebAnnotationDraft,
  type WebAnnotationDraftSaveInput,
  type WebAnnotationOperationReceipt,
} from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationDestination,
  isWebAnnotationId,
} from "@orkestrator/protocol/web-annotations-validation";
import { decodeBase64Png, planAssetCollection } from "./web-annotation-assets.js";
import { newId, type WebAnnotationContext } from "./web-annotation-context.js";
import {
  planMaterializedCleanup,
  removeMaterializedEvidence,
} from "./web-annotation-materialization.js";
import {
  WebAnnotationServiceError,
  capacityError,
  conflictError,
  degradedError,
  notFound,
} from "./web-annotation-service-errors.js";
import type { ManifestDraft, WebAnnotationEnvironmentStore } from "./web-annotation-storage.js";

const MAX_DRAFTS_PER_ENVIRONMENT = 256;
const EDITOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/;

export class WebAnnotationStoreOperations {
  constructor(private readonly ctx: WebAnnotationContext) {}

  // -------------------------------------------------------------------------
  // Capabilities and synchronization

  async capabilities(environmentId?: string): Promise<WebAnnotationCapabilities> {
    const mode = this.ctx.rolloutMode;
    let storage: WebAnnotationCapabilities["storage"] = "ready";
    let degradedReason: string | undefined;
    try {
      if (environmentId) {
        const store = await this.ctx.env(environmentId);
        storage = store.status;
        degradedReason = store.degradedReason;
      } else {
        await this.ctx.initialize();
      }
    } catch (error) {
      storage = "unavailable";
      degradedReason = error instanceof Error ? error.message : "storage unavailable";
    }
    const readable = storage !== "unavailable" && mode !== "disabled";
    const writable = storage === "ready";
    const authoring = writable && mode === "enabled";
    const dispatchWired = Boolean(
      this.ctx.options.dispatch && this.ctx.options.compileBrief && this.ctx.options.composeText,
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
        resultTools: dispatch && this.ctx.options.resultTools === true,
        // Side-by-side after-captures (`web_annotation_result_capture`). Pixel
        // differences are not implemented and are never advertised here.
        comparison: dispatch,
        migration: authoring && Boolean(this.ctx.options.storage?.listComposeDrafts),
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
    const store = await this.ctx.env(environmentId);
    // Reading the manifest asserts readability.
    const revision = store.manifest.revision;
    const changes = this.ctx.ring.changes(environmentId, generation, after, revision);
    this.ctx.metrics.recordChanges(changes.resetRequired);
    return changes;
  }

  async receipt(
    environmentId: string,
    operationId: string,
  ): Promise<WebAnnotationOperationReceipt | null> {
    const store = await this.ctx.env(environmentId);
    return (
      store.manifest.receipts.find((receipt) => receipt.operationId === operationId)?.receipt ??
      null
    );
  }

  // -------------------------------------------------------------------------
  // Drafts: draft rows and draft text records only, so autosave writes stay
  // small and never advance the environment revision.

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
    const store = await this.ctx.env(environmentId);
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
    const store = await this.ctx.env(input.environmentId);
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
    const store = await this.ctx.env(environmentId);
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

  async stageAsset(input: WebAnnotationAssetStageInput): Promise<WebAnnotationAssetStageResult> {
    this.ctx.assertOperationId(input.operationId);
    if (input.mediaType !== "image/png")
      throw new WebAnnotationServiceError("Only PNG images are supported");
    const png = decodeBase64Png(input.data);
    const store = await this.ctx.env(input.environmentId);
    return this.ctx.storeAssetBytes(store, png);
  }

  async getAsset(
    environmentId: string,
    assetId: string,
  ): Promise<{ asset: WebAnnotationAsset; data: string }> {
    const store = await this.ctx.env(environmentId);
    const asset = isWebAnnotationId(assetId) ? store.manifest.assets[assetId] : undefined;
    if (!asset) throw notFound("Asset");
    const bytes = await store.readAsset(assetId);
    return { asset: this.ctx.publicAsset(environmentId, asset), data: bytes.toString("base64") };
  }

  /**
   * One bounded GC pass for an environment: orphan marks, asset removals,
   * settled materialized evidence, and uncommitted staging and asset files.
   */
  async collectGarbage(
    environmentId: string,
    options: { deadline?: number } = {},
  ): Promise<{ removedAssets: number; removedFiles: number; removedEvidence: number }> {
    const startedAt = Date.now();
    const store = await this.ctx.env(environmentId);
    if (store.status !== "ready" || store.isClosed) {
      return { removedAssets: 0, removedFiles: 0, removedEvidence: 0 };
    }
    let removedAssets = 0;
    const initial = planAssetCollection(store.manifest, this.ctx.nowMs(), {
      pending: this.ctx.pendingAssetIds.keys(),
    });
    if (initial.markOrphaned.length + initial.unmark.length + initial.remove.length > 0) {
      const result = await store.mutate((tx) => {
        tx.markEssential();
        const plan = planAssetCollection(tx.manifest, tx.nowMs, {
          pending: this.ctx.pendingAssetIds.keys(),
        });
        for (const id of plan.unmark) tx.edit("assets", id)!.orphanedAt = null;
        for (const id of plan.markOrphaned) tx.edit("assets", id)!.orphanedAt = tx.now;
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
    this.ctx.metrics.recordGc(outcome, Math.max(0, Date.now() - startedAt));
    return outcome;
  }

  /** Remove settled evidence files this backend wrote, then stop tracking them. */
  private async collectMaterializedEvidence(
    store: WebAnnotationEnvironmentStore,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<number> {
    const plan = planMaterializedCleanup(store.manifest, this.ctx.nowMs(), {
      retentionMs: this.ctx.options.materializedRetentionMs,
    });
    if (plan.length === 0) return 0;
    const environment = await this.ctx.hostEnvironment(store.environmentId);
    const done: typeof plan = [];
    let removed = 0;
    for (const item of plan) {
      if (Date.now() >= deadline) break;
      const outcome = await removeMaterializedEvidence(environment, item, this.ctx.options.invoke);
      if (outcome === "retry") continue;
      if (outcome === "removed") removed++;
      this.ctx.metrics.increment(`evidence_cleanup|outcome=${outcome}`);
      done.push(item);
    }
    if (done.length === 0) return 0;
    await store.mutate((tx) => {
      tx.markEssential();
      for (const item of done) {
        const request = tx.edit("requests", item.requestId);
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
}
