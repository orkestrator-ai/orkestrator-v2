import * as shared from "./storage-shared.js";
import {
  AGENT_INTERACTION_JOURNAL_VERSION,
  isAgentInteractionResolutionJournal,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  isNonBlankString,
  isNonNegativeInteger,
  isPersistedLoopedReviewWorkflow,
  isPersistedMultiReviewWorkflow,
  isPositiveInteger,
  isRecord,
  nowIso,
  randomUUID,
} from "./storage-shared.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";
type AgentInteractionOrigin = shared.AgentInteractionOrigin;
type AgentInteractionPolicy = shared.AgentInteractionPolicy;
type AgentInteractionResolutionJournal = shared.AgentInteractionResolutionJournal;
type StoredDesktopConnections = shared.StoredDesktopConnections;
type FeaturePlanningRecord = shared.FeaturePlanningRecord;
type BuildPipelineAgent = shared.BuildPipelineAgent;
type PaneLayoutMergeInput = shared.PaneLayoutMergeInput;
type PaneLayoutSelectionIntent = shared.PaneLayoutSelectionIntent;
type ConditionalResourceSnapshot<T> = shared.ConditionalResourceSnapshot<T>;
type ResourceChange = shared.ResourceChange;
type ResourceKind = shared.ResourceKind;
type ResourceManifestKind = shared.ResourceManifestKind;
type ResourceRevisionManifest = shared.ResourceRevisionManifest;
type ResourceRevisionMap = shared.ResourceRevisionMap;
type ResourceSnapshotRevision = shared.ResourceSnapshotRevision;
type AgentModel = shared.AgentModel;
type AgentActivityState = shared.AgentActivityState;
type AgentActivitySource = shared.AgentActivitySource;
type AgentModelCatalogCache = shared.AgentModelCatalogCache;
type AppConfig = shared.AppConfig;
type ClaudeModelCatalogSnapshot = shared.ClaudeModelCatalogSnapshot;
type ClaudeModelCatalogEntry = shared.ClaudeModelCatalogEntry;
type CodexModelCatalogEntry = shared.CodexModelCatalogEntry;
type CodexReasoningEffort = shared.CodexReasoningEffort;
type Environment = shared.Environment;
type EnvironmentStatus = shared.EnvironmentStatus;
type EnvironmentType = shared.EnvironmentType;
type OpenCodeModelCatalogEntry = shared.OpenCodeModelCatalogEntry;
type OpenCodeModelCatalogSnapshot = shared.OpenCodeModelCatalogSnapshot;
type PortMapping = shared.PortMapping;
type PrState = shared.PrState;
type Project = shared.Project;
type PersistedPaneLayout = shared.PersistedPaneLayout;
type PersistedLoopedReviewWorkflow = shared.PersistedLoopedReviewWorkflow;
type PersistedMultiReviewWorkflow = shared.PersistedMultiReviewWorkflow;
type PersistedBuildPipeline = shared.PersistedBuildPipeline;
type PersistedNativeAgentSession = shared.PersistedNativeAgentSession;
type PersistedNativeAgentPendingDispatch = shared.PersistedNativeAgentPendingDispatch;
type PersistedComposeDraft = shared.PersistedComposeDraft;
type PersistedFileDraft = shared.PersistedFileDraft;
type PersistedPromptQueue = shared.PersistedPromptQueue;
type PersistedAgentHandoff = shared.PersistedAgentHandoff;
type RepositoryConfig = shared.RepositoryConfig;
type Session = shared.Session;
type SessionType = shared.SessionType;
type JsonRecord = shared.JsonRecord;
type KanbanComment = shared.KanbanComment;
type KanbanImage = shared.KanbanImage;
type KanbanStatus = shared.KanbanStatus;
type MutablePaneLayoutLeaf = shared.MutablePaneLayoutLeaf;
type KanbanTask = shared.KanbanTask;
type ProjectNotes = shared.ProjectNotes;
type FeaturePlanStatus = shared.FeaturePlanStatus;
type FeaturePlanMessage = shared.FeaturePlanMessage;
type FeatureStoryCard = shared.FeatureStoryCard;
type FeaturePlan = shared.FeaturePlan;
type LinearAuth = shared.LinearAuth;
type LinearCompletionComment = shared.LinearCompletionComment;
type GitHubCompletionComment = shared.GitHubCompletionComment;
type LoadedNativeAgentSessions = shared.LoadedNativeAgentSessions;
type PersistedOpenCodeModelCatalogStore = shared.PersistedOpenCodeModelCatalogStore;
type ResourceChangeListener = shared.ResourceChangeListener;

type ControllerClaim = { granted: boolean; token: string; expiresAt: string };

export type StorageLayerTypes = [
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolutionJournal,
  StoredDesktopConnections,
  FeaturePlanningRecord,
  BuildPipelineAgent,
  PaneLayoutMergeInput,
  PaneLayoutSelectionIntent,
  ConditionalResourceSnapshot<unknown>,
  ResourceChange,
  ResourceKind,
  ResourceManifestKind,
  ResourceRevisionManifest,
  ResourceRevisionMap,
  ResourceSnapshotRevision,
  AgentModel,
  AgentActivityState,
  AgentActivitySource,
  AgentModelCatalogCache,
  AppConfig,
  ClaudeModelCatalogSnapshot,
  ClaudeModelCatalogEntry,
  CodexModelCatalogEntry,
  CodexReasoningEffort,
  Environment,
  EnvironmentStatus,
  EnvironmentType,
  OpenCodeModelCatalogEntry,
  OpenCodeModelCatalogSnapshot,
  PortMapping,
  PrState,
  Project,
  PersistedPaneLayout,
  PersistedLoopedReviewWorkflow,
  PersistedMultiReviewWorkflow,
  PersistedBuildPipeline,
  PersistedNativeAgentSession,
  PersistedNativeAgentPendingDispatch,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedPromptQueue,
  PersistedAgentHandoff,
  RepositoryConfig,
  Session,
  SessionType,
  JsonRecord,
  KanbanComment,
  KanbanImage,
  KanbanStatus,
  MutablePaneLayoutLeaf,
  KanbanTask,
  ProjectNotes,
  FeaturePlanStatus,
  FeaturePlanMessage,
  FeatureStoryCard,
  FeaturePlan,
  LinearAuth,
  LinearCompletionComment,
  GitHubCompletionComment,
  LoadedNativeAgentSessions,
  PersistedOpenCodeModelCatalogStore,
  ResourceChangeListener,
];

/** Whether `lease` is held by `ownerId` under `token` and has not expired. */
function holdsControllerLease(
  lease: { ownerId: string; token?: string; expiresAt: string } | undefined,
  ownerId: string,
  token: string,
): boolean {
  return (
    lease?.ownerId === ownerId && lease.token === token && Date.parse(lease.expiresAt) > Date.now()
  );
}

/**
 * Looped and Multi Review workflows each live in a `record` store, one row per
 * workflow, and every access here touches only the rows it names. A fence
 * check runs around nearly every provider call a supervisor makes, so it must
 * cost one row however much review history the store retains.
 *
 * Writers still serialize on each store's mutation lease: a save awaits its
 * environment check, and the active-workflow check and environment sweeps
 * scan every row. Each write commits only its own row (`updateStoreRow`), so
 * no other workflow is re-serialized. Reads and fence checks take no lease
 * (see {@link ReviewsRepository.validateMultiReviewController}).
 */
export class ReviewsRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  private enqueueLoopedReviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(
      this.files.loopedReviewsFile(),
      "looped review workflow storage",
      operation,
    );
  }

  private enqueueMultiReviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(
      this.files.multiReviewsFile(),
      "multi review workflow storage",
      operation,
    );
  }

  /** One committed workflow; `null` when absent, unreadable or invalid. */
  private loadLoopedReviewWorkflow(workflowId: string): PersistedLoopedReviewWorkflow | null {
    const stored = this.context.loadStoreRow(this.files.loopedReviewsFile(), workflowId);
    return isPersistedLoopedReviewWorkflow(stored, workflowId) ? stored : null;
  }

  /** One committed workflow; `null` when absent, unreadable or invalid. */
  private loadMultiReviewWorkflow(workflowId: string): PersistedMultiReviewWorkflow | null {
    const stored = this.context.loadStoreRow(this.files.multiReviewsFile(), workflowId);
    return isPersistedMultiReviewWorkflow(stored, workflowId) ? stored : null;
  }

  async getLoopedReviewWorkflow(workflowId: string): Promise<PersistedLoopedReviewWorkflow | null> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    return this.loadLoopedReviewWorkflow(workflowId);
  }

  async listLoopedReviewWorkflows(environmentId: string): Promise<PersistedLoopedReviewWorkflow[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    const workflows = await this.context.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.files.loopedReviewsFile(),
      () => ({}),
    );
    return Object.entries(workflows)
      .filter(
        ([workflowId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, workflowId) &&
          workflow.environmentId === environmentId,
      )
      .map(([, workflow]) => workflow)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  /** Backend supervisors must restore work even when no renderer is mounted. */
  async listAllLoopedReviewWorkflows(): Promise<PersistedLoopedReviewWorkflow[]> {
    const workflows = await this.context.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.files.loopedReviewsFile(),
      () => ({}),
    );
    return Object.entries(workflows)
      .filter(([workflowId, workflow]) => isPersistedLoopedReviewWorkflow(workflow, workflowId))
      .map(([, workflow]) => workflow)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async saveLoopedReviewWorkflow(
    workflowId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
    controllerFence?: { ownerId: string; token: string },
    options?: {
      /**
       * Rejects the write when the *stored* record has already reached this
       * version. Evaluated inside the mutation queue so it cannot be overtaken
       * by a concurrent backend adoption between the caller's read and its
       * write, which a caller-side check inevitably can be.
       */
      rejectStoredVersionAtLeast?: number;
    },
  ): Promise<PersistedLoopedReviewWorkflow> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Looped review workflow version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Looped review snapshot must be a JSON object");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Looped review expected revision must be a non-negative integer");
    }
    if (
      controllerFence !== undefined &&
      (!isNonBlankString(controllerFence.ownerId) || !isNonBlankString(controllerFence.token))
    ) {
      throw new Error("Looped review controller fence is invalid");
    }
    let serializedSnapshot: string | undefined;
    try {
      serializedSnapshot = JSON.stringify(snapshot);
    } catch {
      throw new Error("Looped review snapshot must be JSON serializable");
    }
    if (serializedSnapshot === undefined) {
      throw new Error("Looped review snapshot must be JSON serializable");
    }
    // Review packages intentionally retain complete diffs and changed-file
    // contents. Reject over-sized snapshots explicitly; never truncate them.
    if (Buffer.byteLength(serializedSnapshot, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Looped review snapshot exceeds the 32 MB limit");
    }

    return this.enqueueLoopedReviewMutation(async () => {
      if (!(await this.repos.projects.getEnvironment(environmentId))) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      // The checks run inside the row's own transaction, against the record
      // being replaced; an invalid stored record reads as absent.
      const saved = this.context.updateStoreRow<PersistedLoopedReviewWorkflow>(
        this.files.loopedReviewsFile(),
        workflowId,
        (current) => {
          const previous = isPersistedLoopedReviewWorkflow(current, workflowId)
            ? current
            : undefined;
          if (previous && previous.environmentId !== environmentId) {
            throw new Error("Looped review workflow belongs to another environment");
          }
          if (
            options?.rejectStoredVersionAtLeast !== undefined &&
            (previous?.version ?? 0) >= options.rejectStoredVersionAtLeast
          ) {
            throw new Error(
              "Backend-owned looped reviews can only be changed through workflow commands",
            );
          }
          if (
            controllerFence &&
            !holdsControllerLease(
              previous?.controllerLease,
              controllerFence.ownerId,
              controllerFence.token,
            )
          ) {
            throw new Error("Looped review controller lease conflict");
          }
          if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
            throw new Error("Looped review workflow revision conflict");
          }
          const next: PersistedLoopedReviewWorkflow = {
            version,
            id: workflowId,
            environmentId,
            snapshot,
            updatedAt: nowIso(),
            revision: (previous?.revision ?? 0) + 1,
            ...(previous?.controllerLease ? { controllerLease: previous.controllerLease } : {}),
          };
          return { result: next, value: next };
        },
      );
      this.context.changes.announce("looped-review", workflowId);
      return saved;
    });
  }

  async claimLoopedReviewController(
    workflowId: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<{ granted: boolean; token: string; expiresAt: string }> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(ownerId)) {
      throw new Error("Looped review controller identity must not be blank");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 2_000 || leaseMs > 60_000) {
      throw new Error("Looped review controller lease is invalid");
    }
    return this.enqueueLoopedReviewMutation(async () =>
      this.context.updateStoreRow<ControllerClaim>(
        this.files.loopedReviewsFile(),
        workflowId,
        (current) => {
          if (!isPersistedLoopedReviewWorkflow(current, workflowId)) {
            throw new Error(`Looped review workflow not found: ${workflowId}`);
          }
          const workflow = current;
          const now = Date.now();
          const currentExpiry = workflow.controllerLease
            ? Date.parse(workflow.controllerLease.expiresAt)
            : 0;
          if (
            workflow.controllerLease &&
            workflow.controllerLease.ownerId !== ownerId &&
            currentExpiry > now
          ) {
            return {
              result: { granted: false, token: "", expiresAt: workflow.controllerLease.expiresAt },
            };
          }
          const heldLease =
            workflow.controllerLease?.ownerId === ownerId &&
            currentExpiry > now &&
            isNonBlankString(workflow.controllerLease.token)
              ? workflow.controllerLease
              : null;
          // Re-granting an unexpired lease to its own holder is the overwhelmingly
          // common path: every advance claims before it reads, and the poll runs
          // once a second for every non-terminal workflow — including ones merely
          // paused or failed. A write here would rewrite this workflow's row, whose
          // snapshot legitimately holds complete diffs and file contents, and move
          // the store revision clients watch. Only pay for the write once the
          // lease is actually close to expiring.
          if (heldLease && currentExpiry - now >= leaseMs / 2) {
            return {
              result: { granted: true, token: heldLease.token, expiresAt: heldLease.expiresAt },
            };
          }
          const token = heldLease ? heldLease.token : randomUUID();
          const expiresAt = new Date(now + leaseMs).toISOString();
          return {
            result: { granted: true, token, expiresAt },
            value: { ...workflow, controllerLease: { ownerId, token, expiresAt } },
          };
        },
      ),
    );
  }

  /**
   * Whether `ownerId` still holds the controller lease under `token`. Reads
   * one row and takes no lease, like
   * {@link ReviewsRepository.validateMultiReviewController}.
   */
  async validateLoopedReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(ownerId) || !isNonBlankString(token)) {
      return false;
    }
    const workflow = this.loadLoopedReviewWorkflow(workflowId);
    return holdsControllerLease(workflow?.controllerLease, ownerId, token);
  }

  async releaseLoopedReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<void> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(ownerId) || !isNonBlankString(token)) {
      return;
    }
    await this.enqueueLoopedReviewMutation(async () => {
      this.context.updateStoreRow(this.files.loopedReviewsFile(), workflowId, (current) => {
        if (
          !isPersistedLoopedReviewWorkflow(current, workflowId) ||
          current.controllerLease?.ownerId !== ownerId ||
          current.controllerLease.token !== token
        ) {
          return { result: undefined };
        }
        const { controllerLease: _lease, ...released } = current;
        return { result: undefined, value: released };
      });
    });
  }

  async deleteLoopedReviewWorkflow(workflowId: string): Promise<void> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    await this.enqueueLoopedReviewMutation(async () => {
      const deleted = this.context.updateStoreRow(
        this.files.loopedReviewsFile(),
        workflowId,
        (current) =>
          isPersistedLoopedReviewWorkflow(current, workflowId)
            ? { result: true, delete: true }
            : { result: false },
      );
      if (deleted)
        this.context.changes.announce("looped-review", workflowId, undefined, undefined, true);
      // A previous attempt may have committed the delete before its scrub failed.
      await this.context.scrubSensitiveJsonBackups(
        this.files.loopedReviewsFile(),
        (storedId) => storedId !== workflowId,
      );
    });
  }

  async deleteLoopedReviewWorkflowsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    await this.enqueueLoopedReviewMutation(async () => {
      const storedWorkflows = await this.context.loadJson<Record<string, unknown>>(
        this.files.loopedReviewsFile(),
        () => ({}),
      );
      // Attributed by the stored environment field alone, so a record this
      // build cannot otherwise read still leaves with its environment.
      const removedIds = Object.entries(storedWorkflows)
        .filter(([, workflow]) => isRecord(workflow) && workflow.environmentId === environmentId)
        .map(([storedId]) => storedId);
      if (removedIds.length === 0) return;
      for (const removedId of removedIds) {
        this.context.updateStoreRow(this.files.loopedReviewsFile(), removedId, () => ({
          result: undefined,
          delete: true,
        }));
        this.context.changes.announce("looped-review", removedId, undefined, undefined, true);
      }

      // Scrub the retired JSON archive, and the WAL and free pages, before
      // releasing the mutation lease so environment deletion removes all
      // persisted review evidence.
      await this.context.scrubSensitiveJsonBackups(
        this.files.loopedReviewsFile(),
        (storedId, workflow) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId) &&
          workflow.environmentId !== environmentId,
      );
    });
  }

  async getMultiReviewWorkflow(workflowId: string): Promise<PersistedMultiReviewWorkflow | null> {
    if (!isNonBlankString(workflowId))
      throw new Error("Multi review workflow ID must not be blank");
    return this.loadMultiReviewWorkflow(workflowId);
  }

  async listMultiReviewWorkflows(environmentId: string): Promise<PersistedMultiReviewWorkflow[]> {
    if (!isNonBlankString(environmentId))
      throw new Error("Multi review environment ID must not be blank");
    const workflows = await this.context.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
      this.files.multiReviewsFile(),
      () => ({}),
    );
    return Object.entries(workflows)
      .filter(
        ([id, workflow]) =>
          isPersistedMultiReviewWorkflow(workflow, id) && workflow.environmentId === environmentId,
      )
      .map(([, workflow]) => workflow)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async listAllMultiReviewWorkflows(): Promise<PersistedMultiReviewWorkflow[]> {
    const workflows = await this.context.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
      this.files.multiReviewsFile(),
      () => ({}),
    );
    return Object.entries(workflows)
      .filter(([id, workflow]) => isPersistedMultiReviewWorkflow(workflow, id))
      .map(([, workflow]) => workflow)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async saveMultiReviewWorkflow(
    workflowId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
    controllerFence?: { ownerId: string; token: string },
  ): Promise<PersistedMultiReviewWorkflow> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(environmentId)) {
      throw new Error("Multi review workflow identity must not be blank");
    }
    if (!isPositiveInteger(version) || !isRecord(snapshot)) {
      throw new Error("Multi review workflow is invalid");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Multi review expected revision must be a non-negative integer");
    }
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Multi review snapshot exceeds the 32 MB limit");
    }
    return this.enqueueMultiReviewMutation(async () => {
      if (!(await this.repos.projects.getEnvironment(environmentId)))
        throw new Error(`Environment not found: ${environmentId}`);
      // The fence and revision are checked inside the row's own transaction,
      // against the record being replaced. This is the authoritative fence: a
      // controller that lost its lease can never commit, whatever its last
      // fence check answered.
      const saved = this.context.updateStoreRow<PersistedMultiReviewWorkflow>(
        this.files.multiReviewsFile(),
        workflowId,
        (current) => {
          const previous = isPersistedMultiReviewWorkflow(current, workflowId)
            ? current
            : undefined;
          if (previous && previous.environmentId !== environmentId) {
            throw new Error("Multi review workflow belongs to another environment");
          }
          if (
            controllerFence &&
            !holdsControllerLease(
              previous?.controllerLease,
              controllerFence.ownerId,
              controllerFence.token,
            )
          ) {
            throw new Error("Multi review controller lease conflict");
          }
          if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
            throw new Error("Multi review workflow revision conflict");
          }
          const next: PersistedMultiReviewWorkflow = {
            version,
            id: workflowId,
            environmentId,
            snapshot,
            updatedAt: nowIso(),
            revision: (previous?.revision ?? 0) + 1,
            ...(previous?.controllerLease ? { controllerLease: previous.controllerLease } : {}),
          };
          return { result: next, value: next };
        },
      );
      this.context.changes.announce("multi-review", workflowId);
      return saved;
    });
  }

  /**
   * Creates the sole active Multi Review for an environment in the same
   * cross-process critical section that writes the record. A separate
   * list-then-save sequence would let two renderer clients launch competing
   * fix workflows against the same worktree.
   */
  async createMultiReviewWorkflowIfNoActive(
    workflowId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
  ): Promise<PersistedMultiReviewWorkflow | null> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(environmentId)) {
      throw new Error("Multi review workflow identity must not be blank");
    }
    if (!isPositiveInteger(version) || !isRecord(snapshot)) {
      throw new Error("Multi review workflow is invalid");
    }
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Multi review snapshot exceeds the 32 MB limit");
    }
    return this.enqueueMultiReviewMutation(async () => {
      if (!(await this.repos.projects.getEnvironment(environmentId))) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      // Launch is the one Multi Review path that must see every workflow; the
      // lease keeps the scan and the insert one critical section.
      const stored = await this.context.loadJson<Record<string, unknown>>(
        this.files.multiReviewsFile(),
        () => ({}),
      );
      if (isPersistedMultiReviewWorkflow(stored[workflowId], workflowId))
        throw new Error(`Multi review workflow already exists: ${workflowId}`);
      const hasActive = Object.entries(stored).some(
        ([id, workflow]) =>
          isPersistedMultiReviewWorkflow(workflow, id) &&
          workflow.environmentId === environmentId &&
          isMultiReviewWorkflow(workflow.snapshot) &&
          !isMultiReviewTerminalPhase(workflow.snapshot.phase),
      );
      if (hasActive) return null;
      const saved: PersistedMultiReviewWorkflow = {
        version,
        id: workflowId,
        environmentId,
        snapshot,
        updatedAt: nowIso(),
        revision: 1,
      };
      this.context.updateStoreRow(this.files.multiReviewsFile(), workflowId, () => ({
        result: undefined,
        value: saved,
      }));
      this.context.changes.announce("multi-review", workflowId);
      return saved;
    });
  }

  async claimMultiReviewController(
    workflowId: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<{ granted: boolean; token: string; expiresAt: string }> {
    if (
      !isNonBlankString(workflowId) ||
      !isNonBlankString(ownerId) ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 2_000 ||
      leaseMs > 60_000
    ) {
      throw new Error("Multi review controller lease is invalid");
    }
    return this.enqueueMultiReviewMutation(async () =>
      this.context.updateStoreRow<ControllerClaim>(
        this.files.multiReviewsFile(),
        workflowId,
        (current) => {
          if (!isPersistedMultiReviewWorkflow(current, workflowId)) {
            throw new Error(`Multi review workflow not found: ${workflowId}`);
          }
          const lease = current.controllerLease;
          const now = Date.now();
          const expiry = lease ? Date.parse(lease.expiresAt) : 0;
          if (lease && lease.ownerId !== ownerId && expiry > now) {
            return { result: { granted: false, token: "", expiresAt: lease.expiresAt } };
          }
          const held = lease?.ownerId === ownerId && expiry > now ? lease : undefined;
          // A held lease is only rewritten once half of it has run: a lease-only
          // write changes no workflow content but still moves the store revision
          // that clients watch.
          if (held && expiry - now >= leaseMs / 2) {
            return { result: { granted: true, token: held.token, expiresAt: held.expiresAt } };
          }
          const token = held?.token ?? randomUUID();
          const expiresAt = new Date(now + leaseMs).toISOString();
          return {
            result: { granted: true, token, expiresAt },
            value: { ...current, controllerLease: { ownerId, token, expiresAt } },
          };
        },
      ),
    );
  }

  /**
   * Whether `ownerId` still holds the controller lease under `token`: the
   * fence check a supervisor runs around nearly every provider call.
   *
   * It reads one committed row and takes no mutation lease. The answer is
   * only ever true at the instant of the read: a lease held for the read was
   * released before the caller acted on it, so it protected nothing, yet it
   * made every check two SQLite write transactions queued behind every other
   * Multi Review mutation. Authority stays with the commit, which re-checks
   * the fence and revision inside its own transaction
   * ({@link ReviewsRepository.saveMultiReviewWorkflow}). A SQLite read sees only
   * committed state, and another controller can take over only an expired
   * lease, which this check already rejects, so racing a takeover answers as
   * a serialized read would. A check no longer waits behind this process's
   * queued renewal either; that only matters after a stall longer than half
   * the lease, and then it fails closed.
   */
  async validateMultiReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(ownerId) || !isNonBlankString(token))
      return false;
    const workflow = this.loadMultiReviewWorkflow(workflowId);
    return holdsControllerLease(workflow?.controllerLease, ownerId, token);
  }

  async releaseMultiReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<void> {
    await this.enqueueMultiReviewMutation(async () => {
      this.context.updateStoreRow(this.files.multiReviewsFile(), workflowId, (current) => {
        if (
          !isPersistedMultiReviewWorkflow(current, workflowId) ||
          current.controllerLease?.ownerId !== ownerId ||
          current.controllerLease.token !== token
        ) {
          return { result: undefined };
        }
        const { controllerLease: _lease, ...released } = current;
        return { result: undefined, value: released };
      });
    });
  }

  async deleteMultiReviewWorkflow(workflowId: string): Promise<void> {
    await this.enqueueMultiReviewMutation(async () => {
      const deleted = this.context.updateStoreRow(
        this.files.multiReviewsFile(),
        workflowId,
        (current) => (current === undefined ? { result: false } : { result: true, delete: true }),
      );
      if (deleted)
        this.context.changes.announce("multi-review", workflowId, undefined, undefined, true);
      // A previous attempt may have committed the delete before its scrub failed.
      await this.context.scrubSensitiveJsonBackups(
        this.files.multiReviewsFile(),
        (storedId) => storedId !== workflowId,
      );
    });
  }

  async deleteMultiReviewWorkflowsByEnvironment(environmentId: string): Promise<void> {
    await this.enqueueMultiReviewMutation(async () => {
      const stored = await this.context.loadJson<Record<string, unknown>>(
        this.files.multiReviewsFile(),
        () => ({}),
      );
      // Attributed by the stored environment field alone, so a record this
      // build cannot otherwise read still leaves with its environment.
      const removed = Object.entries(stored)
        .filter(([, workflow]) => isRecord(workflow) && workflow.environmentId === environmentId)
        .map(([id]) => id);
      if (removed.length === 0) return;
      for (const id of removed) {
        this.context.updateStoreRow(this.files.multiReviewsFile(), id, () => ({
          result: undefined,
          delete: true,
        }));
        this.context.changes.announce("multi-review", id, undefined, undefined, true);
      }
      await this.context.scrubSensitiveJsonBackups(
        this.files.multiReviewsFile(),
        (id, workflow) =>
          isPersistedMultiReviewWorkflow(workflow, id) && workflow.environmentId !== environmentId,
      );
    });
  }

  async loadAgentInteractionResolutionJournal(): Promise<AgentInteractionResolutionJournal> {
    const stored = await this.context.loadJson<unknown>(
      this.files.agentInteractionJournalFile(),
      () => ({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [],
      }),
    );
    if (!isAgentInteractionResolutionJournal(stored)) {
      throw new Error("Stored agent interaction resolution journal is invalid");
    }
    return stored;
  }

  /**
   * Reads under the same lock the writers take. Cleanup is not idempotent
   * against a concurrent update — it reclaims claims by wall-clock age — so an
   * unsynchronized read could return a journal that disagrees with the one an
   * in-flight update is about to persist.
   */
}
