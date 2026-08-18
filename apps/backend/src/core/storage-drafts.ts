import * as shared from "./storage-shared.js";
import {
  MAX_JSON_BACKUPS,
  activeBuildAdmissionKey,
  activeGitHubBuildReservation,
  exists,
  fs,
  isNonBlankString,
  isNonNegativeInteger,
  isPersistedAgentHandoff,
  isPersistedBuildPipeline,
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
type AgentModelConfigKey = shared.AgentModelConfigKey;
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

import { StoragePrompts } from "./storage-prompts.ts";

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
  AgentModelConfigKey,
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

export abstract class StorageDrafts extends StoragePrompts {
  async getComposeDraft(draftKey: string): Promise<PersistedComposeDraft | null> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    return (await this.loadComposeDrafts())[draftKey] ?? null;
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
    return Object.values(await this.loadComposeDrafts()).filter(
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

    return this.enqueueComposeDraftMutation(async () => {
      if (ownerType === "environment") {
        await this.assertEnvironmentAcceptsBackgroundState(ownerId, "Compose draft");
      } else if (!(await this.getProject(ownerId))) {
        throw new Error(`Compose draft project not found: ${ownerId}`);
      }
      const drafts = await this.loadComposeDrafts();
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
      await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
      this.announce("compose-draft", ownerId);
      return saved;
    });
  }

  async deleteComposeDraft(draftKey: string, expectedRevision?: number): Promise<void> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Compose draft expected revision must be a non-negative integer");
    }
    await this.enqueueComposeDraftMutation(async () => {
      const stored = await this.loadJson<unknown>(this.composeDraftsFile(), () => ({}));
      const drafts = this.validComposeDrafts(stored);
      const previous = drafts[draftKey];
      if (previous && expectedRevision !== undefined && previous.revision !== expectedRevision) {
        throw new Error("Compose draft revision conflict");
      }
      const hasStoredKey = isRecord(stored) && Object.hasOwn(stored, draftKey);
      if (hasStoredKey) {
        delete drafts[draftKey];
        await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
      }
      if (previous) {
        this.announce("compose-draft", previous.ownerId);
      }
      // Always scrub backups, including when the primary no longer contains
      // the key. A prior interrupted delete may have committed the primary
      // write without sanitizing the retained copies.
      await this.scrubSensitiveJsonBackups(
        this.composeDraftsFile(),
        (storedKey, draft) => storedKey !== draftKey && isPersistedComposeDraft(draft, storedKey),
      );
    });
  }

  async deleteComposeDraftsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Compose draft environment ID must not be blank");
    }
    await this.enqueueComposeDraftMutation(async () => {
      const drafts = await this.loadComposeDrafts();
      const keys = Object.values(drafts)
        .filter((draft) => draft.ownerType === "environment" && draft.ownerId === environmentId)
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
        this.announce("compose-draft", environmentId);
      }
      await this.scrubSensitiveJsonBackups(
        this.composeDraftsFile(),
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
    await this.enqueueComposeDraftMutation(async () => {
      const drafts = await this.loadComposeDrafts();
      const keys = Object.values(drafts)
        .filter((draft) => draft.ownerType === "project" && draft.ownerId === projectId)
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
        this.announce("compose-draft", projectId);
      }
      await this.scrubSensitiveJsonBackups(
        this.composeDraftsFile(),
        (storedKey, draft) =>
          isPersistedComposeDraft(draft, storedKey) &&
          (draft.ownerType !== "project" || draft.ownerId !== projectId),
      );
    });
  }

  protected enqueueFileDraftMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(this.fileDraftsFile(), "file draft storage");
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.fileDraftMutation.then(run, run);
    this.fileDraftMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected validFileDrafts(stored: unknown): Record<string, PersistedFileDraft> {
    if (!isRecord(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, draft]) => isPersistedFileDraft(draft, storedKey)),
    ) as Record<string, PersistedFileDraft>;
  }

  protected async loadFileDrafts(): Promise<Record<string, PersistedFileDraft>> {
    const stored = await this.loadJson<unknown>(this.fileDraftsFile(), () => ({}));
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
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "File draft");
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
      await this.saveSensitiveJson(this.fileDraftsFile(), drafts);
      this.announce("file-draft", environmentId);
      return saved;
    });
  }

  async deleteFileDraft(draftKey: string, expectedRevision?: number): Promise<void> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("File draft expected revision must be a non-negative integer");
    }
    await this.enqueueFileDraftMutation(async () => {
      const stored = await this.loadJson<unknown>(this.fileDraftsFile(), () => ({}));
      const drafts = this.validFileDrafts(stored);
      const previous = drafts[draftKey];
      if (previous && expectedRevision !== undefined && previous.revision !== expectedRevision) {
        throw new Error("File draft revision conflict");
      }
      const hasStoredKey = isRecord(stored) && Object.hasOwn(stored, draftKey);
      if (hasStoredKey) {
        delete drafts[draftKey];
        await this.saveSensitiveJson(this.fileDraftsFile(), drafts);
      }
      if (previous) {
        this.announce("file-draft", previous.environmentId);
      }
      await this.scrubSensitiveJsonBackups(
        this.fileDraftsFile(),
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
        await this.saveSensitiveJson(this.fileDraftsFile(), drafts);
        this.announce("file-draft", environmentId);
      }
      await this.scrubSensitiveJsonBackups(
        this.fileDraftsFile(),
        (storedKey, draft) =>
          isPersistedFileDraft(draft, storedKey) && draft.environmentId !== environmentId,
      );
    });
  }

  protected enqueueAgentHandoffMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.agentHandoffsFile(),
        "agent handoff storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.agentHandoffMutation.then(run, run);
    this.agentHandoffMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected async loadAgentHandoffEntries(): Promise<Record<string, unknown>> {
    const stored = await this.loadJson<unknown>(this.agentHandoffsFile(), () => ({}));
    return isRecord(stored) ? stored : {};
  }

  protected async loadAgentHandoffs(): Promise<Record<string, PersistedAgentHandoff>> {
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
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Agent handoff");
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
      await this.saveSensitiveJson(this.agentHandoffsFile(), handoffs);
      return saved;
    });
  }

  protected async assertAgentHandoffBackupOwnership(
    handoffId: string,
    environmentId: string,
  ): Promise<void> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(this.agentHandoffsFile(), index);
      if (!(await exists(backup))) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(backup, "utf8"));
      } catch {
        // The scrub that follows removes corrupt backups because their content
        // cannot be proven free of the targeted handoff.
        continue;
      }
      if (!isRecord(parsed)) continue;
      const candidate = parsed[handoffId];
      if (
        isRecord(candidate) &&
        isNonBlankString(candidate.environmentId) &&
        candidate.environmentId !== environmentId
      ) {
        throw new Error("Agent handoff belongs to another environment");
      }
    }
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
      await this.assertAgentHandoffBackupOwnership(handoffId, environmentId);
      const existed = Object.prototype.hasOwnProperty.call(handoffs, handoffId);
      delete handoffs[handoffId];
      // Always rewrite an existing file: a corrupt primary may have fallen back
      // to a backup, and an idempotent retry still needs to replace that
      // unreadable primary. Do not *create* one — a client deleting a stale
      // reference on an installation that never used the feature should leave no
      // trace, and there is nothing to recover when no file exists.
      if (await exists(this.agentHandoffsFile())) {
        await this.saveSensitiveJson(this.agentHandoffsFile(), handoffs);
      }
      await this.scrubSensitiveJsonBackups(
        this.agentHandoffsFile(),
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
      await this.saveSensitiveJson(this.agentHandoffsFile(), retained);
      await this.scrubSensitiveJsonBackups(
        this.agentHandoffsFile(),
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
      // Rewrite even if no valid record matched. Invalid primary entries cannot
      // be proven free of content from the environment being deleted.
      if (await exists(this.agentHandoffsFile())) {
        await this.saveSensitiveJson(this.agentHandoffsFile(), handoffs);
      }
      await this.scrubSensitiveJsonBackups(
        this.agentHandoffsFile(),
        (storedId, handoff) =>
          isPersistedAgentHandoff(handoff, storedId) && handoff.environmentId !== environmentId,
      );
      return removedIds;
    });
  }

  protected async loadBuildPipelines(): Promise<Record<string, PersistedBuildPipeline>> {
    const stored = await this.loadJson<Record<string, PersistedBuildPipeline>>(
      this.buildPipelinesFile(),
      () => ({}),
    );
    return Object.fromEntries(
      Object.entries(stored).filter(([storedId, pipeline]) =>
        isPersistedBuildPipeline(pipeline, storedId),
      ),
    ) as Record<string, PersistedBuildPipeline>;
  }

  async getBuildPipeline(pipelineId: string): Promise<PersistedBuildPipeline | null> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    return (await this.loadBuildPipelines())[pipelineId] ?? null;
  }

  async listBuildPipelines(projectId: string): Promise<PersistedBuildPipeline[]> {
    if (!isNonBlankString(projectId)) {
      throw new Error("Build pipeline project ID must not be blank");
    }
    return Object.values(await this.loadBuildPipelines())
      .filter((pipeline) => pipeline.projectId === projectId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  /** Backend supervisors use this to re-arm every active pipeline on startup. */
  async listAllBuildPipelines(): Promise<PersistedBuildPipeline[]> {
    return Object.values(await this.loadBuildPipelines()).sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt),
    );
  }

  async saveBuildPipeline(
    pipelineId: string,
    projectId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
  ): Promise<PersistedBuildPipeline> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    if (!isNonBlankString(projectId)) {
      throw new Error("Build pipeline project ID must not be blank");
    }
    if (typeof environmentId !== "string") {
      throw new Error("Build pipeline environment ID must be a string");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Build pipeline version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Build pipeline snapshot must be a JSON object");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Build pipeline expected revision must be a non-negative integer");
    }
    let serializedSnapshot: string | undefined;
    try {
      serializedSnapshot = JSON.stringify(snapshot);
    } catch {
      throw new Error("Build pipeline snapshot must be JSON serializable");
    }
    if (serializedSnapshot === undefined) {
      throw new Error("Build pipeline snapshot must be JSON serializable");
    }
    // Task snapshots embed base64 attachment data and structured review reports
    // retain full findings. Reject an over-sized snapshot rather than truncating
    // it: a silently trimmed task is a pipeline that builds the wrong thing.
    if (Buffer.byteLength(serializedSnapshot, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Build pipeline snapshot exceeds the 32 MB limit");
    }

    return this.enqueueBuildPipelineMutation(async () => {
      if (environmentId) {
        await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Build pipeline");
      }
      const pipelines = await this.loadBuildPipelines();
      const previous = pipelines[pipelineId];
      if (previous && previous.projectId !== projectId) {
        throw new Error("Build pipeline belongs to another project");
      }
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
        throw new Error("Build pipeline revision conflict");
      }
      const admissionKey = activeBuildAdmissionKey(snapshot);
      if (!previous && expectedRevision === 0 && admissionKey) {
        const admitted = Object.values(pipelines).find(
          (pipeline) => activeBuildAdmissionKey(pipeline.snapshot) === admissionKey,
        );
        if (admitted) return admitted;
      }
      const reservation = activeGitHubBuildReservation(snapshot);
      if (
        reservation &&
        Object.values(pipelines).some(
          (pipeline) =>
            pipeline.id !== pipelineId &&
            activeGitHubBuildReservation(pipeline.snapshot) === reservation,
        )
      ) {
        throw new Error(`An active build already exists for ${reservation}`);
      }
      const saved: PersistedBuildPipeline = {
        version,
        id: pipelineId,
        projectId,
        environmentId,
        snapshot,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      pipelines[pipelineId] = saved;
      await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
      this.announce("build-pipeline", pipelineId);
      return saved;
    });
  }

  async deleteBuildPipeline(pipelineId: string): Promise<void> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    await this.enqueueBuildPipelineMutation(async () => {
      const pipelines = await this.loadBuildPipelines();
      if (pipelineId in pipelines) {
        delete pipelines[pipelineId];
        await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
        this.announce("build-pipeline", pipelineId);
      }
      await this.scrubSensitiveJsonBackups(
        this.buildPipelinesFile(),
        (storedId, pipeline) =>
          storedId !== pipelineId && isPersistedBuildPipeline(pipeline, storedId),
      );
    });
  }

  async deleteBuildPipelinesByEnvironment(
    environmentId: string,
    linkedPipelineId?: string,
  ): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Build pipeline environment ID must not be blank");
    }
    if (
      linkedPipelineId !== undefined &&
      linkedPipelineId !== "" &&
      !isNonBlankString(linkedPipelineId)
    ) {
      throw new Error("Linked build pipeline ID must not be blank");
    }
    return this.enqueueBuildPipelineMutation(async () => {
      const pipelines = await this.loadBuildPipelines();
      const linkedId = isNonBlankString(linkedPipelineId) ? linkedPipelineId : null;
      const removedIds = Object.values(pipelines)
        .filter((pipeline) => pipeline.environmentId === environmentId || pipeline.id === linkedId)
        .map((pipeline) => pipeline.id);
      if (removedIds.length > 0) {
        for (const removedId of removedIds) delete pipelines[removedId];
        await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
        for (const removedId of removedIds) this.announce("build-pipeline", removedId);
      }
      const removedIdSet = new Set(removedIds);
      if (linkedId) removedIdSet.add(linkedId);

      // Task snapshots embed base64 attachments and full review findings, so
      // the same backup scrub the looped review path performs applies here.
      // Check both ownership forms because a newly-created pipeline deliberately
      // has a blank environmentId until create_environment links it.
      await this.scrubSensitiveJsonBackups(
        this.buildPipelinesFile(),
        (storedId, pipeline) =>
          isPersistedBuildPipeline(pipeline, storedId) &&
          pipeline.environmentId !== environmentId &&
          !removedIdSet.has(storedId),
      );
      return removedIds;
    });
  }

  async deletePaneLayout(environmentId: string, expectedRevision?: number): Promise<void> {
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Pane layout expected revision must be a non-negative integer");
    }
    return this.enqueuePaneLayoutMutation(async () => {
      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      const currentRevision = layouts[environmentId]?.revision ?? 0;
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
        throw new Error(paneLayoutRevisionConflictMessage(expectedRevision, currentRevision));
      }
      if (!(environmentId in layouts)) return;
      delete layouts[environmentId];
      await this.saveJson(this.paneLayoutsFile(), layouts);
      this.announce("pane-layout", environmentId);
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    return sessions.find((session) => session.id === sessionId) ?? null;
  }

  async getSessionsByEnvironment(environmentId: string): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    return sessions
      .filter((session) => session.environmentId === environmentId)
      .sort((a, b) => a.order - b.order);
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    Object.assign(session, updates);
    await this.saveJson(this.sessionsFile(), sessions);
    this.announce("session", session.environmentId);
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const removed = sessions.find((session) => session.id === sessionId);
    const filtered = sessions.filter((session) => session.id !== sessionId);
    if (filtered.length === sessions.length) throw new Error(`Session not found: ${sessionId}`);
    await this.saveJson(this.sessionsFile(), filtered);
    await this.deleteSessionBuffer(sessionId);
    if (removed) this.announce("session", removed.environmentId);
  }

  async removeSessionsByEnvironment(environmentId: string): Promise<string[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const removed = sessions
      .filter((session) => session.environmentId === environmentId)
      .map((session) => session.id);
    await this.saveJson(
      this.sessionsFile(),
      sessions.filter((session) => session.environmentId !== environmentId),
    );
    await Promise.all(removed.map((sessionId) => this.deleteSessionBuffer(sessionId)));
    if (removed.length > 0) this.announce("session", environmentId);
    return removed;
  }

  async disconnectEnvironmentSessions(environmentId: string): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const updated: Session[] = [];
    for (const session of sessions) {
      if (session.environmentId === environmentId && session.status === "connected") {
        session.status = "disconnected";
        updated.push(session);
      }
    }
    await this.saveJson(this.sessionsFile(), sessions);
    if (updated.length > 0) this.announce("session", environmentId);
    return updated;
  }

  async reorderSessions(environmentId: string, sessionIds: string[]): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
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
    await this.saveJson(this.sessionsFile(), sessions);
    this.announce("session", environmentId);
    return this.getSessionsByEnvironment(environmentId);
  }

  async saveSessionBuffer(sessionId: string, buffer: string): Promise<void> {
    await fs.mkdir(this.buffersDir(), { recursive: true });
    const maxBufferSize = 500 * 1024;
    const contents =
      buffer.length > maxBufferSize ? buffer.slice(buffer.length - maxBufferSize) : buffer;
    await fs.writeFile(this.bufferFile(sessionId), contents);
  }

  async loadSessionBuffer(sessionId: string): Promise<string | null> {
    const filePath = this.bufferFile(sessionId);
    if (!(await exists(filePath))) return null;
    return fs.readFile(filePath, "utf8");
  }

  async deleteSessionBuffer(sessionId: string): Promise<void> {
    await fs.rm(this.bufferFile(sessionId), { force: true });
  }

  async cleanupOrphanedBuffers(): Promise<string[]> {
    if (!(await exists(this.buffersDir()))) return [];
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const liveBufferFiles = new Set(sessions.map((session) => `${session.id}.txt`));
    const deleted: string[] = [];
    for (const entry of await fs.readdir(this.buffersDir())) {
      const sessionId = path.basename(entry, path.extname(entry));
      if (!liveBufferFiles.has(entry)) {
        await fs.rm(path.join(this.buffersDir(), entry), { force: true });
        deleted.push(sessionId);
      }
    }
    return deleted;
  }
}
