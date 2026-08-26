import * as shared from "./storage-shared.js";
import {
  MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES,
  serializedInitialPromptAttachmentBytes,
  toDurableInitialPromptAttachments,
} from "@orkestrator/protocol/initial-prompt-attachments";
import {
  LEGACY_ENVIRONMENT_AGENT_KEYS,
  migrateEnvironmentAgentSettings,
} from "./storage-agent-settings.js";
import { isEmptyAgentSettings, normalizeAgentSettings } from "@orkestrator/protocol/agent-settings";
import {
  AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS,
  AGENT_ACTIVITY_SOURCES,
  AGENT_ACTIVITY_STATES,
  FRONTEND_AGENT_ACTIVITY_LEASE_MS,
  MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS,
  MAX_JSON_BACKUPS,
  agentActivityStructureFingerprint,
  aggregateEnvironmentAgentActivity,
  exists,
  frontendAgentActivityObserverKey,
  fs,
  isAgentActivityTimestamp,
  isClaudeModelCatalogSnapshot,
  isInitialPromptImageAttachment,
  isNonBlankString,
  isOneOf,
  isPortMapping,
  isPortNumber,
  isPositiveInteger,
  isRecord,
  isStartupAgentSession,
  isTabTeardownKind,
  nextAgentActivityTimestamp,
  parseUsableAgentActivityTime,
  readAgentActivitySources,
  readFrontendAgentActivityObservers,
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

import { StorageBase } from "./storage-base.ts";

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

export abstract class StorageProjects extends StorageBase {
  async loadProjects(): Promise<Project[]> {
    const projects = await this.loadJsonCached<Project[]>(this.projectsFile(), () => []);
    return projects.sort((a, b) => a.order - b.order);
  }

  /**
   * `validate` runs inside the projects.json critical section, so a caller that
   * must reject against the *current* stored set — a duplicate local path, say
   * — cannot be raced by a concurrent writer between its own check and this
   * insert.
   */
  async addProject(
    project: Project,
    validate?: (projects: Project[]) => void | Promise<void>,
  ): Promise<Project> {
    const added = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      if (projects.some((candidate) => candidate.gitUrl === project.gitUrl)) {
        throw new Error(`Duplicate project URL: ${project.gitUrl}`);
      }
      if (validate) await validate(projects);

      project.order = Math.max(-1, ...projects.map((item) => item.order)) + 1;
      projects.push(project);
      await this.saveJson(this.projectsFile(), projects);
      return project;
    });
    this.announce("project", project.id);
    return added;
  }

  async removeProject(projectId: string): Promise<void> {
    await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const filtered = projects.filter((project) => project.id !== projectId);
      if (filtered.length === projects.length) throw new Error(`Project not found: ${projectId}`);
      await this.saveJson(this.projectsFile(), filtered);
    });
    await this.deleteComposeDraftsByProject(projectId);
    this.announce("project", projectId);
  }

  async getProject(projectId: string): Promise<Project | null> {
    return (await this.loadProjects()).find((project) => project.id === projectId) ?? null;
  }

  async updateProject(
    projectId: string,
    updates: Partial<Pick<Project, "name" | "localPath">>,
  ): Promise<Project> {
    const project = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (typeof updates.name === "string") project.name = updates.name;
      if ("localPath" in updates) project.localPath = updates.localPath ?? null;
      await this.saveJson(this.projectsFile(), projects);
      return project;
    });
    this.announce("project", projectId);
    return project;
  }

  async reorderProjects(projectIds: string[]): Promise<Project[]> {
    const projects = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const provided = new Set(projectIds);
      for (const [index, id] of projectIds.entries()) {
        const project = projects.find((candidate) => candidate.id === id);
        if (project) project.order = index;
      }

      let order = projectIds.length;
      for (const project of projects) {
        if (!provided.has(project.id)) project.order = order++;
      }

      await this.saveJson(this.projectsFile(), projects);
      return projects.sort((a, b) => a.order - b.order);
    });
    for (const project of projects) this.announce("project", project.id);
    return projects;
  }

  async loadEnvironments(): Promise<Environment[]> {
    const environments = await this.loadJsonCached<Environment[]>(
      this.environmentsFile(),
      () => [],
    );
    // One-release migration for records written before setupPhase existed.
    // The backend remains authoritative even before the next mutation persists
    // the normalized fields.
    for (const environment of environments) {
      environment.setupPhase ??= environment.setupScriptsComplete ? "ready" : "pending";
      environment.setupOverride ??= false;
      // Fold the five per-platform agent fields onto the shared tier shape. The
      // legacy keys are deleted here rather than left beside the new block, so
      // a stale value cannot be read back by anything that still remembers the
      // old name and the two shapes cannot drift while both sit on disk.
      const migrated = migrateEnvironmentAgentSettings(
        environment as unknown as Record<string, unknown>,
      );
      // Absence already means "inherit everything", so an empty tier is not
      // written back onto every environment record.
      if (isEmptyAgentSettings(migrated)) delete environment.agentSettings;
      else environment.agentSettings = migrated;
      for (const key of LEGACY_ENVIRONMENT_AGENT_KEYS) {
        delete (environment as unknown as Record<string, unknown>)[key];
      }
    }
    return environments.sort((a, b) => a.order - b.order);
  }

  protected async saveEnvironments(
    environments: Environment[],
    options: { backup?: boolean } = {},
  ): Promise<void> {
    // Launch attachments can contain full base64 image payloads. Treat the
    // complete environment store and every rotated backup as sensitive.
    await this.saveSensitiveJson(this.environmentsFile(), environments, options);
  }

  /**
   * Removes superseded launch attachments (or a deleted environment record)
   * from every retained environment backup. This runs while the environment
   * mutation lock is held, after the authoritative primary write commits.
   */
  protected async scrubEnvironmentBackups(
    environmentId: string,
    removeEnvironment: boolean,
  ): Promise<void> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(this.environmentsFile(), index);
      if (!(await exists(backup))) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(backup, "utf8")) as unknown;
        if (!Array.isArray(parsed)) throw new Error("Backup is not an array");
        const sanitized = removeEnvironment
          ? parsed.filter((candidate) => !isRecord(candidate) || candidate.id !== environmentId)
          : parsed.map((candidate) => {
              if (!isRecord(candidate) || candidate.id !== environmentId) {
                return candidate;
              }
              const copy = { ...candidate };
              delete copy.initialPromptAttachments;
              return copy;
            });
        await this.writeAtomic(backup, `${JSON.stringify(sanitized, null, 2)}\n`, false, 0o600);
      } catch {
        // A corrupt backup cannot be proven free of the removed payload.
        await fs.rm(backup, { force: true });
      }
    }
  }

  async getEnvironmentsByProject(projectId: string): Promise<Environment[]> {
    return (await this.loadEnvironments()).filter(
      (environment) => environment.projectId === projectId,
    );
  }

  async getEnvironment(environmentId: string): Promise<Environment | null> {
    return (
      (await this.loadEnvironments()).find((environment) => environment.id === environmentId) ??
      null
    );
  }

  async addEnvironment(environment: Environment): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      environment.order =
        Math.max(
          -1,
          ...environments
            .filter((item) => item.projectId === environment.projectId)
            .map((item) => item.order),
        ) + 1;
      environments.push(environment);
      await this.saveEnvironments(environments);
      this.announce("environment", environment.id, environment.projectId);
      return environment;
    });
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const removed = environments.find((environment) => environment.id === environmentId);
      const filtered = environments.filter((environment) => environment.id !== environmentId);
      if (filtered.length === environments.length) {
        // A previous attempt may have committed the primary removal and then
        // failed while sanitizing retained backups. Keep deletion idempotent so
        // retrying can finish the privacy cleanup before preserving the public
        // not-found contract.
        await this.scrubEnvironmentBackups(environmentId, true);
        throw new Error(`Environment not found: ${environmentId}`);
      }
      await this.saveEnvironments(filtered);
      await this.scrubEnvironmentBackups(environmentId, true);
      this.announce("environment", environmentId, removed?.projectId);
    });
  }

  async updateEnvironment(environmentId: string, updates: JsonRecord): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const beforeJson = JSON.stringify(environment);

      if (isNonBlankString(updates.name)) environment.name = updates.name;
      if (isNonBlankString(updates.branch)) environment.branch = updates.branch;
      if (
        "status" in updates &&
        isOneOf(updates.status, ["running", "stopped", "error", "creating", "stopping"])
      ) {
        environment.status = updates.status;
        if (updates.status === "stopped" || updates.status === "error") {
          // Idempotent: re-stopping an environment whose activity is already
          // fully cleared must not bump the activity token, or the repeated
          // update could never take the equality bail-out below.
          const alreadyCleared =
            environment.agentActivityState === "idle" &&
            isRecord(environment.agentActivitySources) &&
            Object.keys(environment.agentActivitySources).length === 0 &&
            isRecord(environment.frontendAgentActivityObservers) &&
            Object.keys(environment.frontendAgentActivityObservers).length === 0;
          if (!alreadyCleared) {
            environment.agentActivityState = "idle";
            environment.agentActivitySources = {};
            environment.frontendAgentActivityObservers = {};
            environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
              environment.agentActivityUpdatedAt,
            );
          }
        }
      }
      if (
        "environmentType" in updates &&
        isOneOf(updates.environmentType, ["containerized", "local"])
      ) {
        environment.environmentType = updates.environmentType;
      }

      const optionalStringFields = [
        "worktreePath",
        "initialPrompt",
        "initialAgentModel",
        "initialReasoningEffort",
        "prRecheckAfterAgentCompletionArmedAt",
        "pendingRenamePrompt",
        "createdFromCommit",
        "lastActivityAt",
        "deletionRequestedAt",
        "cleanupAfterMergeRequestedAt",
        "cleanupAfterMergeError",
        "lifecycleOperationStartedAt",
        "setupSessionId",
        "setupStartedAt",
        "setupCompletedAt",
      ] as const;
      for (const field of optionalStringFields) {
        if (field in updates) {
          const value = updates[field];
          if (value === null || value === undefined || typeof value === "string") {
            (environment as unknown as Record<string, unknown>)[field] = value ?? undefined;
          }
        }
      }
      if ("lifecycleError" in updates) {
        const value = updates.lifecycleError;
        if (value === null || value === undefined || typeof value === "string") {
          // Cleared as an explicit `null`, not `undefined`. Renderers merge
          // snapshots field-by-field and `JSON.stringify` drops undefined keys
          // entirely, so a cleared failure would arrive as an absent key and
          // leave the stale message on screen.
          environment.lifecycleError = value ?? null;
        }
      }
      if ("lifecycleOperation" in updates) {
        if (updates.lifecycleOperation == null) {
          environment.lifecycleOperation = undefined;
        } else if (
          updates.lifecycleOperation === "deleting" ||
          updates.lifecycleOperation === "merging"
        ) {
          environment.lifecycleOperation = updates.lifecycleOperation;
        }
      }

      if (
        "containerId" in updates &&
        (updates.containerId == null || typeof updates.containerId === "string")
      ) {
        environment.containerId = updates.containerId ?? null;
      }
      if ("prUrl" in updates && (updates.prUrl == null || typeof updates.prUrl === "string")) {
        environment.prUrl = updates.prUrl ?? null;
      }
      if ("prState" in updates) {
        if (updates.prState == null) environment.prState = null;
        else if (isOneOf(updates.prState, ["open", "merged", "closed"]))
          environment.prState = updates.prState;
      }
      if ("hasMergeConflicts" in updates) {
        if (updates.hasMergeConflicts == null) environment.hasMergeConflicts = null;
        else if (typeof updates.hasMergeConflicts === "boolean")
          environment.hasMergeConflicts = updates.hasMergeConflicts;
      }
      if ("allowedDomains" in updates)
        environment.allowedDomains = Array.isArray(updates.allowedDomains)
          ? updates.allowedDomains.filter((value): value is string => typeof value === "string")
          : undefined;
      if ("portMappings" in updates) {
        if (updates.portMappings == null) environment.portMappings = undefined;
        else if (Array.isArray(updates.portMappings) && updates.portMappings.every(isPortMapping)) {
          environment.portMappings = updates.portMappings;
        }
      }

      const pidFields = [
        "opencodePid",
        "claudeBridgePid",
        "codexBridgePid",
        "cursorBridgePid",
        "grokBridgePid",
        "piBridgePid",
      ] as const;
      for (const field of pidFields) {
        if (!(field in updates)) continue;
        const value = updates[field];
        if (value == null) environment[field] = undefined;
        else if (isPositiveInteger(value)) environment[field] = value;
      }

      const portFields = [
        "localOpencodePort",
        "localClaudePort",
        "localCodexPort",
        "localCursorPort",
        "localGrokPort",
        "localPiPort",
        "entryPort",
        "hostEntryPort",
      ] as const;
      for (const field of portFields) {
        if (!(field in updates)) continue;
        const value = updates[field];
        if (value == null) environment[field] = undefined;
        else if (isPortNumber(value)) environment[field] = value;
      }

      if ("hasUnreadWork" in updates) {
        if (updates.hasUnreadWork == null) environment.hasUnreadWork = false;
        else if (typeof updates.hasUnreadWork === "boolean") {
          environment.hasUnreadWork = updates.hasUnreadWork;
        }
      }
      if ("setupScriptsComplete" in updates) {
        if (updates.setupScriptsComplete == null) environment.setupScriptsComplete = false;
        else if (typeof updates.setupScriptsComplete === "boolean") {
          environment.setupScriptsComplete = updates.setupScriptsComplete;
        }
      }
      if (
        "setupPhase" in updates &&
        isOneOf(updates.setupPhase, ["pending", "running", "ready", "failed"])
      ) {
        environment.setupPhase = updates.setupPhase;
      }
      if ("setupOverride" in updates && typeof updates.setupOverride === "boolean") {
        environment.setupOverride = updates.setupOverride;
      }
      if ("tabTeardownIntents" in updates) {
        const intents = updates.tabTeardownIntents;
        if (intents === undefined || intents === null) {
          environment.tabTeardownIntents = undefined;
        } else if (
          isRecord(intents) &&
          Object.values(intents).every(
            (intent) =>
              isRecord(intent) &&
              isNonBlankString(intent.tabId) &&
              isTabTeardownKind(intent.kind) &&
              isNonBlankString(intent.createdAt) &&
              (intent.sessionId === undefined || typeof intent.sessionId === "string") &&
              (intent.persistentSessionId === undefined ||
                typeof intent.persistentSessionId === "string"),
          )
        ) {
          environment.tabTeardownIntents = intents as Environment["tabTeardownIntents"];
        } else {
          throw new Error("Tab teardown intents are malformed");
        }
      }
      if ("pendingAgentLaunch" in updates && typeof updates.pendingAgentLaunch === "boolean") {
        environment.pendingAgentLaunch = updates.pendingAgentLaunch;
      }
      if ("initialPromptAttachments" in updates) {
        if (updates.initialPromptAttachments == null) {
          environment.initialPromptAttachments = undefined;
        } else if (
          Array.isArray(updates.initialPromptAttachments) &&
          updates.initialPromptAttachments.every(isInitialPromptImageAttachment)
        ) {
          if (
            serializedInitialPromptAttachmentBytes(updates.initialPromptAttachments) >
            MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES
          ) {
            throw new Error("Initial prompt attachments exceed the 32 MB limit");
          }
          environment.initialPromptAttachments = toDurableInitialPromptAttachments(
            updates.initialPromptAttachments,
          );
        } else {
          throw new Error("Initial prompt attachments are malformed");
        }
      }
      if ("startupAgentSession" in updates) {
        if (updates.startupAgentSession == null) {
          environment.startupAgentSession = undefined;
        } else if (isStartupAgentSession(updates.startupAgentSession)) {
          environment.startupAgentSession = updates.startupAgentSession;
        } else {
          throw new Error("Startup agent session is malformed");
        }
      }
      if ("claudeModelCatalog" in updates) {
        if (updates.claudeModelCatalog == null) {
          environment.claudeModelCatalog = undefined;
        } else if (isClaudeModelCatalogSnapshot(updates.claudeModelCatalog, environmentId)) {
          environment.claudeModelCatalog = updates.claudeModelCatalog;
        }
      }
      if (
        "networkAccessMode" in updates &&
        (updates.networkAccessMode === "full" || updates.networkAccessMode === "restricted")
      ) {
        environment.networkAccessMode = updates.networkAccessMode;
      }
      if ("agentSettings" in updates) {
        // The settings panes write this block wholesale, and an absent field
        // inside it is the user choosing "Inherit". Normalizing here keeps a
        // malformed or partial write out of persisted config, exactly as the
        // action-defaults normalizer does for its own object.
        environment.agentSettings = updates.agentSettings
          ? normalizeAgentSettings(updates.agentSettings)
          : undefined;
      }

      // A merge that changed nothing persists nothing. Rewriting the whole
      // store — and announcing a change that makes every client refetch every
      // project — for a field-equal record is pure churn.
      if (JSON.stringify(environment) === beforeJson) {
        // Attachment cleanup is a retryable two-step operation: the primary
        // may already be clean while a retained backup still contains the
        // payload. Explicit attachment updates must therefore finish scrubbing
        // even when the primary record no longer changes.
        if ("initialPromptAttachments" in updates) {
          await this.scrubEnvironmentBackups(environmentId, false);
        }
        return environment;
      }

      await this.saveEnvironments(environments);
      if ("initialPromptAttachments" in updates) {
        await this.scrubEnvironmentBackups(environmentId, false);
      }
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Journals one teardown against the latest environment snapshot while the
   * environment mutation lock is held. Whole-map updates from command callers
   * can otherwise overwrite a sibling teardown that was added concurrently.
   */
  async setTabTeardownIntent(
    environmentId: string,
    intent: NonNullable<Environment["tabTeardownIntents"]>[string],
  ): Promise<Environment> {
    if (
      !isNonBlankString(intent.tabId) ||
      !isTabTeardownKind(intent.kind) ||
      !isNonBlankString(intent.createdAt) ||
      (intent.sessionId !== undefined && !isNonBlankString(intent.sessionId)) ||
      (intent.persistentSessionId !== undefined && !isNonBlankString(intent.persistentSessionId))
    ) {
      throw new Error("Tab teardown intent is malformed");
    }
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      environment.tabTeardownIntents = {
        ...environment.tabTeardownIntents,
        [intent.tabId]: intent,
      };
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /** Clears only the intent this caller completed, preserving newer retries. */
  async clearTabTeardownIntent(
    environmentId: string,
    tabId: string,
    expectedCreatedAt: string,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const current = environment.tabTeardownIntents?.[tabId];
      if (!current || current.createdAt !== expectedCreatedAt) return environment;
      const intents = { ...environment.tabTeardownIntents };
      delete intents[tabId];
      environment.tabTeardownIntents = Object.keys(intents).length > 0 ? intents : undefined;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Atomically arms conflict-resolution reconciliation against the latest PR
   * fields. Serializing the predicate with the write prevents an older Resolve
   * click from re-arming an intent after a concurrent monitor check already
   * proved the PR mergeable.
   */
  async armPrRecheckAfterAgentCompletion(
    environmentId: string,
  ): Promise<{ environment: Environment; armedAt: string | null }> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      if (
        !environment.prUrl ||
        environment.prState !== "open" ||
        environment.hasMergeConflicts !== true
      )
        return { environment, armedAt: null };

      const now = Date.now();
      const previous = environment.prRecheckAfterAgentCompletionArmedAt
        ? Date.parse(environment.prRecheckAfterAgentCompletionArmedAt)
        : Number.NEGATIVE_INFINITY;
      environment.prRecheckAfterAgentCompletionArmedAt = new Date(
        Number.isFinite(previous) && previous >= now ? previous + 1 : now,
      ).toISOString();
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return {
        environment,
        armedAt: environment.prRecheckAfterAgentCompletionArmedAt,
      };
    });
  }

  /** Clears only the exact Resolve request whose tab launch failed. */
  async disarmPrRecheckAfterAgentCompletion(
    environmentId: string,
    armedAt: string,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      if (environment.prRecheckAfterAgentCompletionArmedAt !== armedAt) return environment;

      environment.prRecheckAfterAgentCompletionArmedAt = undefined;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Clears the backend-to-renderer startup-session projection only after the
   * matching pane tab has been persisted. The identity checks keep a delayed
   * acknowledgement from an old renderer from consuming a newer launch.
   */
  async acknowledgeStartupAgentSession(
    environmentId: string,
    providerSessionId: string | undefined,
    startedAt: string | undefined,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const startupSession = environment.startupAgentSession;
      if (!startupSession) return environment;
      if (
        providerSessionId !== undefined &&
        startupSession.providerSessionId !== providerSessionId
      ) {
        return environment;
      }
      if (startedAt !== undefined && startupSession.startedAt !== startedAt) {
        return environment;
      }
      environment.startupAgentSession = undefined;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  async recordEnvironmentActivity(environmentId: string, occurredAt: string): Promise<Environment> {
    const activityTime = Date.parse(occurredAt);
    if (!Number.isFinite(activityTime)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const normalizedActivityAt = new Date(activityTime).toISOString();

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      const previousTime = environment.lastActivityAt
        ? Date.parse(environment.lastActivityAt)
        : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(previousTime) && previousTime >= activityTime) {
        return environment;
      }

      environment.lastActivityAt = normalizedActivityAt;
      // Activity timestamps churn constantly and are reconstructed from live
      // observation anyway; rotating five backups for each refresh is waste.
      await this.saveEnvironments(environments, { backup: false });
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Persist the aggregate agent state observed by a frontend or backend
   * monitor. Timestamp ordering makes reports idempotent and prevents a
   * delayed client from replacing a newer observation.
   */
  async setEnvironmentAgentActivity(
    environmentId: string,
    state: AgentActivityState,
    occurredAt: string,
    source: AgentActivitySource = "frontend",
    observerId?: string,
    stale = false,
  ): Promise<Environment> {
    if (!isOneOf(state, AGENT_ACTIVITY_STATES)) {
      throw new Error("state must be idle, working, or waiting");
    }
    if (!isAgentActivityTimestamp(occurredAt)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const occurredTime = Date.parse(occurredAt);
    if (occurredTime > Date.now() + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS) {
      throw new Error("occurredAt must not be more than 5 minutes in the future");
    }
    if (!isOneOf(source, AGENT_ACTIVITY_SOURCES)) {
      throw new Error(
        "source must be frontend, claude-terminal, claude-tmux, native-agent, or multi-review",
      );
    }
    if (
      observerId !== undefined &&
      (source !== "frontend" || !isNonBlankString(observerId) || observerId.length > 256)
    ) {
      throw new Error(
        "observerId must be a non-blank string of at most 256 characters for frontend activity",
      );
    }

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const structureBefore = agentActivityStructureFingerprint(environment);
      const previousAggregate = environment.agentActivityState ?? "idle";

      const referenceTime = Date.now();
      const sources = readAgentActivitySources(environment, referenceTime);
      const observers = readFrontendAgentActivityObservers(environment, referenceTime);

      const observerKey = observerId ? frontendAgentActivityObserverKey(observerId) : undefined;
      if (
        observerKey &&
        !observers[observerKey] &&
        Object.keys(observers).length >= MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS
      ) {
        throw new Error("too many frontend agent activity observers");
      }
      const previousSource = observerKey ? observers[observerKey] : sources[source];
      const previousTime = previousSource
        ? Date.parse(previousSource.updatedAt)
        : observerKey
          ? Number.NEGATIVE_INFINITY
          : parseUsableAgentActivityTime(environment.agentActivityUpdatedAt, referenceTime);
      let acceptedOccurredTime = occurredTime;
      if (Number.isFinite(previousTime) && previousTime >= occurredTime) {
        if (source === "frontend" || previousTime > occurredTime) {
          return environment;
        }
        // Backend polling is serialized, so arrival order is authoritative even
        // if two observations share a millisecond. Keep its per-source token
        // monotonic instead of dropping a real terminal transition. Strictly
        // older tokens remain stale and are still rejected.
        acceptedOccurredTime = previousTime + 1;
      }
      const normalizedOccurredAt = new Date(acceptedOccurredTime).toISOString();

      if (observerKey) {
        observers[observerKey] = {
          state,
          updatedAt: normalizedOccurredAt,
          leaseExpiresAt: new Date(referenceTime + FRONTEND_AGENT_ACTIVITY_LEASE_MS).toISOString(),
        };
      } else {
        sources[source] = {
          state,
          updatedAt: normalizedOccurredAt,
          ...(stale ? { stale: true } : {}),
        };
      }

      environment.agentActivitySources = sources;
      environment.frontendAgentActivityObservers = observers;
      environment.agentActivityState = aggregateEnvironmentAgentActivity(sources, observers);
      const nextAggregate = environment.agentActivityState;
      const aggregateTime = parseUsableAgentActivityTime(
        environment.agentActivityUpdatedAt,
        referenceTime,
      );
      environment.agentActivityUpdatedAt = new Date(
        Math.max(
          acceptedOccurredTime,
          Number.isFinite(aggregateTime) ? aggregateTime : Number.NEGATIVE_INFINITY,
        ),
      ).toISOString();
      const activityTransition =
        previousAggregate !== nextAggregate &&
        (nextAggregate === "working" ||
          nextAggregate === "waiting" ||
          (previousAggregate === "working" && nextAggregate === "idle"));
      const completionTransition =
        previousAggregate === "working" &&
        (nextAggregate === "idle" || nextAggregate === "waiting");
      if (activityTransition) {
        const previousLastActivityAt = Date.parse(environment.lastActivityAt ?? "");
        environment.lastActivityAt = new Date(
          Math.max(
            acceptedOccurredTime,
            Number.isFinite(previousLastActivityAt)
              ? previousLastActivityAt
              : Number.NEGATIVE_INFINITY,
          ),
        ).toISOString();
      }
      if (completionTransition) environment.hasUnreadWork = true;
      // The lease itself must persist (its expiry is enforced from disk), but
      // the backup rotation is skipped: only volatile activity fields changed.
      await this.saveEnvironments(environments, { backup: completionTransition });
      // A pure lease renewal — same aggregate, same per-source and observer
      // states, only timestamps refreshed — is not announced. Announcing it
      // made every connected client refetch every project on each renewal
      // (every ~10s per environment). The renewing renderer already applies
      // the returned record from this call's response, so it does not need
      // the broadcast; genuine state transitions still announce below.
      if (agentActivityStructureFingerprint(environment) !== structureBefore) {
        this.announce("environment", environmentId, environment.projectId);
      }
      return environment;
    });
  }

  /** Remove expired renderer leases and publish each changed aggregate. */
  async expireFrontendAgentActivityLeases(referenceTime = Date.now()): Promise<string[]> {
    // Cheap pre-check outside the cross-process lock: with no observer leases
    // on record there is nothing that could expire, and this sweep runs every
    // 15 seconds forever. The read is stat-validated, so a lease written by
    // another process is still seen; one added between this check and the
    // next sweep is simply handled by the next sweep.
    const snapshot = await this.loadEnvironments();
    const hasObserverLeases = snapshot.some((environment) => {
      const observers = environment.frontendAgentActivityObservers;
      return isRecord(observers) && Object.keys(observers).length > 0;
    });
    if (!hasObserverLeases) return [];

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const changed: string[] = [];
      for (const environment of environments) {
        const storedObservers = environment.frontendAgentActivityObservers;
        if (!isRecord(storedObservers) || Object.keys(storedObservers).length === 0) {
          continue;
        }
        const observers = readFrontendAgentActivityObservers(environment, referenceTime);
        if (Object.keys(observers).length === Object.keys(storedObservers).length) {
          continue;
        }
        const sources = readAgentActivitySources(environment, referenceTime);
        environment.agentActivitySources = sources;
        environment.frontendAgentActivityObservers = observers;
        environment.agentActivityState = aggregateEnvironmentAgentActivity(sources, observers);
        environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
          environment.agentActivityUpdatedAt,
          referenceTime,
        );
        changed.push(environment.id);
      }
      if (changed.length === 0) return changed;
      await this.saveEnvironments(environments, { backup: false });
      for (const environmentId of changed) {
        this.announce(
          "environment",
          environmentId,
          environments.find((environment) => environment.id === environmentId)?.projectId,
        );
      }
      return changed;
    });
  }

  /**
   * Drop every renderer-reported activity source. Backend startup is the one
   * moment where every pre-existing renderer lease is provably stale.
   */
  async clearFrontendAgentActivity(): Promise<string[]> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const referenceTime = Date.now();
      const changed: string[] = [];
      for (const environment of environments) {
        const hasLegacyFrontend = Boolean(environment.agentActivitySources?.frontend);
        const hasObservers =
          isRecord(environment.frontendAgentActivityObservers) &&
          Object.keys(environment.frontendAgentActivityObservers).length > 0;
        if (!hasLegacyFrontend && !hasObservers) continue;
        const sources = readAgentActivitySources(environment, referenceTime);
        delete sources.frontend;
        environment.agentActivitySources = sources;
        environment.frontendAgentActivityObservers = {};
        environment.agentActivityState = aggregateEnvironmentAgentActivity(sources, {});
        environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
          environment.agentActivityUpdatedAt,
          referenceTime,
        );
        changed.push(environment.id);
      }
      if (changed.length === 0) return changed;
      await this.saveEnvironments(environments, { backup: false });
      for (const environmentId of changed) {
        this.announce(
          "environment",
          environmentId,
          environments.find((environment) => environment.id === environmentId)?.projectId,
        );
      }
      return changed;
    });
  }

  async recordEnvironmentCompletion(
    environmentId: string,
    occurredAt: string,
  ): Promise<Environment> {
    const activityTime = Date.parse(occurredAt);
    if (!Number.isFinite(activityTime)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const normalizedActivityAt = new Date(activityTime).toISOString();

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      const previousTime = environment.lastActivityAt
        ? Date.parse(environment.lastActivityAt)
        : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(previousTime) && previousTime >= activityTime) {
        return environment;
      }

      environment.lastActivityAt = normalizedActivityAt;
      environment.hasUnreadWork = true;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Persist one backend-observed session completion independently of the
   * environment-wide activity aggregate. Several native tabs can share the
   * `native-agent` source, so one tab may complete while a sibling keeps that
   * aggregate `working`.
   *
   * Backend observations are serialized but may share a millisecond with the
   * preceding working edge. Advance the durable token on a collision rather
   * than dropping a real completion as stale. Callers must invoke this exactly
   * once per observed per-session transition.
   */
  async recordEnvironmentSessionCompletion(
    environmentId: string,
    occurredAt: string,
  ): Promise<Environment> {
    if (!isAgentActivityTimestamp(occurredAt)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const occurredTime = Date.parse(occurredAt);

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      const previousTime = Date.parse(environment.lastActivityAt ?? "");
      const acceptedTime =
        Number.isFinite(previousTime) && previousTime >= occurredTime
          ? previousTime + 1
          : occurredTime;
      environment.lastActivityAt = new Date(acceptedTime).toISOString();
      environment.hasUnreadWork = true;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  async setEnvironmentUnread(
    environmentId: string,
    unread: boolean,
    expectedLastActivityAt?: string | null,
  ): Promise<Environment> {
    if (
      expectedLastActivityAt !== undefined &&
      expectedLastActivityAt !== null &&
      typeof expectedLastActivityAt !== "string"
    ) {
      throw new Error("expectedLastActivityAt must be a string or null");
    }
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      if (
        !unread &&
        expectedLastActivityAt !== undefined &&
        (environment.lastActivityAt ?? null) !== expectedLastActivityAt
      ) {
        return environment;
      }
      if (environment.hasUnreadWork === unread) return environment;

      environment.hasUnreadWork = unread;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  async reorderEnvironments(projectId: string, environmentIds: string[]): Promise<Environment[]> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const provided = new Set(environmentIds);
      for (const [index, id] of environmentIds.entries()) {
        const environment = environments.find(
          (candidate) => candidate.id === id && candidate.projectId === projectId,
        );
        if (environment) environment.order = index;
      }

      let order = environmentIds.length;
      for (const environment of environments) {
        if (environment.projectId === projectId && !provided.has(environment.id))
          environment.order = order++;
      }

      await this.saveEnvironments(environments);
      const reordered = environments
        .filter((environment) => environment.projectId === projectId)
        .sort((a, b) => a.order - b.order);
      for (const environment of reordered) {
        this.announce("environment", environment.id, environment.projectId);
      }
      return reordered;
    });
  }
}
