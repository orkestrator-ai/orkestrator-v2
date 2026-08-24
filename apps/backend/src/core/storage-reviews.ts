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

import { StorageSessions } from "./storage-sessions.ts";

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

export abstract class StorageReviews extends StorageSessions {
  async getLoopedReviewWorkflow(workflowId: string): Promise<PersistedLoopedReviewWorkflow | null> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.loopedReviewsFile(),
      () => ({}),
    );
    const workflow = workflows[workflowId];
    return isPersistedLoopedReviewWorkflow(workflow, workflowId) ? workflow : null;
  }

  async listLoopedReviewWorkflows(environmentId: string): Promise<PersistedLoopedReviewWorkflow[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.loopedReviewsFile(),
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
    const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.loopedReviewsFile(),
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
      if (!(await this.getEnvironment(environmentId))) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      const storedWorkflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(storedWorkflows).filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId),
        ),
      ) as Record<string, PersistedLoopedReviewWorkflow>;
      const previous = workflows[workflowId];
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
      if (controllerFence) {
        const lease = previous?.controllerLease;
        if (
          lease?.ownerId !== controllerFence.ownerId ||
          lease.token !== controllerFence.token ||
          Date.parse(lease.expiresAt) <= Date.now()
        ) {
          throw new Error("Looped review controller lease conflict");
        }
      }
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
        throw new Error("Looped review workflow revision conflict");
      }
      const saved: PersistedLoopedReviewWorkflow = {
        version,
        id: workflowId,
        environmentId,
        snapshot,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
        ...(previous?.controllerLease ? { controllerLease: previous.controllerLease } : {}),
      };
      workflows[workflowId] = saved;
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      this.announce("looped-review", workflowId);
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
    return this.enqueueLoopedReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflow = workflows[workflowId];
      if (!isPersistedLoopedReviewWorkflow(workflow, workflowId)) {
        throw new Error(`Looped review workflow not found: ${workflowId}`);
      }
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
          granted: false,
          token: "",
          expiresAt: workflow.controllerLease.expiresAt,
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
      // paused or failed. Writing here would rewrite the whole looped-review
      // file (and rotate five backups of it) each time, and these snapshots
      // legitimately hold complete diffs and file contents. Only pay for the
      // write once the lease is actually close to expiring.
      if (heldLease && currentExpiry - now >= leaseMs / 2) {
        return { granted: true, token: heldLease.token, expiresAt: heldLease.expiresAt };
      }
      const token = heldLease ? heldLease.token : randomUUID();
      const expiresAt = new Date(now + leaseMs).toISOString();
      workflows[workflowId] = {
        ...workflow,
        controllerLease: { ownerId, token, expiresAt },
      };
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      return { granted: true, token, expiresAt };
    });
  }

  async validateLoopedReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(ownerId) || !isNonBlankString(token)) {
      return false;
    }
    return this.enqueueLoopedReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflow = workflows[workflowId];
      if (!isPersistedLoopedReviewWorkflow(workflow, workflowId)) return false;
      const lease = workflow.controllerLease;
      return (
        lease?.ownerId === ownerId &&
        lease.token === token &&
        Date.parse(lease.expiresAt) > Date.now()
      );
    });
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
      const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflow = workflows[workflowId];
      if (
        !isPersistedLoopedReviewWorkflow(workflow, workflowId) ||
        workflow.controllerLease?.ownerId !== ownerId ||
        workflow.controllerLease.token !== token
      ) {
        return;
      }
      const { controllerLease: _lease, ...released } = workflow;
      workflows[workflowId] = released;
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
    });
  }

  async deleteLoopedReviewWorkflow(workflowId: string): Promise<void> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    await this.enqueueLoopedReviewMutation(async () => {
      const storedWorkflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(storedWorkflows).filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId),
        ),
      ) as Record<string, PersistedLoopedReviewWorkflow>;
      if (!(workflowId in workflows)) return;
      delete workflows[workflowId];
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      this.announce("looped-review", workflowId);
    });
  }

  async deleteLoopedReviewWorkflowsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    await this.enqueueLoopedReviewMutation(async () => {
      const storedWorkflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(storedWorkflows).filter(
          ([storedId, workflow]) =>
            isPersistedLoopedReviewWorkflow(workflow, storedId) &&
            workflow.environmentId !== environmentId,
        ),
      ) as Record<string, PersistedLoopedReviewWorkflow>;
      const removedIds = Object.entries(storedWorkflows)
        .filter(
          ([storedId, workflow]) =>
            isPersistedLoopedReviewWorkflow(workflow, storedId) &&
            workflow.environmentId === environmentId,
        )
        .map(([storedId]) => storedId);
      if (removedIds.length === 0) return;

      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      for (const removedId of removedIds) this.announce("looped-review", removedId);

      // Rotating the primary file creates a backup containing the deleted
      // workflow. Scrub every retained backup before releasing the mutation
      // lock so environment deletion removes all persisted review evidence.
      await this.scrubSensitiveJsonBackups(
        this.loopedReviewsFile(),
        (storedId, workflow) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId) &&
          workflow.environmentId !== environmentId,
      );
    });
  }

  async getMultiReviewWorkflow(workflowId: string): Promise<PersistedMultiReviewWorkflow | null> {
    if (!isNonBlankString(workflowId))
      throw new Error("Multi review workflow ID must not be blank");
    const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
      this.multiReviewsFile(),
      () => ({}),
    );
    const workflow = workflows[workflowId];
    return isPersistedMultiReviewWorkflow(workflow, workflowId) ? workflow : null;
  }

  async listMultiReviewWorkflows(environmentId: string): Promise<PersistedMultiReviewWorkflow[]> {
    if (!isNonBlankString(environmentId))
      throw new Error("Multi review environment ID must not be blank");
    const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
      this.multiReviewsFile(),
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
    const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
      this.multiReviewsFile(),
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
      if (!(await this.getEnvironment(environmentId)))
        throw new Error(`Environment not found: ${environmentId}`);
      const stored = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(stored).filter(([id, value]) => isPersistedMultiReviewWorkflow(value, id)),
      ) as Record<string, PersistedMultiReviewWorkflow>;
      const previous = workflows[workflowId];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Multi review workflow belongs to another environment");
      }
      if (controllerFence) {
        const lease = previous?.controllerLease;
        if (
          lease?.ownerId !== controllerFence.ownerId ||
          lease.token !== controllerFence.token ||
          Date.parse(lease.expiresAt) <= Date.now()
        ) {
          throw new Error("Multi review controller lease conflict");
        }
      }
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
        throw new Error("Multi review workflow revision conflict");
      }
      const saved: PersistedMultiReviewWorkflow = {
        version,
        id: workflowId,
        environmentId,
        snapshot,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
        ...(previous?.controllerLease ? { controllerLease: previous.controllerLease } : {}),
      };
      workflows[workflowId] = saved;
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      this.announce("multi-review", workflowId);
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
      if (!(await this.getEnvironment(environmentId))) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      const stored = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(stored).filter(([id, value]) => isPersistedMultiReviewWorkflow(value, id)),
      ) as Record<string, PersistedMultiReviewWorkflow>;
      if (workflows[workflowId])
        throw new Error(`Multi review workflow already exists: ${workflowId}`);
      const hasActive = Object.values(workflows).some(
        (workflow) =>
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
      workflows[workflowId] = saved;
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      this.announce("multi-review", workflowId);
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
    return this.enqueueMultiReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(),
        () => ({}),
      );
      const workflow = workflows[workflowId];
      if (!isPersistedMultiReviewWorkflow(workflow, workflowId)) {
        throw new Error(`Multi review workflow not found: ${workflowId}`);
      }
      const now = Date.now();
      const expiry = workflow.controllerLease ? Date.parse(workflow.controllerLease.expiresAt) : 0;
      if (
        workflow.controllerLease &&
        workflow.controllerLease.ownerId !== ownerId &&
        expiry > now
      ) {
        return { granted: false, token: "", expiresAt: workflow.controllerLease.expiresAt };
      }
      const held =
        workflow.controllerLease?.ownerId === ownerId && expiry > now
          ? workflow.controllerLease
          : undefined;
      if (held && expiry - now >= leaseMs / 2) {
        return { granted: true, token: held.token, expiresAt: held.expiresAt };
      }
      const token = held?.token ?? randomUUID();
      const expiresAt = new Date(now + leaseMs).toISOString();
      workflows[workflowId] = {
        ...workflow,
        controllerLease: { ownerId, token, expiresAt },
      };
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      return { granted: true, token, expiresAt };
    });
  }

  async validateMultiReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(ownerId) || !isNonBlankString(token))
      return false;
    return this.enqueueMultiReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(),
        () => ({}),
      );
      const workflow = workflows[workflowId];
      if (!isPersistedMultiReviewWorkflow(workflow, workflowId)) return false;
      const lease = workflow.controllerLease;
      return (
        lease?.ownerId === ownerId &&
        lease.token === token &&
        Date.parse(lease.expiresAt) > Date.now()
      );
    });
  }

  async releaseMultiReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<void> {
    await this.enqueueMultiReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(),
        () => ({}),
      );
      const workflow = workflows[workflowId];
      if (
        !isPersistedMultiReviewWorkflow(workflow, workflowId) ||
        workflow.controllerLease?.ownerId !== ownerId ||
        workflow.controllerLease.token !== token
      )
        return;
      const { controllerLease: _lease, ...released } = workflow;
      workflows[workflowId] = released;
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
    });
  }

  async deleteMultiReviewWorkflow(workflowId: string): Promise<void> {
    await this.enqueueMultiReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(),
        () => ({}),
      );
      if (!(workflowId in workflows)) return;
      delete workflows[workflowId];
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      this.announce("multi-review", workflowId);
    });
  }

  async deleteMultiReviewWorkflowsByEnvironment(environmentId: string): Promise<void> {
    await this.enqueueMultiReviewMutation(async () => {
      const stored = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(),
        () => ({}),
      );
      const removed = Object.entries(stored)
        .filter(
          ([id, workflow]) =>
            isPersistedMultiReviewWorkflow(workflow, id) &&
            workflow.environmentId === environmentId,
        )
        .map(([id]) => id);
      if (removed.length === 0) return;
      const workflows = Object.fromEntries(
        Object.entries(stored).filter(
          ([id, workflow]) =>
            isPersistedMultiReviewWorkflow(workflow, id) &&
            workflow.environmentId !== environmentId,
        ),
      );
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      for (const id of removed) this.announce("multi-review", id);
      await this.scrubSensitiveJsonBackups(
        this.multiReviewsFile(),
        (id, workflow) =>
          isPersistedMultiReviewWorkflow(workflow, id) && workflow.environmentId !== environmentId,
      );
    });
  }

  protected async loadAgentInteractionResolutionJournal(): Promise<AgentInteractionResolutionJournal> {
    const stored = await this.loadJson<unknown>(this.agentInteractionJournalFile(), () => ({
      version: AGENT_INTERACTION_JOURNAL_VERSION,
      entries: [],
    }));
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
