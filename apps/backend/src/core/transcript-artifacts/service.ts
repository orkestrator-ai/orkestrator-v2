/**
 * TranscriptArtifactService: the backend owner of transcript artifacts.
 *
 * Composes small collaborators over one shared context (no inheritance):
 * authoring (create/update), previews (admission, executor, cancel,
 * recovery), publication, agent reads, renderer reads, the publication
 * ledger, grants and cleanup. Preview infrastructure arrives through
 * `attachRuntime` as the narrow interfaces in contracts.ts; without it, chart
 * and workflow artifacts still verify and publish, and HTML/Mermaid report
 * `renderer_unavailable` rather than publishing unverified content.
 *
 * Coordinator integration points (exported methods):
 * - Dispatch: `mintArtifactGrant` when a shared (environment-wide) provider
 *   registration needs a per-turn `scopeCapability`; `revokeArtifactGrantsForTurn`
 *   on turn settlement/abort; `noteDispatchedTurn`/`clearDispatchedTurn` to
 *   attribute session-bound calls to their turn (repair budget, anchors).
 * - Projection: `publicationsForConversation`, `ledgerRevision`, `onLedgerChange`.
 * - Environment deletion: `deleteEnvironment`.
 * - Conversation deletion: `deleteConversation` (no product path calls it yet;
 *   closing a tab never deletes).
 * - Live hints: the `announce` option receives a content-free
 *   (environment, conversation) change after every committed draft,
 *   operation, publication or deletion change.
 */
import { randomUUID } from "node:crypto";
import type { ArtifactToolName } from "@orkestrator/protocol/transcript-artifacts";
import type {
  ArtifactConversationScope,
  ArtifactDraftListResponse,
  ArtifactDraftReadRequest,
  ArtifactLiveSessionResponse,
  ArtifactPublicationView,
  ArtifactRepresentationRequest,
  ArtifactRepresentationResponse,
  MermaidRenderRequest,
  MermaidRenderResponse,
  ArtifactStageAssetRequest,
  ArtifactStageAssetResponse,
  TranscriptArtifactCapabilities,
  ArtifactPrepareWorkerResponse,
  ArtifactWorkerPreparationStatus,
  TranscriptMediaPdfPreviewResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import type { ArtifactOwner } from "@orkestrator/protocol/transcript-artifacts";
import { deleteConversationRecords } from "./conversation-deletion.js";
import { ArtifactAssetStaging } from "./service-assets.js";
import { ArtifactDraftReads } from "./service-drafts.js";
import type { WorkflowSnapshotV1 } from "@orkestrator/protocol/workflow-snapshot";
import type { StorageDatabase } from "../storage-database.js";
import { ArtifactGarbageCollector, type ArtifactCleanupReport } from "./gc.js";
import {
  ArtifactGrantService,
  type ArtifactGrantVerb,
  type MintArtifactGrantInput,
  type MintedArtifactGrant,
} from "./grants.js";
import { ArtifactLedger, type ArtifactLedgerListener } from "./ledger.js";
import { ArtifactMetrics, logArtifactEvent } from "./metrics.js";
import { resolveArtifactCaller, type ArtifactCallerScope } from "./owner.js";
import { ArtifactAuthoring } from "./service-authoring.js";
import {
  errorResponse,
  toArtifactError,
  type ArtifactAssetResolver,
  type ArtifactResponse,
  type ArtifactRolloutFlags,
  type ArtifactRuntimeParts,
  type ArtifactServiceContext,
} from "./service-context.js";
import type { ArtifactIdentityOverrides } from "./service-identity.js";
import { ArtifactPreviews } from "./service-preview.js";
import { ArtifactPublisher } from "./service-publish.js";
import { ArtifactReads } from "./service-read.js";
import { ArtifactUiReads } from "./service-ui.js";
import { MediaPdfPreviews } from "./service-media-pdf.js";
import {
  TranscriptArtifactStore,
  isArtifactEnvironmentId,
  type ArtifactStoreFaultStage,
} from "./store.js";
import type { StoredPublication } from "./store-records.js";
import {
  WorkflowSnapshotCollector,
  isTerminalWorkflowStatus,
  type WorkflowRecordReader,
} from "./workflow-collector.js";

const DEFAULT_LEASE_MS = 60_000;
const MAX_TRACKED_TURNS = 1_024;

const DISABLED = new Set(["0", "false", "off", "disabled", "no"]);

/** Rollout switches; each defaults on. Disabling never deletes or hides stored records. */
export function readArtifactRolloutFlags(
  env: NodeJS.ProcessEnv = process.env,
): ArtifactRolloutFlags {
  const on = (name: string) => !DISABLED.has((env[name] ?? "").trim().toLowerCase());
  return {
    richMarkdown: on("ORKESTRATOR_RICH_MARKDOWN"),
    artifactPublication: on("ORKESTRATOR_ARTIFACT_PUBLICATION"),
    liveInteractive: on("ORKESTRATOR_ARTIFACT_LIVE_INTERACTIVE"),
  };
}

export interface TranscriptArtifactServiceOptions {
  dataDir: string;
  /** A connection to share instead of opening (and owning) one. */
  database?: StorageDatabase;
  workflows: WorkflowRecordReader;
  /** Project of an environment, for renderer-initiated live workflow reads. */
  environmentProject?: (environmentId: string) => Promise<string | null>;
  runtime?: ArtifactRuntimeParts;
  assetResolver?: ArtifactAssetResolver;
  /** Current dispatched turn of a session-bound conversation (overrides noteDispatchedTurn). */
  currentTurn?: (environmentId: string, conversationKey: string) => string | null | undefined;
  rollout?: () => ArtifactRolloutFlags;
  now?: () => number;
  leaseMs?: number;
  syncDirectories?: boolean;
  faults?: (stage: ArtifactStoreFaultStage, environmentId: string) => void;
  identityOverrides?: ArtifactIdentityOverrides;
  assetBytesPerEnvironment?: number;
  /**
   * Content-free live hint after a committed change to a conversation's
   * drafts, operations or ledger (resource kind `transcript-artifact`, id =
   * conversation key). Must not throw; failures are ignored.
   */
  announce?: (environmentId: string, conversationKey: string) => void;
}

export type WorkflowLiveSnapshotResponse =
  | { status: "available"; snapshot: WorkflowSnapshotV1; terminal: boolean }
  | {
      status: "unavailable";
      reason: "deleted" | "not_found" | "unsupported" | "error";
      message: string;
    };

const TOOL_VERBS: Record<ArtifactToolName, ArtifactGrantVerb> = {
  create_artifact: "create",
  update_artifact: "update",
  preview_artifact: "preview",
  publish_artifact: "publish",
  get_artifact: "read",
  get_artifact_operation: "read",
  cancel_artifact_operation: "cancel",
};

export class TranscriptArtifactService {
  readonly metrics = new ArtifactMetrics();
  readonly ledger: ArtifactLedger;
  readonly store: TranscriptArtifactStore;
  readonly grants: ArtifactGrantService;
  private readonly ctx: ArtifactServiceContext;
  private readonly authoring: ArtifactAuthoring;
  private readonly previews: ArtifactPreviews;
  private readonly publisher: ArtifactPublisher;
  private readonly reads: ArtifactReads;
  private readonly ui: ArtifactUiReads;
  private readonly drafts: ArtifactDraftReads;
  private readonly staging: ArtifactAssetStaging;
  private readonly gc: ArtifactGarbageCollector;
  private readonly collector: WorkflowSnapshotCollector;
  private readonly mediaPdf: MediaPdfPreviews;
  private workerPreparation: {
    status(): ArtifactWorkerPreparationStatus;
    prepare(): Promise<ArtifactPrepareWorkerResponse>;
  } | null = null;
  private readonly turns = new Map<string, string>();
  private closed = false;

  constructor(private readonly options: TranscriptArtifactServiceOptions) {
    const now = options.now ?? Date.now;
    this.store = new TranscriptArtifactStore({
      dataDir: options.dataDir,
      ...(options.database ? { database: options.database } : {}),
      ...(options.syncDirectories !== undefined
        ? { syncDirectories: options.syncDirectories }
        : {}),
      ...(options.faults ? { faults: options.faults } : {}),
      ...(options.assetBytesPerEnvironment !== undefined
        ? { assetBytesPerEnvironment: options.assetBytesPerEnvironment }
        : {}),
    });
    this.grants = new ArtifactGrantService(() => this.store.database(), now);
    this.collector = new WorkflowSnapshotCollector(options.workflows, now);
    const backendId = () => this.store.database().instanceId;
    this.ledger = new ArtifactLedger(this.store, backendId);
    this.ctx = {
      store: this.store,
      grants: this.grants,
      collector: this.collector,
      metrics: this.metrics,
      runtime: { ...options.runtime },
      holder: randomUUID(),
      leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
      now,
      iso: () => new Date(now()).toISOString(),
      backendId,
      rollout: options.rollout ?? (() => readArtifactRolloutFlags()),
      overrides: options.identityOverrides ?? {},
      ...(options.assetResolver ? { assetResolver: options.assetResolver } : {}),
      notifyPublication: (environmentId, conversationKey, publicationId, sequence) => {
        this.ledger.notify({
          environmentId,
          conversationKey,
          publicationId,
          ledgerRevision: sequence,
        });
        this.ctx.announceConversation(environmentId, conversationKey);
      },
      announceConversation: (environmentId, conversationKey) => {
        try {
          options.announce?.(environmentId, conversationKey);
        } catch {
          logArtifactEvent("announce-failed", { environmentId });
        }
      },
    };
    this.authoring = new ArtifactAuthoring(this.ctx);
    this.previews = new ArtifactPreviews(this.ctx);
    this.publisher = new ArtifactPublisher(this.ctx);
    this.reads = new ArtifactReads(this.ctx);
    this.ui = new ArtifactUiReads(this.ctx);
    this.mediaPdf = new MediaPdfPreviews(this.ctx);
    this.drafts = new ArtifactDraftReads(this.ctx);
    this.staging = new ArtifactAssetStaging(
      this.ctx,
      async (environmentId) => (await options.environmentProject?.(environmentId)) ?? null,
    );
    this.gc = new ArtifactGarbageCollector(this.ctx, this.previews);
  }

  backendId(): string {
    return this.ctx.backendId();
  }

  /** Installs (or replaces) the preview runner, preparer and content server. */
  attachRuntime(parts: ArtifactRuntimeParts): void {
    this.ctx.runtime.runner = parts.runner;
    this.ctx.runtime.preparer = parts.preparer;
    this.ctx.runtime.contentServer = parts.contentServer;
  }

  /** Installs on-demand container worker preparation (runtime-wiring.ts). */
  attachWorkerPreparation(preparation: {
    status(): ArtifactWorkerPreparationStatus;
    prepare(): Promise<ArtifactPrepareWorkerResponse>;
  }): void {
    this.workerPreparation = preparation;
  }

  /**
   * Build or pull the isolated container preview worker and re-select
   * isolation (`transcript_artifact_prepare_worker`). Fixed arguments only;
   * nothing here is derived from artifacts.
   */
  async prepareWorker(): Promise<ArtifactPrepareWorkerResponse> {
    if (!this.workerPreparation) {
      const status = this.ctx.runtime.runner?.status();
      return {
        available: false,
        state: "failed",
        method: null,
        reason: "The preview runtime is not running on this backend",
        isolation: status?.isolation ?? "unavailable",
        interactiveIsolation: status?.interactiveIsolation ?? "unavailable",
      };
    }
    return this.workerPreparation.prepare();
  }

  /**
   * First-page preview of a PDF attachment. `read` must be bound to one of
   * the backend's authorized file readers (commands-pdf.ts).
   */
  mediaPdfPreview(
    environmentId: string,
    read: () => Promise<Uint8Array>,
  ): Promise<TranscriptMediaPdfPreviewResponse> {
    return this.mediaPdf.preview(environmentId, read);
  }

  runtime(): Readonly<ArtifactRuntimeParts> {
    return this.ctx.runtime;
  }

  /** Startup recovery (interrupt stale operations), cleanup, and the hourly timer. */
  initialize(): void {
    this.gc.start();
  }

  runCleanup(): Promise<ArtifactCleanupReport> {
    return this.gc.run();
  }

  /** Resolves when scheduled verification work has settled (tests and shutdown). */
  drain(): Promise<void> {
    return this.previews.drain();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gc.stop();
    this.previews.abortAll();
    this.ui.printing.abort();
    this.mediaPdf.abort();
    await this.previews.drain();
    this.store.close();
  }

  // ---------------------------------------------------------------------------
  // Agent tools

  /** Artifact authoring tools are advertised while publication is enabled. */
  toolsEnabled(): boolean {
    return this.ctx.rollout().artifactPublication;
  }

  /**
   * Scope of an artifact-only MCP connection whose bearer token is a turn's
   * artifact grant, or null when the grant does not verify (forged, expired,
   * revoked, another backend's).
   */
  authenticateArtifactGrant(token: string): { environmentId: string; projectId: string } | null {
    if (this.closed) return null;
    try {
      return this.grants.bearerScope(token);
    } catch {
      return null;
    }
  }

  async handleTool(
    name: ArtifactToolName,
    scope: ArtifactCallerScope,
    args: Record<string, unknown>,
    meta: { toolCallId?: string } = {},
  ): Promise<ArtifactResponse> {
    if (this.closed) return errorResponse(toArtifactError(null));
    let caller;
    try {
      caller = resolveArtifactCaller(
        scope,
        typeof args.scopeCapability === "string" ? args.scopeCapability : undefined,
        TOOL_VERBS[name],
        {
          backendId: this.backendId(),
          grants: this.grants,
          currentTurn: (environmentId, conversationKey) =>
            this.options.currentTurn?.(environmentId, conversationKey) ??
            this.turns.get(`${environmentId}\0${conversationKey}`) ??
            null,
        },
      );
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
    switch (name) {
      case "create_artifact":
        return this.authoring.create(caller, { requestKey: args.requestKey, draft: args.draft });
      case "update_artifact":
        return this.authoring.update(caller, {
          requestKey: args.requestKey,
          artifactId: args.artifactId,
          expectedRevision: args.expectedRevision,
          draft: args.draft,
        });
      case "preview_artifact":
        return this.previews.preview(caller, {
          requestKey: args.requestKey,
          artifactId: args.artifactId,
          revision: args.revision,
          ...(args.profile !== undefined ? { profile: args.profile } : {}),
        });
      case "publish_artifact":
        return this.publisher.publish(
          caller,
          {
            requestKey: args.requestKey,
            artifactId: args.artifactId,
            expectedRevision: args.expectedRevision,
            receiptId: args.receiptId,
          },
          meta.toolCallId ? { toolCallId: meta.toolCallId.slice(0, 256) } : {},
        );
      case "get_artifact":
        return this.reads.getArtifact(caller, {
          artifactId: args.artifactId,
          ...(args.revision !== undefined ? { revision: args.revision } : {}),
          ...(args.sourceRange !== undefined ? { sourceRange: args.sourceRange } : {}),
        });
      case "get_artifact_operation":
        return this.reads.getOperation(caller, {
          operationId: args.operationId,
          includePreviewImage: args.includePreviewImage,
          captureIndex: args.captureIndex,
        });
      case "cancel_artifact_operation":
        return this.previews.cancel(caller, {
          requestKey: args.requestKey,
          operationId: args.operationId,
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Grants and dispatch attribution

  /**
   * Mint a per-turn artifact grant for a shared provider registration. Inject
   * it through adapter-owned invocation context, or as the `scopeCapability`
   * argument named in trusted dispatch instructions. Never log it.
   */
  mintArtifactGrant(input: MintArtifactGrantInput): MintedArtifactGrant {
    return this.grants.mint(input);
  }

  /** Revoke a turn's grants at settlement or abort. Already admitted work continues. */
  revokeArtifactGrantsForTurn(environmentId: string, turnId: string): number {
    if (this.turns.size > 0) {
      for (const [key, value] of this.turns)
        if (value === turnId && key.startsWith(`${environmentId}\0`)) this.turns.delete(key);
    }
    return this.grants.revokeForTurn(environmentId, turnId);
  }

  /** Attribute session-bound calls in a conversation to the dispatched turn. */
  noteDispatchedTurn(environmentId: string, conversationKey: string, turnId: string): void {
    const key = `${environmentId}\0${conversationKey}`;
    this.turns.delete(key);
    this.turns.set(key, turnId.slice(0, 256));
    while (this.turns.size > MAX_TRACKED_TURNS) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
  }

  clearDispatchedTurn(environmentId: string, conversationKey: string, turnId?: string): void {
    const key = `${environmentId}\0${conversationKey}`;
    if (turnId === undefined || this.turns.get(key) === turnId) this.turns.delete(key);
  }

  // ---------------------------------------------------------------------------
  // Ledger (projection)

  publicationsForConversation(
    environmentId: string,
    conversationKey: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): StoredPublication[] {
    return this.ledger.publicationsForConversation(environmentId, conversationKey, options);
  }

  ledgerRevision(environmentId: string, conversationKey: string): number {
    return this.ledger.ledgerRevision(environmentId, conversationKey);
  }

  onLedgerChange(listener: ArtifactLedgerListener): () => void {
    return this.ledger.onLedgerChange(listener);
  }

  // ---------------------------------------------------------------------------
  // Renderer commands

  capabilities(): TranscriptArtifactCapabilities {
    const flags = this.ctx.rollout();
    const status = this.ctx.runtime.runner?.status();
    const origin = this.ctx.runtime.contentServer?.origin() ?? null;
    return {
      backendId: this.backendId(),
      authoring: flags.artifactPublication,
      previewRenderer: status
        ? {
            available: status.available,
            isolation: status.isolation,
            ...(status.reason ? { reason: status.reason } : {}),
            ...(status.interactiveIsolation
              ? { interactiveIsolation: status.interactiveIsolation }
              : {}),
            ...(status.interactiveReason ? { interactiveReason: status.interactiveReason } : {}),
            ...(status.quarantinedWorkers ? { quarantinedWorkers: status.quarantinedWorkers } : {}),
          }
        : {
            available: false,
            isolation: "unavailable",
            reason: "Preview runtime is not installed",
          },
      liveInteractive: flags.liveInteractive && origin !== null,
      ...(flags.liveInteractive && origin === null
        ? {
            liveInteractiveReason:
              this.ctx.runtime.contentServer?.status?.().reason ??
              "The artifact content server is unavailable",
          }
        : {}),
      contentOrigin: origin,
      rolloutFlags: flags,
      ...(this.workerPreparation ? { workerPreparation: this.workerPreparation.status() } : {}),
    };
  }

  getPublication(
    scope: ArtifactConversationScope,
    publicationId: unknown,
  ): Promise<ArtifactPublicationView> {
    return this.ui.getPublication(scope, publicationId);
  }

  listPublications(
    scope: ArtifactConversationScope,
    options: { afterSequence?: unknown; limit?: unknown } = {},
  ): { publications: ArtifactPublicationView[]; nextSequence: number | null } {
    return this.ui.listPublications(scope, options);
  }

  readRepresentation(
    request: ArtifactRepresentationRequest,
  ): Promise<ArtifactRepresentationResponse> {
    return this.ui.readRepresentation(request);
  }

  openLiveSession(
    scope: ArtifactConversationScope,
    publicationId: unknown,
  ): Promise<ArtifactLiveSessionResponse> {
    return this.ui.openLiveSession(scope, publicationId);
  }

  closeLiveSession(generation: unknown): void {
    this.ui.closeLiveSession(generation);
  }

  renderMermaid(request: MermaidRenderRequest): Promise<MermaidRenderResponse> {
    return this.ui.renderMermaid(request);
  }

  /** A conversation's artifacts (published or not), newest first, at most 100. */
  listDrafts(
    scope: ArtifactConversationScope,
    options: { limit?: unknown } = {},
  ): ArtifactDraftListResponse {
    return this.drafts.listDrafts(scope, options);
  }

  /** Exact draft source (bounded slice) or a failed preview's diagnostic capture. */
  readDraft(request: ArtifactDraftReadRequest): Promise<ArtifactRepresentationResponse> {
    return this.drafts.readDraft(request);
  }

  /** Stage a bounded UI upload as an owner-scoped asset reference. */
  stageAsset(request: ArtifactStageAssetRequest): Promise<ArtifactStageAssetResponse> {
    return this.staging.stage(request);
  }

  /**
   * `ArtifactAssetResolver` for staged uploads: bytes of a staged reference
   * the same owner created, or null. Never reads a path or URL.
   */
  resolveStagedAsset(
    owner: ArtifactOwner,
    assetRef: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    return this.staging.resolve(owner, assetRef);
  }

  /** Current state of a run, read separately from any historical snapshot. */
  async workflowLiveSnapshot(input: {
    environmentId: unknown;
    workflowId: unknown;
    runId: unknown;
  }): Promise<WorkflowLiveSnapshotResponse> {
    if (
      typeof input.environmentId !== "string" ||
      typeof input.workflowId !== "string" ||
      typeof input.runId !== "string"
    ) {
      return { status: "unavailable", reason: "not_found", message: "Workflow run not found" };
    }
    const projectId = await this.options
      .environmentProject?.(input.environmentId)
      .catch(() => null);
    if (!projectId)
      return {
        status: "unavailable",
        reason: "deleted",
        message: "The workflow's environment no longer exists",
      };
    try {
      const snapshot = await this.collector.collect(
        { environmentId: input.environmentId, projectId },
        { workflowId: input.workflowId, runId: input.runId },
      );
      return { status: "available", snapshot, terminal: isTerminalWorkflowStatus(snapshot.status) };
    } catch (error) {
      const failure = toArtifactError(error);
      if (failure.code === "not_found")
        return {
          status: "unavailable",
          reason: "deleted",
          message: "The workflow run is no longer available",
        };
      if (failure.code === "invalid_input")
        return { status: "unavailable", reason: "unsupported", message: failure.message };
      return { status: "unavailable", reason: "error", message: failure.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /**
   * Environment deletion: abort in-flight work, revoke grants and live
   * capabilities, then fence and remove every record and file.
   */
  /**
   * Explicit conversation deletion: fence and remove the conversation's
   * records in one transaction, then abort its running previews, revoke its
   * grants and live capabilities. Shared bytes are reclaimed by the collector
   * after its grace period. Never call this from tab close.
   */
  async deleteConversation(
    environmentId: string,
    conversationKey: string,
  ): Promise<{ removed: number }> {
    if (
      typeof environmentId !== "string" ||
      !isArtifactEnvironmentId(environmentId) ||
      typeof conversationKey !== "string" ||
      conversationKey.length === 0 ||
      conversationKey.length > 512 ||
      this.store.isDeleted(environmentId)
    ) {
      return { removed: 0 };
    }
    const deletion = deleteConversationRecords(this.ctx, environmentId, conversationKey);
    this.previews.abortOperations(environmentId, deletion.operationIds);
    this.ui.printing.abort({ environmentId, conversationKey });
    try {
      this.grants.revokeConversation(environmentId, conversationKey);
    } catch {
      logArtifactEvent("grant-revocation-failed", { environmentId });
    }
    this.ui.revokeArtifacts(deletion.artifactIds);
    this.turns.delete(`${environmentId}\0${conversationKey}`);
    this.ctx.announceConversation(environmentId, conversationKey);
    return { removed: deletion.removed };
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    let artifactIds: string[] = [];
    try {
      artifactIds = this.store.records(environmentId).keys("head");
    } catch {
      artifactIds = [];
    }
    this.previews.abortAll(environmentId);
    this.ui.printing.abort({ environmentId });
    this.mediaPdf.abort(environmentId);
    try {
      this.grants.revokeEnvironment(environmentId);
    } catch {
      logArtifactEvent("grant-revocation-failed", { environmentId });
    }
    this.ui.revokeArtifacts(artifactIds);
    for (const key of Array.from(this.turns.keys()))
      if (key.startsWith(`${environmentId}\0`)) this.turns.delete(key);
    await this.store.deleteEnvironment(environmentId);
  }
}
