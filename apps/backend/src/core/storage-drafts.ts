import {
  coordinatorIdFromRuntimeId,
  coordinatorConversationIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";
import * as shared from "./storage-shared.js";
import {
  exists,
  fs,
  isNonBlankString,
  isNonNegativeInteger,
  isPersistedAgentHandoff,
  isPersistedComposeDraft,
  isPersistedFileDraft,
  isPositiveInteger,
  isRecord,
  nowIso,
  paneLayoutRevisionConflictMessage,
  path,
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

import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";

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

export class DraftsRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  async getComposeDraft(draftKey: string): Promise<PersistedComposeDraft | null> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    const stored = this.context.loadStoreRow(this.files.composeDraftsFile(), draftKey);
    return isPersistedComposeDraft(stored, draftKey) ? stored : null;
  }

  async listComposeDrafts(
    ownerType: "environment" | "project",
    ownerId: string,
  ): Promise<PersistedComposeDraft[]> {
    if (ownerType !== "environment" && ownerType !== "project") {
      throw new Error("Compose draft owner type is invalid");
    }
    if (!isNonBlankString(ownerId)) {
      throw new Error("Compose draft owner ID must not be blank");
    }
    return Object.values(await this.repos.prompts.loadComposeDrafts()).filter(
      (draft) => draft.ownerType === ownerType && draft.ownerId === ownerId,
    );
  }

  async saveComposeDraft(
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
    value: unknown,
    expectedRevision?: number,
  ): Promise<PersistedComposeDraft> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    if (ownerType !== "environment" && ownerType !== "project") {
      throw new Error("Compose draft owner type is invalid");
    }
    if (!isNonBlankString(ownerId)) {
      throw new Error("Compose draft owner ID must not be blank");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Compose draft expected revision must be a non-negative integer");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error("Compose draft value must be JSON serializable");
    }
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Compose draft exceeds the 32 MB limit");
    }

    return this.repos.prompts.enqueueComposeDraftMutation(async () => {
      if (ownerType === "environment") {
        await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
          ownerId,
          "Compose draft",
        );
        const coordinatorId = coordinatorIdFromRuntimeId(ownerId);
        const conversationId = coordinatorConversationIdFromRuntimeId(ownerId);
        if (coordinatorId && conversationId) {
          const workspace =
            await this.repos.coordinators.getCoordinatorWorkspaceById(coordinatorId);
          const conversation = workspace?.conversations.find((item) => item.id === conversationId);
          if (!conversation || conversation.closedAt)
            throw new Error("Compose draft conversation is closed");
        }
      } else if (!(await this.repos.projects.getProject(ownerId))) {
        throw new Error(`Compose draft project not found: ${ownerId}`);
      }
      const drafts = await this.repos.prompts.loadComposeDrafts();
      const previous = drafts[draftKey];
      if (previous && (previous.ownerType !== ownerType || previous.ownerId !== ownerId)) {
        throw new Error("Compose draft belongs to another owner");
      }
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
        throw new Error("Compose draft revision conflict");
      }
      const saved: PersistedComposeDraft = {
        draftKey,
        ownerType,
        ownerId,
        value,
        ...(previous?.sourcePromptQueue ? { sourcePromptQueue: previous.sourcePromptQueue } : {}),
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      drafts[draftKey] = saved;
      await this.context.saveSensitiveJson(this.files.composeDraftsFile(), drafts);
      this.context.changes.announce("compose-draft", ownerId);
      return saved;
    });
  }

  async deleteComposeDraft(draftKey: string, expectedRevision?: number): Promise<void> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Compose draft expected revision must be a non-negative integer");
    }
    await this.repos.prompts.enqueueComposeDraftMutation(async () => {
      const stored = await this.context.loadJson<unknown>(
        this.files.composeDraftsFile(),
        () => ({}),
      );
      const drafts = this.repos.prompts.validComposeDrafts(stored);
      const previous = drafts[draftKey];
      if (previous && expectedRevision !== undefined && previous.revision !== expectedRevision) {
        throw new Error("Compose draft revision conflict");
      }
      const hasStoredKey = isRecord(stored) && Object.hasOwn(stored, draftKey);
      if (hasStoredKey) {
        delete drafts[draftKey];
        await this.context.saveSensitiveJson(this.files.composeDraftsFile(), drafts);
      }
      if (previous) {
        this.context.changes.announce("compose-draft", previous.ownerId);
      }
      // Always scrub backups, including when the primary no longer contains
      // the key. A prior interrupted delete may have committed the primary
      // write without sanitizing the retained copies.
      await this.context.scrubSensitiveJsonBackups(
        this.files.composeDraftsFile(),
        (storedKey, draft) => storedKey !== draftKey && isPersistedComposeDraft(draft, storedKey),
      );
    });
  }

  async deleteComposeDraftsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Compose draft environment ID must not be blank");
    }
    await this.repos.prompts.enqueueComposeDraftMutation(async () => {
      const drafts = await this.repos.prompts.loadComposeDrafts();
      const keys = Object.values(drafts)
        .filter((draft) => draft.ownerType === "environment" && draft.ownerId === environmentId)
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.context.saveSensitiveJson(this.files.composeDraftsFile(), drafts);
        this.context.changes.announce("compose-draft", environmentId);
      }
      await this.context.scrubSensitiveJsonBackups(
        this.files.composeDraftsFile(),
        (storedKey, draft) =>
          isPersistedComposeDraft(draft, storedKey) &&
          (draft.ownerType !== "environment" || draft.ownerId !== environmentId),
      );
    });
  }

  async deleteComposeDraftsByProject(projectId: string): Promise<void> {
    if (!isNonBlankString(projectId)) {
      throw new Error("Compose draft project ID must not be blank");
    }
    await this.repos.prompts.enqueueComposeDraftMutation(async () => {
      const drafts = await this.repos.prompts.loadComposeDrafts();
      const keys = Object.values(drafts)
        .filter((draft) => draft.ownerType === "project" && draft.ownerId === projectId)
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.context.saveSensitiveJson(this.files.composeDraftsFile(), drafts);
        this.context.changes.announce("compose-draft", projectId);
      }
      await this.context.scrubSensitiveJsonBackups(
        this.files.composeDraftsFile(),
        (storedKey, draft) =>
          isPersistedComposeDraft(draft, storedKey) &&
          (draft.ownerType !== "project" || draft.ownerId !== projectId),
      );
    });
  }

  private enqueueFileDraftMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.fileDraftsFile(), "file draft storage", operation);
  }

  private validFileDrafts(stored: unknown): Record<string, PersistedFileDraft> {
    if (!isRecord(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, draft]) => isPersistedFileDraft(draft, storedKey)),
    ) as Record<string, PersistedFileDraft>;
  }

  private async loadFileDrafts(): Promise<Record<string, PersistedFileDraft>> {
    const stored = await this.context.loadJson<unknown>(this.files.fileDraftsFile(), () => ({}));
    return this.validFileDrafts(stored);
  }

  async getFileDraft(draftKey: string): Promise<PersistedFileDraft | null> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    return (await this.loadFileDrafts())[draftKey] ?? null;
  }

  async saveFileDraft(
    draftKey: string,
    environmentId: string,
    filePath: string,
    content: string,
    originalContent: string,
    expectedRevision?: number,
  ): Promise<PersistedFileDraft> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    if (!isNonBlankString(environmentId)) {
      throw new Error("File draft environment ID must not be blank");
    }
    if (!isNonBlankString(filePath)) throw new Error("File draft path must not be blank");
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("File draft expected revision must be a non-negative integer");
    }
    const size = Buffer.byteLength(content, "utf8") + Buffer.byteLength(originalContent, "utf8");
    if (size > 32 * 1024 * 1024) throw new Error("File draft exceeds the 32 MB limit");

    return this.enqueueFileDraftMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "File draft",
      );
      const drafts = await this.loadFileDrafts();
      const previous = drafts[draftKey];
      if (
        previous &&
        (previous.environmentId !== environmentId || previous.filePath !== filePath)
      ) {
        throw new Error("File draft key belongs to another file");
      }
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
        throw new Error("File draft revision conflict");
      }
      const saved: PersistedFileDraft = {
        draftKey,
        environmentId,
        filePath,
        content,
        originalContent,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      drafts[draftKey] = saved;
      await this.context.saveSensitiveJson(this.files.fileDraftsFile(), drafts);
      this.context.changes.announce("file-draft", environmentId);
      return saved;
    });
  }

  async deleteFileDraft(draftKey: string, expectedRevision?: number): Promise<void> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("File draft expected revision must be a non-negative integer");
    }
    await this.enqueueFileDraftMutation(async () => {
      const stored = await this.context.loadJson<unknown>(this.files.fileDraftsFile(), () => ({}));
      const drafts = this.validFileDrafts(stored);
      const previous = drafts[draftKey];
      if (previous && expectedRevision !== undefined && previous.revision !== expectedRevision) {
        throw new Error("File draft revision conflict");
      }
      const hasStoredKey = isRecord(stored) && Object.hasOwn(stored, draftKey);
      if (hasStoredKey) {
        delete drafts[draftKey];
        await this.context.saveSensitiveJson(this.files.fileDraftsFile(), drafts);
      }
      if (previous) {
        this.context.changes.announce("file-draft", previous.environmentId);
      }
      await this.context.scrubSensitiveJsonBackups(
        this.files.fileDraftsFile(),
        (storedKey, draft) => storedKey !== draftKey && isPersistedFileDraft(draft, storedKey),
      );
    });
  }

  async deleteFileDraftsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("File draft environment ID must not be blank");
    }
    await this.enqueueFileDraftMutation(async () => {
      const drafts = await this.loadFileDrafts();
      const keys = Object.values(drafts)
        .filter((draft) => draft.environmentId === environmentId)
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.context.saveSensitiveJson(this.files.fileDraftsFile(), drafts);
        this.context.changes.announce("file-draft", environmentId);
      }
      await this.context.scrubSensitiveJsonBackups(
        this.files.fileDraftsFile(),
        (storedKey, draft) =>
          isPersistedFileDraft(draft, storedKey) && draft.environmentId !== environmentId,
      );
    });
  }

  private enqueueAgentHandoffMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(
      this.files.agentHandoffsFile(),
      "agent handoff storage",
      operation,
    );
  }

  private async loadAgentHandoffEntries(): Promise<Record<string, unknown>> {
    const stored = await this.context.loadJson<unknown>(this.files.agentHandoffsFile(), () => ({}));
    return isRecord(stored) ? stored : {};
  }

  private async loadAgentHandoffs(): Promise<Record<string, PersistedAgentHandoff>> {
    const stored = await this.loadAgentHandoffEntries();
    return Object.fromEntries(
      Object.entries(stored).filter(([storedId, handoff]) =>
        isPersistedAgentHandoff(handoff, storedId),
      ),
    ) as Record<string, PersistedAgentHandoff>;
  }

  async getAgentHandoff(handoffId: string): Promise<PersistedAgentHandoff | null> {
    if (!isNonBlankString(handoffId)) {
      throw new Error("Agent handoff ID must not be blank");
    }
    return (await this.loadAgentHandoffs())[handoffId] ?? null;
  }

  async saveAgentHandoff(
    handoffId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
  ): Promise<PersistedAgentHandoff> {
    if (!isNonBlankString(handoffId)) {
      throw new Error("Agent handoff ID must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Agent handoff version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Agent handoff snapshot must be an object");
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      throw new Error("Agent handoff snapshot must be JSON serializable");
    }
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Agent handoff exceeds the 32 MB limit");
    }

    return this.enqueueAgentHandoffMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "Agent handoff",
      );
      const handoffs = await this.loadAgentHandoffs();
      const previous = handoffs[handoffId];
      if (previous) {
        if (previous.environmentId !== environmentId) {
          throw new Error("Agent handoff belongs to another environment");
        }
        // Handoffs are immutable. Returning the committed record makes a retry
        // idempotent without allowing a second client to replace its contents.
        return previous;
      }
      const saved: PersistedAgentHandoff = {
        version,
        id: handoffId,
        environmentId,
        snapshot,
        createdAt: nowIso(),
      };
      handoffs[handoffId] = saved;
      await this.context.saveSensitiveJson(this.files.agentHandoffsFile(), handoffs);
      return saved;
    });
  }

  /**
   * Deletes one handoff after its destination tab no longer references it.
   *
   * The environment id is required even though handoff ids are globally unique:
   * it prevents a stale or malformed client from deleting another environment's
   * transcript. Backups are scrubbed even when the primary no longer contains
   * the record so retrying a partially completed cleanup finishes the privacy
   * boundary rather than reporting success with retained content.
   */
  async deleteAgentHandoff(handoffId: string, environmentId: string): Promise<boolean> {
    if (!isNonBlankString(handoffId)) {
      throw new Error("Agent handoff ID must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    return this.enqueueAgentHandoffMutation(async () => {
      const handoffs = await this.loadAgentHandoffEntries();
      const stored = handoffs[handoffId];
      if (
        isRecord(stored) &&
        isNonBlankString(stored.environmentId) &&
        stored.environmentId !== environmentId
      ) {
        throw new Error("Agent handoff belongs to another environment");
      }
      const existed = Object.prototype.hasOwnProperty.call(handoffs, handoffId);
      delete handoffs[handoffId];
      // Always rewrite an existing store: an unreadable one reads as empty, and
      // an idempotent retry still needs to replace it. Do not *create* one — a
      // client deleting a stale reference on an installation that never used
      // the feature should leave no trace.
      if (await this.context.storeExists(this.files.agentHandoffsFile())) {
        await this.context.saveSensitiveJson(this.files.agentHandoffsFile(), handoffs);
      }
      await this.context.scrubSensitiveJsonBackups(
        this.files.agentHandoffsFile(),
        (storedId) => storedId !== handoffId,
      );
      return existed;
    });
  }

  /**
   * Reconciles stored handoffs against the ids a pane layout still references.
   *
   * Deletion at tab close is a best-effort renderer call: a backend restart, a
   * lock timeout or a kill between the layout update and the request drops it
   * silently, and the id is gone from the layout by then, so nothing would ever
   * retry. Without this sweep those transcripts stay on disk permanently,
   * unreachable and unremovable short of deleting the environment. Called after
   * pane-layout hydration, when `referencedHandoffIds` is authoritative.
   */
  async pruneAgentHandoffs(
    environmentId: string,
    referencedHandoffIds: string[],
  ): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    const referenced = new Set(referencedHandoffIds.filter(isNonBlankString));
    return this.enqueueAgentHandoffMutation(async () => {
      const stored = await this.loadAgentHandoffEntries();
      const isOrphan = (storedId: string, handoff: unknown): boolean =>
        isRecord(handoff) && handoff.environmentId === environmentId && !referenced.has(storedId);
      const removedIds = Object.entries(stored)
        .filter(([storedId, handoff]) => isOrphan(storedId, handoff))
        .map(([storedId]) => storedId);
      if (removedIds.length === 0) return [];
      const retained = Object.fromEntries(
        Object.entries(stored).filter(([storedId, handoff]) => !isOrphan(storedId, handoff)),
      );
      await this.context.saveSensitiveJson(this.files.agentHandoffsFile(), retained);
      await this.context.scrubSensitiveJsonBackups(
        this.files.agentHandoffsFile(),
        (storedId, handoff) => !isOrphan(storedId, handoff),
      );
      return removedIds;
    });
  }

  async deleteAgentHandoffsByEnvironment(environmentId: string): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    return this.enqueueAgentHandoffMutation(async () => {
      const stored = await this.loadAgentHandoffEntries();
      const removedIds = Object.entries(stored)
        .filter(([, handoff]) => isRecord(handoff) && handoff.environmentId === environmentId)
        .map(([storedId]) => storedId);
      const handoffs = Object.fromEntries(
        Object.entries(stored).filter(
          ([storedId, handoff]) =>
            isPersistedAgentHandoff(handoff, storedId) && handoff.environmentId !== environmentId,
        ),
      );
      // Rewrite even if no valid record matched. Invalid entries cannot be
      // proven free of content from the environment being deleted.
      if (await this.context.storeExists(this.files.agentHandoffsFile())) {
        await this.context.saveSensitiveJson(this.files.agentHandoffsFile(), handoffs);
      }
      await this.context.scrubSensitiveJsonBackups(
        this.files.agentHandoffsFile(),
        (storedId, handoff) =>
          isPersistedAgentHandoff(handoff, storedId) && handoff.environmentId !== environmentId,
      );
      return removedIds;
    });
  }

  async deletePaneLayout(environmentId: string, expectedRevision?: number): Promise<void> {
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Pane layout expected revision must be a non-negative integer");
    }
    return this.repos.sessions.enqueuePaneLayoutMutation(async () => {
      const layouts = await this.context.loadJson<Record<string, PersistedPaneLayout>>(
        this.files.paneLayoutsFile(),
        () => ({}),
      );
      const currentRevision = layouts[environmentId]?.revision ?? 0;
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
        throw new Error(paneLayoutRevisionConflictMessage(expectedRevision, currentRevision));
      }
      if (!(environmentId in layouts)) return;
      delete layouts[environmentId];
      await this.context.saveJson(this.files.paneLayoutsFile(), layouts);
      this.context.changes.announce("pane-layout", environmentId);
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const stored = this.context.loadStoreRow(this.files.sessionsFile(), sessionId);
    return isRecord(stored) && stored.id === sessionId ? (stored as unknown as Session) : null;
  }

  async getSessionsByEnvironment(environmentId: string): Promise<Session[]> {
    const sessions = this.context.loadStoreRowsByOwner<Session>(
      this.files.sessionsFile(),
      environmentId,
    );
    return sessions
      .filter((session) => session.environmentId === environmentId)
      .sort((a, b) => a.order - b.order);
  }

  // Every sessions-store mutation below is one synchronous SQLite transaction
  // (`updateStore`), so concurrent tab creates, renames and reorders — in this
  // or another backend — cannot overwrite each other's read-modify-write.
  async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    const session = this.context.updateStore(
      this.files.sessionsFile(),
      (): Session[] => [],
      (sessions) => {
        const found = sessions.find((candidate) => candidate.id === sessionId);
        if (!found) throw new Error(`Session not found: ${sessionId}`);
        Object.assign(found, updates);
        return found;
      },
    );
    this.context.changes.announce("session", session.environmentId);
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const removed = this.context.updateStore(
      this.files.sessionsFile(),
      (): Session[] => [],
      (sessions) => {
        const index = sessions.findIndex((session) => session.id === sessionId);
        if (index < 0) throw new Error(`Session not found: ${sessionId}`);
        return sessions.splice(index, 1)[0];
      },
    );
    await this.deleteSessionBuffer(sessionId);
    if (removed) this.context.changes.announce("session", removed.environmentId);
  }

  async removeSessionsByEnvironment(environmentId: string): Promise<string[]> {
    const removed = this.context.updateStore(
      this.files.sessionsFile(),
      (): Session[] => [],
      (sessions) => {
        const ids = sessions
          .filter((session) => session.environmentId === environmentId)
          .map((session) => session.id);
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
          if (sessions[index]!.environmentId === environmentId) sessions.splice(index, 1);
        }
        return ids;
      },
    );
    await Promise.all(removed.map((sessionId) => this.deleteSessionBuffer(sessionId)));
    if (removed.length > 0) this.context.changes.announce("session", environmentId);
    return removed;
  }

  async disconnectEnvironmentSessions(environmentId: string): Promise<Session[]> {
    const updated = this.context.updateStore(
      this.files.sessionsFile(),
      (): Session[] => [],
      (sessions) => {
        const changed: Session[] = [];
        for (const session of sessions) {
          if (session.environmentId === environmentId && session.status === "connected") {
            session.status = "disconnected";
            changed.push(session);
          }
        }
        return changed;
      },
    );
    if (updated.length > 0) this.context.changes.announce("session", environmentId);
    return updated;
  }

  async reorderSessions(environmentId: string, sessionIds: string[]): Promise<Session[]> {
    this.context.updateStore(
      this.files.sessionsFile(),
      (): Session[] => [],
      (sessions) => {
        const provided = new Set(sessionIds);
        for (const [index, id] of sessionIds.entries()) {
          const session = sessions.find(
            (candidate) => candidate.id === id && candidate.environmentId === environmentId,
          );
          if (session) session.order = index;
        }
        let order = sessionIds.length;
        for (const session of sessions) {
          if (session.environmentId === environmentId && !provided.has(session.id))
            session.order = order++;
        }
      },
    );
    this.context.changes.announce("session", environmentId);
    return this.getSessionsByEnvironment(environmentId);
  }

  async saveSessionBuffer(sessionId: string, buffer: string): Promise<void> {
    await fs.mkdir(this.files.buffersDir(), { recursive: true });
    const maxBufferSize = 500 * 1024;
    if (Buffer.byteLength(buffer, "utf8") > maxBufferSize) {
      throw new Error("Serialized terminal buffer exceeds the 500 KiB limit");
    }
    await fs.writeFile(this.files.bufferFile(sessionId), buffer);
  }

  async loadSessionBuffer(sessionId: string): Promise<string | null> {
    const filePath = this.files.bufferFile(sessionId);
    if (!(await exists(filePath))) return null;
    // A blob file, not a store: a file read, so storage budgets count stores only.
    const buffer = await fs.readFile(filePath, "utf8");
    recurringWorkMetrics.work("file-read");
    recurringWorkMetrics.bytes(buffer.length);
    return buffer;
  }

  async deleteSessionBuffer(sessionId: string): Promise<void> {
    await fs.rm(this.files.bufferFile(sessionId), { force: true });
  }

  async cleanupOrphanedBuffers(): Promise<string[]> {
    if (!(await exists(this.files.buffersDir()))) return [];
    const sessions = await this.context.loadJson<Session[]>(this.files.sessionsFile(), () => []);
    const liveBufferFiles = new Set(sessions.map((session) => `${session.id}.txt`));
    const deleted: string[] = [];
    for (const entry of await fs.readdir(this.files.buffersDir())) {
      const sessionId = path.basename(entry, path.extname(entry));
      if (!liveBufferFiles.has(entry)) {
        await fs.rm(path.join(this.files.buffersDir(), entry), { force: true });
        deleted.push(sessionId);
      }
    }
    return deleted;
  }
}
