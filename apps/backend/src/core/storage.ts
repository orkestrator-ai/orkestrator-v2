export * from "./storage-shared.js";

import type { ScheduledJobStore } from "./scheduled-jobs/store.js";
import { StorageContext } from "./storage-context.js";
import { StorageRepositories } from "./storage-repositories.js";
import path from "node:path";
import type { AgentAccountStore } from "./agent-accounts-store.js";
import type { BuildPipelineTranscriptMigrationReport } from "./build-pipeline-transcript-migration.js";
import type {
  BuildPipelineTranscriptFaultStage,
  BuildPipelineTranscriptFaults,
  BuildPipelineTranscriptLimits,
  BuildPipelineTranscriptStats,
  TranscriptCommitInput,
  TranscriptCommitResult,
  TranscriptRead,
  TranscriptReadWindow,
} from "./build-pipeline-transcript-store.js";
import type { EnvironmentUnreadReason, IncompleteTurnNotice } from "./models.js";
import type { NativeAgentDisplayTailDeletion } from "./native-agent-display-tail-store.js";
import type { NativeAgentDisplayTail } from "./native-agent-display-tails.js";
import type { AttentionPosition } from "./public-api/attention-cursor.js";
import type {
  PublicAuthority,
  PublicOperationIndex,
  PublicOperationRecord,
} from "./public-api/operation-ledger.js";
import type {
  AgentMailRepository,
  AgentMailSender,
  PendingAgentMailInject,
} from "./storage-agent-mail.js";
import type { ConfigRepository } from "./storage-config.js";
import type { NodeStoreMutation, NodesRepository } from "./storage-nodes.js";
import type {
  LoadedPreviewServiceStore,
  PreviewBackendIdentity,
  PreviewServiceStore,
  PreviewSettings,
} from "./storage-preview-services.js";
import type {
  AdmitPublicOperationInput,
  PublicOperationLookup,
  PublicOperationsRepository,
} from "./storage-public-operations.js";
import type {
  AgentActivitySource,
  AgentActivityState,
  AgentInteractionResolutionJournal,
  AgentModel,
  AgentModelCatalogCache,
  AppConfig,
  BuildPipelineAgent,
  ClaudeModelCatalogEntry,
  CodexModelCatalogEntry,
  ConditionalResourceSnapshot,
  Environment,
  EnvironmentStatus,
  FeaturePlan,
  FeaturePlanMessage,
  FeaturePlanningRecord,
  GitHubCompletionComment,
  JsonRecord,
  KanbanImage,
  KanbanStatus,
  KanbanTask,
  LinearAuth,
  LinearCompletionComment,
  OpenCodeModelCatalogEntry,
  OpenCodeModelCatalogSnapshot,
  PaneLayoutMergeInput,
  PaneLayoutSelectionIntent,
  PersistedAgentHandoff,
  PersistedBuildPipeline,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedLoopedReviewWorkflow,
  PersistedMultiReviewWorkflow,
  PersistedNativeAgentPendingDispatch,
  PersistedNativeAgentPendingSteer,
  PersistedNativeAgentSession,
  PersistedPaneLayout,
  PersistedPromptQueue,
  PortMapping,
  Project,
  ProjectNotes,
  RepositoryConfig,
  ResourceChangeListener,
  ResourceManifestKind,
  ResourceRevisionManifest,
  ResourceRevisionMap,
  ResourceSnapshotRevision,
  ScopedResourceRevisionManifest,
  Session,
  SessionType,
  StoredDesktopConnections,
} from "./storage-shared.js";
import type { RecordUsageTurnsInput } from "./usage-history-store.js";
import type {
  AgentMailConversation,
  AgentMailConversationList,
  AgentMailInboxSnapshot,
  AgentMailMailboxBatchSnapshot,
  AgentMailMailboxSnapshot,
  AgentMailMessage,
  AgentMailMessageSummary,
  AgentMailNotice,
  AgentMailSendInput,
  AgentMailSummarySnapshot,
  MailboxDescriptor,
} from "@orkestrator/protocol/agent-mail";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { BackendProfile, BackendProfileUpdate } from "@orkestrator/protocol/backend-profile";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type { NodeAttachments, NodeRegistry } from "@orkestrator/protocol/command-nodes";
import type { ControllerSettingsStore } from "@orkestrator/protocol/controller-settings";
import type {
  CoordinatorWorkflowAssociation,
  CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import type {
  NativeAgentControlUpdate,
  NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import type { PortalLayout, PortalLayoutUpdate } from "@orkestrator/protocol/portal-layout";
import type { PublicActionName } from "@orkestrator/protocol/public-api";
import type { UsageHistoryQuery, UsageHistoryReport } from "@orkestrator/protocol/usage-history";

/**
 * The backend's storage: one facade over per-store repositories that share
 * one {@link StorageContext} (`docs/architecture/storage.md`).
 *
 * Every public method forwards to the repository that owns its store, so the
 * surface callers use stays the same while each store's code lives in one
 * repository. These methods are the only way in: code outside the storage
 * files never names a repository, and `storage-writer-guards.test.ts` follows
 * every store write back to one of them.
 */
export class StorageService {
  private readonly context: StorageContext;
  private readonly repos: StorageRepositories;
  private scheduledJobStoreInstance: ScheduledJobStore | null = null;

  constructor(dataDir: string, options: { snapshots?: boolean } = {}) {
    this.context = new StorageContext(dataDir, { snapshots: options.snapshots });
    this.repos = new StorageRepositories(this.context);

  }

  scheduledJobStore(): ScheduledJobStore {
    return this.repos.scheduledJobs.store();
  }

  async getResourceSnapshotRevision(
    resource: ResourceManifestKind,
  ): Promise<ResourceSnapshotRevision> {
    return this.context.changes.getResourceSnapshotRevision(resource);
  }

  getResourceGeneration(): string {
    return this.context.changes.getResourceGeneration();
  }

  async getResourceRevisionManifest(
    knownGeneration?: string,
    knownRevisions: Partial<ResourceRevisionMap> = {},
  ): Promise<ResourceRevisionManifest> {
    return this.context.changes.getResourceRevisionManifest(knownGeneration, knownRevisions);
  }

  async getScopedResourceRevisionManifest(
    knownGeneration: string | undefined,
    cursor: number,
    knownRevisions: Partial<ResourceRevisionMap> = {},
    requestedHighWater?: number,
  ): Promise<ScopedResourceRevisionManifest> {
    return this.context.changes.getScopedResourceRevisionManifest(
      knownGeneration,
      cursor,
      knownRevisions,
      requestedHighWater,
    );
  }

  async readConditionalResourceSnapshot<T>(
    resource: ResourceManifestKind,
    knownGeneration: string,
    knownRevision: ResourceSnapshotRevision,
    load: () => Promise<T> | T,
  ): Promise<ConditionalResourceSnapshot<T>> {
    return this.context.changes.readConditionalResourceSnapshot(
      resource,
      knownGeneration,
      knownRevision,
      load,
    );
  }

  /**
   * Inherited global settings from the command node, consulted by
   * `loadConfig`. Set by the backend once its node runtime exists.
   */
  get inheritedGlobalSettings(): ConfigRepository["inheritedGlobalSettings"] {
    return this.repos.config.inheritedGlobalSettings;
  }

  set inheritedGlobalSettings(value: ConfigRepository["inheritedGlobalSettings"]) {
    this.repos.config.inheritedGlobalSettings = value;
  }

  /** Routes agent mail to other nodes; set once the node runtime exists. */
  get nodeMailRouter(): NodesRepository["nodeMailRouter"] {
    return this.repos.nodes.nodeMailRouter;
  }

  set nodeMailRouter(value: NodesRepository["nodeMailRouter"]) {
    this.repos.nodes.nodeMailRouter = value;
  }

  withProjectCreationLock<T>(
    canonicalProjectPath: string,
    operation: () => Promise<T>,
    options?: { acquireTimeoutMs?: number },
  ): Promise<T> {
    return this.repos.projects.withProjectCreationLock(canonicalProjectPath, operation, options);
  }

  // ProjectsRepository

  loadProjects(): Promise<Project[]> {
    return this.repos.projects.loadProjects();
  }

  addProject(
    project: Project,
    validate?: (projects: Project[]) => void | Promise<void>,
  ): Promise<Project> {
    return this.repos.projects.addProject(project, validate);
  }

  removeProject(projectId: string): Promise<void> {
    return this.repos.projects.removeProject(projectId);
  }

  getProject(projectId: string): Promise<Project | null> {
    return this.repos.projects.getProject(projectId);
  }

  updateProject(
    projectId: string,
    updates: Partial<Pick<Project, "name" | "gitUrl" | "localPath" | "folder">>,
  ): Promise<Project> {
    return this.repos.projects.updateProject(projectId, updates);
  }

  reorderProjects(projectIds: string[]): Promise<Project[]> {
    return this.repos.projects.reorderProjects(projectIds);
  }

  arrangeProjects(
    projectIds: string[],
    folders: Readonly<Record<string, string | null>> = {},
  ): Promise<Project[]> {
    return this.repos.projects.arrangeProjects(projectIds, folders);
  }

  loadEnvironmentIdsForCleanup(): Promise<Set<string>> {
    return this.repos.projects.loadEnvironmentIdsForCleanup();
  }

  loadEnvironments(): Promise<Environment[]> {
    return this.repos.projects.loadEnvironments();
  }

  getEnvironmentsByProject(projectId: string): Promise<Environment[]> {
    return this.repos.projects.getEnvironmentsByProject(projectId);
  }

  getEnvironment(environmentId: string): Promise<Environment | null> {
    return this.repos.projects.getEnvironment(environmentId);
  }

  fenceEmptyProjectForRemoval(projectId: string): Promise<void> {
    return this.repos.projects.fenceEmptyProjectForRemoval(projectId);
  }

  releaseProjectRemovalFence(projectId: string): Promise<void> {
    return this.repos.projects.releaseProjectRemovalFence(projectId);
  }

  addEnvironment(environment: Environment): Promise<Environment> {
    return this.repos.projects.addEnvironment(environment);
  }

  removeEnvironment(environmentId: string): Promise<void> {
    return this.repos.projects.removeEnvironment(environmentId);
  }

  updateEnvironment(
    environmentId: string,
    updates: JsonRecord,
    shouldUpdate?: (environment: Readonly<Environment>) => boolean | Promise<boolean>,
  ): Promise<Environment> {
    return this.repos.projects.updateEnvironment(environmentId, updates, shouldUpdate);
  }

  setTabTeardownIntent(
    environmentId: string,
    intent: NonNullable<Environment["tabTeardownIntents"]>[string],
  ): Promise<Environment> {
    return this.repos.projects.setTabTeardownIntent(environmentId, intent);
  }

  recordTabTeardownSessionId(
    environmentId: string,
    tabId: string,
    expectedCreatedAt: string,
    resumableSessionId: string,
  ): Promise<void> {
    return this.repos.projects.recordTabTeardownSessionId(
      environmentId,
      tabId,
      expectedCreatedAt,
      resumableSessionId,
    );
  }

  clearTabTeardownIntent(
    environmentId: string,
    tabId: string,
    expectedCreatedAt: string,
  ): Promise<Environment> {
    return this.repos.projects.clearTabTeardownIntent(environmentId, tabId, expectedCreatedAt);
  }

  armPrRecheckAfterAgentCompletion(
    environmentId: string,
  ): Promise<{ environment: Environment; armedAt: string | null }> {
    return this.repos.projects.armPrRecheckAfterAgentCompletion(environmentId);
  }

  disarmPrRecheckAfterAgentCompletion(
    environmentId: string,
    armedAt: string,
  ): Promise<Environment> {
    return this.repos.projects.disarmPrRecheckAfterAgentCompletion(environmentId, armedAt);
  }

  acknowledgeStartupAgentSession(
    environmentId: string,
    providerSessionId: string | undefined,
    startedAt: string | undefined,
  ): Promise<Environment> {
    return this.repos.projects.acknowledgeStartupAgentSession(
      environmentId,
      providerSessionId,
      startedAt,
    );
  }

  recordEnvironmentActivity(environmentId: string, occurredAt: string): Promise<Environment> {
    return this.repos.projects.recordEnvironmentActivity(environmentId, occurredAt);
  }

  setEnvironmentAgentActivity(
    environmentId: string,
    state: AgentActivityState,
    occurredAt: string,
    source: AgentActivitySource = "frontend",
    observerId?: string,
    stale = false,
    options: { completionAttention?: boolean } = {},
  ): Promise<Environment> {
    return this.repos.projects.setEnvironmentAgentActivity(
      environmentId,
      state,
      occurredAt,
      source,
      observerId,
      stale,
      options,
    );
  }

  expireFrontendAgentActivityLeases(referenceTime = Date.now()): Promise<string[]> {
    return this.repos.projects.expireFrontendAgentActivityLeases(referenceTime);
  }

  clearFrontendAgentActivity(): Promise<string[]> {
    return this.repos.projects.clearFrontendAgentActivity();
  }

  recordEnvironmentCompletion(environmentId: string, occurredAt: string): Promise<Environment> {
    return this.repos.projects.recordEnvironmentCompletion(environmentId, occurredAt);
  }

  recordEnvironmentSessionCompletion(
    environmentId: string,
    occurredAt: string,
    reason: Extract<EnvironmentUnreadReason, "agent_finished" | "agent_waiting"> = "agent_finished",
  ): Promise<Environment> {
    return this.repos.projects.recordEnvironmentSessionCompletion(
      environmentId,
      occurredAt,
      reason,
    );
  }

  recordEnvironmentAgentAttention(
    environmentId: string,
    attentionKeys: readonly string[],
    occurredAt: string,
  ): Promise<{ environment: Environment; recorded: boolean }> {
    return this.repos.projects.recordEnvironmentAgentAttention(
      environmentId,
      attentionKeys,
      occurredAt,
    );
  }

  setEnvironmentUnread(
    environmentId: string,
    unread: boolean,
    expectedLastActivityAt?: string | null,
  ): Promise<Environment> {
    return this.repos.projects.setEnvironmentUnread(environmentId, unread, expectedLastActivityAt);
  }

  reorderEnvironments(projectId: string, environmentIds: string[]): Promise<Environment[]> {
    return this.repos.projects.reorderEnvironments(projectId, environmentIds);
  }

  setAllEnvironmentStatusesForContainer(
    containerId: string,
    status: EnvironmentStatus,
  ): Promise<void> {
    return this.repos.projects.setAllEnvironmentStatusesForContainer(containerId, status);
  }

  // ConfigRepository

  loadConfig(): Promise<AppConfig> {
    return this.repos.config.loadConfig();
  }

  announceInheritedSettingsChanged(): void {
    return this.repos.config.announceInheritedSettingsChanged();
  }

  loadOwnConfig(): Promise<AppConfig> {
    return this.repos.config.loadOwnConfig();
  }

  saveConfig(config: AppConfig, options: { preserveCredentials?: boolean } = {}): Promise<void> {
    return this.repos.config.saveConfig(config, options);
  }

  getAgentModelCatalogCache(): Promise<AgentModelCatalogCache> {
    return this.repos.config.getAgentModelCatalogCache();
  }

  cacheAgentModelCatalog(
    agent: "claude",
    models: ClaudeModelCatalogEntry[],
  ): Promise<AgentModelCatalogCache>;

  cacheAgentModelCatalog(
    agent: "codex",
    models: CodexModelCatalogEntry[],
  ): Promise<AgentModelCatalogCache>;

  cacheAgentModelCatalog(
    agent: "cursor" | "grok" | "pi",
    models: AgentModel[],
  ): Promise<AgentModelCatalogCache>;

  cacheAgentModelCatalog(
    agent: "claude" | "codex" | "cursor" | "grok" | "pi",
    models: ClaudeModelCatalogEntry[] | CodexModelCatalogEntry[] | AgentModel[],
  ): Promise<AgentModelCatalogCache> {
    return this.repos.config.cacheAgentModelCatalog(agent, models);
  }

  getOpenCodeModelCatalog(projectId: string): Promise<OpenCodeModelCatalogSnapshot | null> {
    return this.repos.config.getOpenCodeModelCatalog(projectId);
  }

  cacheOpenCodeModelCatalog(
    projectId: string,
    models: OpenCodeModelCatalogEntry[],
    connectedProviderIds?: readonly string[],
  ): Promise<OpenCodeModelCatalogSnapshot> {
    return this.repos.config.cacheOpenCodeModelCatalog(projectId, models, connectedProviderIds);
  }

  getDesktopConnections(): Promise<StoredDesktopConnections> {
    return this.repos.config.getDesktopConnections();
  }

  saveDesktopConnections(desktopConnections: StoredDesktopConnections): Promise<void> {
    return this.repos.config.saveDesktopConnections(desktopConnections);
  }

  getRepositoryConfig(projectId: string): Promise<RepositoryConfig> {
    return this.repos.config.getRepositoryConfig(projectId);
  }

  updateRepositoryConfig(projectId: string, repoConfig: RepositoryConfig): Promise<AppConfig> {
    return this.repos.config.updateRepositoryConfig(projectId, repoConfig);
  }

  updateRepositorySettings(projectId: string, repoConfig: RepositoryConfig): Promise<AppConfig> {
    return this.repos.config.updateRepositorySettings(projectId, repoConfig);
  }

  patchRepositoryConfig(projectId: string, updates: Partial<RepositoryConfig>): Promise<AppConfig> {
    return this.repos.config.patchRepositoryConfig(projectId, updates);
  }

  updateGlobalConfig(
    globalConfig: AppConfig["global"],
    options: { preserveCredentials?: boolean; preserveInheritedSettings?: boolean } = {},
  ): Promise<AppConfig> {
    return this.repos.config.updateGlobalConfig(globalConfig, options);
  }

  updateWorktreeLocations(
    locations: import("@orkestrator/protocol/disk-usage").WorktreeLocationSettings,
  ): Promise<AppConfig> {
    return this.repos.config.updateWorktreeLocations(locations);
  }

  updateMcpManagementRollout(
    settings: import("@orkestrator/protocol/mcp-management").McpManagementRolloutSettings,
  ): Promise<AppConfig> {
    return this.repos.config.updateMcpManagementRollout(settings);
  }

  updateNotificationSoundSettings(settings: unknown): Promise<AppConfig> {
    return this.repos.config.updateNotificationSoundSettings(settings);
  }

  setContainerResourceLimits(
    limits: import("@orkestrator/protocol/container-resources").ContainerResourceLimits | undefined,
  ): Promise<AppConfig> {
    return this.repos.config.setContainerResourceLimits(limits);
  }

  setGitHubCliReminderDismissed(dismissed: boolean): Promise<AppConfig> {
    return this.repos.config.setGitHubCliReminderDismissed(dismissed);
  }

  setGitHubToken(token: string | null): Promise<AppConfig> {
    return this.repos.config.setGitHubToken(token);
  }

  setCursorApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.repos.config.setCursorApiKey(apiKey);
  }

  setAnthropicApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.repos.config.setAnthropicApiKey(apiKey);
  }

  setOpenCodeZenApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.repos.config.setOpenCodeZenApiKey(apiKey);
  }

  // SessionsRepository

  recordAgentUsageTurns(input: RecordUsageTurnsInput): number {
    return this.repos.sessions.recordAgentUsageTurns(input);
  }

  getAgentUsageHistory(query: UsageHistoryQuery = {}): UsageHistoryReport {
    return this.repos.sessions.getAgentUsageHistory(query);
  }

  deleteAgentUsageHistoryByEnvironment(environmentId: string): number {
    return this.repos.sessions.deleteAgentUsageHistoryByEnvironment(environmentId);
  }

  createSession(
    environmentId: string,
    containerId: string,
    tabId: string,
    sessionType: SessionType,
  ): Promise<Session> {
    return this.repos.sessions.createSession(environmentId, containerId, tabId, sessionType);
  }

  getPaneLayout(environmentId: string): Promise<PersistedPaneLayout | null> {
    return this.repos.sessions.getPaneLayout(environmentId);
  }

  removeMultiReviewTabs(environmentId: string, workflowId: string): Promise<string[]> {
    return this.repos.sessions.removeMultiReviewTabs(environmentId, workflowId);
  }

  loadPaneLayoutsForReconciliation(): Promise<{
    available: boolean;
    layouts: Record<string, PersistedPaneLayout>;
  }> {
    return this.repos.sessions.loadPaneLayoutsForReconciliation();
  }

  savePaneLayout(
    environmentId: string,
    layout: Pick<PersistedPaneLayout, "version" | "containerId" | "activePaneId" | "root">,
    expectedRevision: number,
  ): Promise<PersistedPaneLayout> {
    return this.repos.sessions.savePaneLayout(environmentId, layout, expectedRevision);
  }

  applyPaneLayoutIntent(
    environmentId: string,
    base: PaneLayoutMergeInput,
    desired: PaneLayoutMergeInput,
    selectionIntent?: PaneLayoutSelectionIntent,
  ): Promise<PersistedPaneLayout> {
    return this.repos.sessions.applyPaneLayoutIntent(environmentId, base, desired, selectionIntent);
  }

  ensureBuildPipelineTab(input: {
    pipelineId: string;
    taskId: string;
    environmentId: string;
    isLocal: boolean;
  }): Promise<PersistedPaneLayout> {
    return this.repos.sessions.ensureBuildPipelineTab(input);
  }

  ensureNativeAgentJobTab(input: {
    environmentId: string;
    tabId: string;
    agent: BuildPipelineAgent;
    providerSessionId?: string;
    title?: string;
    isReviewTab?: boolean;
    activate?: boolean;
  }): Promise<PersistedPaneLayout> {
    return this.repos.sessions.ensureNativeAgentJobTab(input);
  }

  ensureTerminalJobTab(input: {
    environmentId: string;
    tabId: string;
    type: BuildPipelineAgent | "plain" | "claude-tmux";
    title?: string;
    activate?: boolean;
    terminalSessionId?: string | null;
    existingOnly?: boolean;
  }): Promise<PersistedPaneLayout> {
    return this.repos.sessions.ensureTerminalJobTab(input);
  }

  clearBackendTerminalSessionIds(environmentId?: string): Promise<number> {
    return this.repos.sessions.clearBackendTerminalSessionIds(environmentId);
  }

  ensureStartupNativeAgentTab(input: {
    environmentId: string;
    agent: BuildPipelineAgent;
    providerSessionId?: string;
    existingOnly?: boolean;
    upgradeOnly?: boolean;
    /**
     * Bind the tab to `agent` even before a provider session exists.
     *
     * Used when the create dialog already submitted an opening prompt: that
     * dispatch is committed, so the user must not be able to switch providers
     * underneath it. Prompt-less launches leave the tab unassigned and only
     * lock once the first send creates a session.
     */
    lockPlatform?: boolean;
    /**
     * Treat this publish like the first provider-session bind for setup
     * focus handoff. Prompt-less launches never bind a session, but they
     * still need to move off the setup terminal once setup is ready.
     */
    activateOnSetupHandoff?: boolean;
    initialAgentPlatform?: BuildPipelineAgent;
    initialAgentModel?: string;
    initialReasoningEffort?: string;
    initialConversationMode?: "build" | "plan";
    initialFastMode?: boolean;
  }): Promise<PersistedPaneLayout | null> {
    return this.repos.sessions.ensureStartupNativeAgentTab(input);
  }

  // ReviewsRepository

  getLoopedReviewWorkflow(workflowId: string): Promise<PersistedLoopedReviewWorkflow | null> {
    return this.repos.reviews.getLoopedReviewWorkflow(workflowId);
  }

  listLoopedReviewWorkflows(environmentId: string): Promise<PersistedLoopedReviewWorkflow[]> {
    return this.repos.reviews.listLoopedReviewWorkflows(environmentId);
  }

  listAllLoopedReviewWorkflows(): Promise<PersistedLoopedReviewWorkflow[]> {
    return this.repos.reviews.listAllLoopedReviewWorkflows();
  }

  saveLoopedReviewWorkflow(
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
    return this.repos.reviews.saveLoopedReviewWorkflow(
      workflowId,
      environmentId,
      version,
      snapshot,
      expectedRevision,
      controllerFence,
      options,
    );
  }

  claimLoopedReviewController(
    workflowId: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<{ granted: boolean; token: string; expiresAt: string }> {
    return this.repos.reviews.claimLoopedReviewController(workflowId, ownerId, leaseMs);
  }

  validateLoopedReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    return this.repos.reviews.validateLoopedReviewController(workflowId, ownerId, token);
  }

  releaseLoopedReviewController(workflowId: string, ownerId: string, token: string): Promise<void> {
    return this.repos.reviews.releaseLoopedReviewController(workflowId, ownerId, token);
  }

  deleteLoopedReviewWorkflow(workflowId: string): Promise<void> {
    return this.repos.reviews.deleteLoopedReviewWorkflow(workflowId);
  }

  deleteLoopedReviewWorkflowsByEnvironment(environmentId: string): Promise<void> {
    return this.repos.reviews.deleteLoopedReviewWorkflowsByEnvironment(environmentId);
  }

  getMultiReviewWorkflow(workflowId: string): Promise<PersistedMultiReviewWorkflow | null> {
    return this.repos.reviews.getMultiReviewWorkflow(workflowId);
  }

  listMultiReviewWorkflows(environmentId: string): Promise<PersistedMultiReviewWorkflow[]> {
    return this.repos.reviews.listMultiReviewWorkflows(environmentId);
  }

  listAllMultiReviewWorkflows(): Promise<PersistedMultiReviewWorkflow[]> {
    return this.repos.reviews.listAllMultiReviewWorkflows();
  }

  saveMultiReviewWorkflow(
    workflowId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
    controllerFence?: { ownerId: string; token: string },
  ): Promise<PersistedMultiReviewWorkflow> {
    return this.repos.reviews.saveMultiReviewWorkflow(
      workflowId,
      environmentId,
      version,
      snapshot,
      expectedRevision,
      controllerFence,
    );
  }

  createMultiReviewWorkflowIfNoActive(
    workflowId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
  ): Promise<PersistedMultiReviewWorkflow | null> {
    return this.repos.reviews.createMultiReviewWorkflowIfNoActive(
      workflowId,
      environmentId,
      version,
      snapshot,
    );
  }

  claimMultiReviewController(
    workflowId: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<{ granted: boolean; token: string; expiresAt: string }> {
    return this.repos.reviews.claimMultiReviewController(workflowId, ownerId, leaseMs);
  }

  validateMultiReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    return this.repos.reviews.validateMultiReviewController(workflowId, ownerId, token);
  }

  releaseMultiReviewController(workflowId: string, ownerId: string, token: string): Promise<void> {
    return this.repos.reviews.releaseMultiReviewController(workflowId, ownerId, token);
  }

  deleteMultiReviewWorkflow(workflowId: string): Promise<void> {
    return this.repos.reviews.deleteMultiReviewWorkflow(workflowId);
  }

  deleteMultiReviewWorkflowsByEnvironment(environmentId: string): Promise<void> {
    return this.repos.reviews.deleteMultiReviewWorkflowsByEnvironment(environmentId);
  }

  // NativeAgentSessionsRepository

  getAgentInteractionResolutionJournal(): Promise<AgentInteractionResolutionJournal> {
    return this.repos.nativeAgentSessions.getAgentInteractionResolutionJournal();
  }

  updateAgentInteractionResolutionJournal(
    update: (journal: AgentInteractionResolutionJournal) => AgentInteractionResolutionJournal,
  ): Promise<AgentInteractionResolutionJournal> {
    return this.repos.nativeAgentSessions.updateAgentInteractionResolutionJournal(update);
  }

  getNativeAgentSession(key: string): Promise<PersistedNativeAgentSession | null> {
    return this.repos.nativeAgentSessions.getNativeAgentSession(key);
  }

  listNativeAgentSessions(): Promise<PersistedNativeAgentSession[]> {
    return this.repos.nativeAgentSessions.listNativeAgentSessions();
  }

  getOrCreateNativeAgentSession(
    input: Pick<
      PersistedNativeAgentSession,
      "key" | "environmentId" | "agent" | "logicalSessionKey"
    > &
      Partial<
        Pick<
          PersistedNativeAgentSession,
          | "origin"
          | "interactionPolicy"
          | "controls"
          | "owner"
          | "executionPolicy"
          | "policy"
          | "initialPromptPresentation"
        >
      >,
    createProviderSession: () => Promise<string>,
  ): Promise<PersistedNativeAgentSession> {
    return this.repos.nativeAgentSessions.getOrCreateNativeAgentSession(
      input,
      createProviderSession,
    );
  }

  transitionCoordinatorResearchPolicy(
    expected: PersistedNativeAgentSession,
    policy: NonNullable<PersistedNativeAgentSession["policy"]>,
    owner: NonNullable<PersistedNativeAgentSession["owner"]>,
  ): Promise<void> {
    return this.repos.nativeAgentSessions.transitionCoordinatorResearchPolicy(
      expected,
      policy,
      owner,
    );
  }

  adoptNativeAgentSession(
    input: Pick<
      PersistedNativeAgentSession,
      "key" | "environmentId" | "agent" | "logicalSessionKey" | "providerSessionId"
    > &
      Partial<
        Pick<
          PersistedNativeAgentSession,
          | "origin"
          | "interactionPolicy"
          | "controls"
          | "owner"
          | "executionPolicy"
          | "policy"
          | "initialPromptPresentation"
        >
      > & {
        expectedProviderSessionId?: string;
      },
  ): Promise<PersistedNativeAgentSession> {
    return this.repos.nativeAgentSessions.adoptNativeAgentSession(input);
  }

  updateNativeAgentSessionControls(
    key: string,
    expectedProviderSessionId: string,
    update: NativeAgentControlUpdate,
    applyControls?: () => Promise<void>,
  ): Promise<PersistedNativeAgentSession> {
    return this.repos.nativeAgentSessions.updateNativeAgentSessionControls(
      key,
      expectedProviderSessionId,
      update,
      applyControls,
    );
  }

  initializeNativeAgentSessionInferredComposerIfAbsent(
    key: string,
    expectedProviderSessionId: string,
    selection: { modelId: string; reasoningId?: string },
  ): Promise<PersistedNativeAgentSession> {
    return this.repos.nativeAgentSessions.initializeNativeAgentSessionInferredComposerIfAbsent(
      key,
      expectedProviderSessionId,
      selection,
    );
  }

  recordNativeAgentSessionResumeIdentity(
    key: string,
    providerSessionId: string,
    resumableSessionId: string,
  ): Promise<boolean> {
    return this.repos.nativeAgentSessions.recordNativeAgentSessionResumeIdentity(
      key, providerSessionId, resumableSessionId,
    );
  }

  invalidateNativeAgentSession(key: string, providerSessionId: string): Promise<boolean> {
    return this.repos.nativeAgentSessions.invalidateNativeAgentSession(key, providerSessionId);
  }

  getNativeAgentDisplayTail(key: string): Promise<NativeAgentDisplayTail | null> {
    return this.repos.nativeAgentSessions.getNativeAgentDisplayTail(key);
  }

  putNativeAgentDisplayTail(
    key: string,
    tail: NativeAgentDisplayTail,
    options: { fence?: number } = {},
  ): Promise<boolean> {
    return this.repos.nativeAgentSessions.putNativeAgentDisplayTail(key, tail, options);
  }

  captureNativeAgentDisplayTailFence(): number {
    return this.repos.nativeAgentSessions.captureNativeAgentDisplayTailFence();
  }

  onNativeAgentDisplayTailDeleted(
    listener: (event: NativeAgentDisplayTailDeletion) => void,
  ): () => void {
    return this.repos.nativeAgentSessions.onNativeAgentDisplayTailDeleted(listener);
  }

  deleteNativeAgentDisplayTail(key: string): Promise<void> {
    return this.repos.nativeAgentSessions.deleteNativeAgentDisplayTail(key);
  }

  deleteNativeAgentDisplayTailsByEnvironment(environmentId: string): Promise<void> {
    return this.repos.nativeAgentSessions.deleteNativeAgentDisplayTailsByEnvironment(environmentId);
  }

  deleteNativeAgentSessionsByEnvironment(environmentId: string): Promise<void> {
    return this.repos.nativeAgentSessions.deleteNativeAgentSessionsByEnvironment(environmentId);
  }

  dispatchNativeAgentPromptOnce(
    key: string,
    requestId: string,
    dispatch: (session: PersistedNativeAgentSession) => Promise<void | {
      dispatched: false;
      mailRefused?: true;
      /** Recorded under the session's persisted notice field; `null` clears it. */
      incompleteTurnNotice?: IncompleteTurnNotice | null;
    }>,
    pendingDispatch?: PersistedNativeAgentPendingDispatch,
    admit?: (session: PersistedNativeAgentSession) => Promise<NativeAgentControlUpdate | undefined>,
  ): Promise<{
    session: PersistedNativeAgentSession;
    dispatched: boolean;
  }> {
    return this.repos.nativeAgentSessions.dispatchNativeAgentPromptOnce(
      key,
      requestId,
      dispatch,
      pendingDispatch,
      admit,
    );
  }

  confirmNativeAgentDispatch(key: string, requestId: string): Promise<boolean> {
    return this.repos.nativeAgentSessions.confirmNativeAgentDispatch(key, requestId);
  }

  clearPendingNativeAgentDispatch(
    key: string,
    requestId: string,
    onlyMailRefused = false,
  ): Promise<boolean> {
    return this.repos.nativeAgentSessions.clearPendingNativeAgentDispatch(
      key,
      requestId,
      onlyMailRefused,
    );
  }

  retireNativeAgentDispatch(key: string, requestId: string): Promise<boolean> {
    return this.repos.nativeAgentSessions.retireNativeAgentDispatch(key, requestId);
  }

  reservePromptQueueSteer(
    key: string,
    messageId: string,
    expectedRunId: string,
  ): Promise<PersistedNativeAgentPendingSteer | null> {
    return this.repos.nativeAgentSessions.reservePromptQueueSteer(key, messageId, expectedRunId);
  }

  reconcileNativeAgentSteer(
    key: string,
    requestId: string,
    readStatus: () => Promise<"dispatched" | "absent" | "unknown">,
  ): Promise<"dispatched" | "absent" | undefined> {
    return this.repos.nativeAgentSessions.reconcileNativeAgentSteer(key, requestId, readStatus);
  }

  recoverPromptQueueSteer(key: string, requestId: string): Promise<void> {
    return this.repos.nativeAgentSessions.recoverPromptQueueSteer(key, requestId);
  }

  dispatchNativeAgentSteerOnce(
    key: string,
    pendingSteer: PersistedNativeAgentPendingSteer,
    dispatch: (session: PersistedNativeAgentSession) => Promise<NativeAgentSessionActionOutcome>,
  ): Promise<NativeAgentSessionActionOutcome> {
    return this.repos.nativeAgentSessions.dispatchNativeAgentSteerOnce(key, pendingSteer, dispatch);
  }

  confirmNativeAgentSteer(key: string, requestId: string): Promise<boolean> {
    return this.repos.nativeAgentSessions.confirmNativeAgentSteer(key, requestId);
  }

  clearPendingNativeAgentSteer(key: string, requestId: string, discard = false): Promise<boolean> {
    return this.repos.nativeAgentSessions.clearPendingNativeAgentSteer(key, requestId, discard);
  }

  setIncompleteTurnNotice(
    key: string,
    providerSessionId: string,
    notice: IncompleteTurnNotice | null,
  ): Promise<boolean> {
    return this.repos.nativeAgentSessions.setIncompleteTurnNotice(key, providerSessionId, notice);
  }

  runWithLiveEnvironment<T>(
    environmentId: string,
    label: string,
    operation: (environment: Environment) => Promise<T>,
  ): Promise<T> {
    return this.repos.nativeAgentSessions.runWithLiveEnvironment(environmentId, label, operation);
  }

  readNativeAgentPublicationState(
    key: string,
    queueKey: string,
  ): Promise<{
    session: PersistedNativeAgentSession | null;
    queue: PersistedPromptQueue | null;
  }> {
    return this.repos.nativeAgentSessions.readNativeAgentPublicationState(key, queueKey);
  }

  recordNativeAgentTurnOutcome(
    key: string,
    providerSessionId: string,
    outcome: import("./models.js").PersistedNativeAgentTurnOutcome,
  ): Promise<boolean> {
    return this.repos.nativeAgentSessions.recordNativeAgentTurnOutcome(
      key,
      providerSessionId,
      outcome,
    );
  }

  recordNativeAgentTurnInterrupt(
    key: string,
    providerSessionId: string,
    requestId: string,
  ): Promise<boolean> {
    return this.repos.nativeAgentSessions.recordNativeAgentTurnInterrupt(
      key,
      providerSessionId,
      requestId,
    );
  }

  // PromptsRepository

  getPromptQueue(queueKey: string): Promise<PersistedPromptQueue | null> {
    return this.repos.prompts.getPromptQueue(queueKey);
  }

  listPromptQueues(environmentId: string): Promise<PersistedPromptQueue[]> {
    return this.repos.prompts.listPromptQueues(environmentId);
  }

  listAllPromptQueues(): Promise<PersistedPromptQueue[]> {
    return this.repos.prompts.listAllPromptQueues();
  }

  withEmptyPromptQueueForMail<T>(
    queueKey: string,
    environmentId: string,
    operation: () => Promise<T>,
  ): Promise<{ empty: false } | { empty: true; value: T }> {
    return this.repos.prompts.withEmptyPromptQueueForMail(queueKey, environmentId, operation);
  }

  savePromptQueue(
    queueKey: string,
    environmentId: string,
    messages: unknown[],
    expectedRevision?: number,
  ): Promise<PersistedPromptQueue> {
    return this.repos.prompts.savePromptQueue(queueKey, environmentId, messages, expectedRevision);
  }

  enqueuePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    message: unknown,
  ): Promise<PersistedPromptQueue> {
    return this.repos.prompts.enqueuePromptQueueMessage(queueKey, environmentId, message);
  }

  enqueuePromptQueueMessageIfAbsent(
    queueKey: string,
    environmentId: string,
    message: unknown,
    fingerprint?: string,
    allowNewMessage = true,
  ): Promise<{ status: "queued" | "present" | "consumed"; queue: PersistedPromptQueue | null }> {
    return this.repos.prompts.enqueuePromptQueueMessageIfAbsent(
      queueKey,
      environmentId,
      message,
      fingerprint,
      allowNewMessage,
    );
  }

  removePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    messageId: string,
  ): Promise<{ removed: unknown | null; queue: PersistedPromptQueue | null }> {
    return this.repos.prompts.removePromptQueueMessage(queueKey, environmentId, messageId);
  }

  movePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    messageId: string,
    direction: "up" | "down",
  ): Promise<PersistedPromptQueue | null> {
    return this.repos.prompts.movePromptQueueMessage(queueKey, environmentId, messageId, direction);
  }

  reservePromptQueueHeadForDispatch(
    queueKey: string,
  ): Promise<PersistedPromptQueue["inFlight"] | null> {
    return this.repos.prompts.reservePromptQueueHeadForDispatch(queueKey);
  }

  acknowledgePromptQueueDispatch(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.repos.prompts.acknowledgePromptQueueDispatch(queueKey, requestId);
  }

  markPromptQueueDispatchSubmitting(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.repos.prompts.markPromptQueueDispatchSubmitting(queueKey, requestId);
  }

  markPromptQueueDispatchSubmitted(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.repos.prompts.markPromptQueueDispatchSubmitted(queueKey, requestId);
  }

  failPromptQueueDispatch(
    queueKey: string,
    requestId: string,
    message = "Queued prompt was rejected. Edit it or retry explicitly.",
    options?: { requestIdRetired?: boolean },
  ): Promise<PersistedPromptQueue | null> {
    return this.repos.prompts.failPromptQueueDispatch(queueKey, requestId, message, options);
  }

  retryPromptQueueDispatch(queueKey: string): Promise<PersistedPromptQueue | null> {
    return this.repos.prompts.retryPromptQueueDispatch(queueKey);
  }

  deletePromptQueuesByEnvironment(environmentId: string): Promise<string[]> {
    return this.repos.prompts.deletePromptQueuesByEnvironment(environmentId);
  }

  // BuildPipelinesRepository

  setBuildPipelineTranscriptFaults(faults: BuildPipelineTranscriptFaults | null): void {
    return this.repos.buildPipelines.setBuildPipelineTranscriptFaults(faults);
  }

  setBuildPipelineTranscriptLimits(limits: Partial<BuildPipelineTranscriptLimits>): void {
    return this.repos.buildPipelines.setBuildPipelineTranscriptLimits(limits);
  }

  buildPipelineTranscriptFault(
    stage: BuildPipelineTranscriptFaultStage,
    key: string,
  ): Promise<void> {
    return this.repos.buildPipelines.buildPipelineTranscriptFault(stage, key);
  }

  buildPipelineTranscriptStats(): BuildPipelineTranscriptStats {
    return this.repos.buildPipelines.buildPipelineTranscriptStats();
  }

  getBuildPipeline(pipelineId: string): Promise<PersistedBuildPipeline | null> {
    return this.repos.buildPipelines.getBuildPipeline(pipelineId);
  }

  listBuildPipelines(projectId: string): Promise<PersistedBuildPipeline[]> {
    return this.repos.buildPipelines.listBuildPipelines(projectId);
  }

  listAllBuildPipelines(): Promise<PersistedBuildPipeline[]> {
    return this.repos.buildPipelines.listAllBuildPipelines();
  }

  saveBuildPipeline(
    pipelineId: string,
    projectId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
  ): Promise<PersistedBuildPipeline> {
    return this.repos.buildPipelines.saveBuildPipeline(
      pipelineId,
      projectId,
      environmentId,
      version,
      snapshot,
      expectedRevision,
    );
  }

  deleteBuildPipeline(pipelineId: string): Promise<void> {
    return this.repos.buildPipelines.deleteBuildPipeline(pipelineId);
  }

  deleteBuildPipelinesByEnvironment(
    environmentId: string,
    linkedPipelineId?: string,
  ): Promise<string[]> {
    return this.repos.buildPipelines.deleteBuildPipelinesByEnvironment(
      environmentId,
      linkedPipelineId,
    );
  }

  deleteBuildPipelineTranscriptsFor(pipelineId: string): Promise<void> {
    return this.repos.buildPipelines.deleteBuildPipelineTranscriptsFor(pipelineId);
  }

  commitBuildPipelineTranscript(input: TranscriptCommitInput): Promise<TranscriptCommitResult> {
    return this.repos.buildPipelines.commitBuildPipelineTranscript(input);
  }

  readBuildPipelineTranscript(
    pipelineId: string,
    session: Pick<PipelineSession, "sessionKey" | "transcript" | "messages" | "messageRevision">,
    window: TranscriptReadWindow = {},
  ): Promise<TranscriptRead> {
    return this.repos.buildPipelines.readBuildPipelineTranscript(pipelineId, session, window);
  }

  migrateBuildPipelineTranscripts(
    options: { maxPipelinesPerBatch?: number; shouldContinue?: () => boolean } = {},
  ): Promise<BuildPipelineTranscriptMigrationReport> {
    return this.repos.buildPipelines.migrateBuildPipelineTranscripts(options);
  }

  sweepBuildPipelineTranscripts(
    options: { graceMs?: number } = {},
  ): Promise<{ orphans: number; removedChunks: number; complete: boolean }> {
    return this.repos.buildPipelines.sweepBuildPipelineTranscripts(options);
  }

  // DraftsRepository

  getComposeDraft(draftKey: string): Promise<PersistedComposeDraft | null> {
    return this.repos.drafts.getComposeDraft(draftKey);
  }

  listComposeDrafts(
    ownerType: "environment" | "project",
    ownerId: string,
  ): Promise<PersistedComposeDraft[]> {
    return this.repos.drafts.listComposeDrafts(ownerType, ownerId);
  }

  saveComposeDraft(
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
    value: unknown,
    expectedRevision?: number,
  ): Promise<PersistedComposeDraft> {
    return this.repos.drafts.saveComposeDraft(
      draftKey,
      ownerType,
      ownerId,
      value,
      expectedRevision,
    );
  }

  deleteComposeDraft(draftKey: string, expectedRevision?: number): Promise<void> {
    return this.repos.drafts.deleteComposeDraft(draftKey, expectedRevision);
  }

  deleteComposeDraftsByEnvironment(environmentId: string): Promise<void> {
    return this.repos.drafts.deleteComposeDraftsByEnvironment(environmentId);
  }

  deleteComposeDraftsByProject(projectId: string): Promise<void> {
    return this.repos.drafts.deleteComposeDraftsByProject(projectId);
  }

  getFileDraft(draftKey: string): Promise<PersistedFileDraft | null> {
    return this.repos.drafts.getFileDraft(draftKey);
  }

  saveFileDraft(
    draftKey: string,
    environmentId: string,
    filePath: string,
    content: string,
    originalContent: string,
    expectedRevision?: number,
  ): Promise<PersistedFileDraft> {
    return this.repos.drafts.saveFileDraft(
      draftKey,
      environmentId,
      filePath,
      content,
      originalContent,
      expectedRevision,
    );
  }

  deleteFileDraft(draftKey: string, expectedRevision?: number): Promise<void> {
    return this.repos.drafts.deleteFileDraft(draftKey, expectedRevision);
  }

  deleteFileDraftsByEnvironment(environmentId: string): Promise<void> {
    return this.repos.drafts.deleteFileDraftsByEnvironment(environmentId);
  }

  getAgentHandoff(handoffId: string): Promise<PersistedAgentHandoff | null> {
    return this.repos.drafts.getAgentHandoff(handoffId);
  }

  saveAgentHandoff(
    handoffId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
  ): Promise<PersistedAgentHandoff> {
    return this.repos.drafts.saveAgentHandoff(handoffId, environmentId, version, snapshot);
  }

  deleteAgentHandoff(handoffId: string, environmentId: string): Promise<boolean> {
    return this.repos.drafts.deleteAgentHandoff(handoffId, environmentId);
  }

  pruneAgentHandoffs(environmentId: string, referencedHandoffIds: string[]): Promise<string[]> {
    return this.repos.drafts.pruneAgentHandoffs(environmentId, referencedHandoffIds);
  }

  deleteAgentHandoffsByEnvironment(environmentId: string): Promise<string[]> {
    return this.repos.drafts.deleteAgentHandoffsByEnvironment(environmentId);
  }

  deletePaneLayout(environmentId: string, expectedRevision?: number): Promise<void> {
    return this.repos.drafts.deletePaneLayout(environmentId, expectedRevision);
  }

  getSession(sessionId: string): Promise<Session | null> {
    return this.repos.drafts.getSession(sessionId);
  }

  getSessionsByEnvironment(environmentId: string): Promise<Session[]> {
    return this.repos.drafts.getSessionsByEnvironment(environmentId);
  }

  updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    return this.repos.drafts.updateSession(sessionId, updates);
  }

  removeSession(sessionId: string): Promise<void> {
    return this.repos.drafts.removeSession(sessionId);
  }

  removeSessionsByEnvironment(environmentId: string): Promise<string[]> {
    return this.repos.drafts.removeSessionsByEnvironment(environmentId);
  }

  disconnectEnvironmentSessions(environmentId: string): Promise<Session[]> {
    return this.repos.drafts.disconnectEnvironmentSessions(environmentId);
  }

  reorderSessions(environmentId: string, sessionIds: string[]): Promise<Session[]> {
    return this.repos.drafts.reorderSessions(environmentId, sessionIds);
  }

  saveSessionBuffer(sessionId: string, buffer: string): Promise<void> {
    return this.repos.drafts.saveSessionBuffer(sessionId, buffer);
  }

  loadSessionBuffer(sessionId: string): Promise<string | null> {
    return this.repos.drafts.loadSessionBuffer(sessionId);
  }

  deleteSessionBuffer(sessionId: string): Promise<void> {
    return this.repos.drafts.deleteSessionBuffer(sessionId);
  }

  cleanupOrphanedBuffers(): Promise<string[]> {
    return this.repos.drafts.cleanupOrphanedBuffers();
  }

  // AgentMailRepository

  setAgentMailRuntimeProvider(provider: AgentMailRepository["agentMailRuntimeProvider"]): void {
    return this.repos.agentMail.setAgentMailRuntimeProvider(provider);
  }

  setCoordinatorMailResolver(resolver: AgentMailRepository["coordinatorMailResolver"]): void {
    return this.repos.agentMail.setCoordinatorMailResolver(resolver);
  }

  resolveAgentMailRecipientTab(sender: AgentMailSender, environmentId: string): Promise<string> {
    return this.repos.agentMail.resolveAgentMailRecipientTab(sender, environmentId);
  }

  resolveUniqueAgentMailPullTabId(environmentId: string): Promise<string | null> {
    return this.repos.agentMail.resolveUniqueAgentMailPullTabId(environmentId);
  }

  listAgentMailPullTabIds(environmentId: string): Promise<string[]> {
    return this.repos.agentMail.listAgentMailPullTabIds(environmentId);
  }

  synchronizeAgentMailboxes(): Promise<void> {
    return this.repos.agentMail.synchronizeAgentMailboxes();
  }

  listAgentMailboxes(
    options: {
      projectId?: string;
      allowCrossProject?: boolean;
      q?: string;
      offset?: number;
      limit?: number;
      includeTombstoned?: boolean;
      currentEnvironmentId?: string;
      environmentId?: string;
    } = {},
  ): Promise<{ mailboxes: MailboxDescriptor[]; total: number; offset: number; limit: number }> {
    return this.repos.agentMail.listAgentMailboxes(options);
  }

  getAgentMailSummary(): Promise<AgentMailSummarySnapshot> {
    return this.repos.agentMail.getAgentMailSummary();
  }

  getAgentMailMailbox(
    environmentId: string,
    tabId: string,
    options: {
      unreadOnly?: boolean;
      offset?: number;
      limit?: number;
      incarnationId?: string;
    } = {},
  ): Promise<AgentMailMailboxSnapshot> {
    return this.repos.agentMail.getAgentMailMailbox(environmentId, tabId, options);
  }

  getAgentMailMailboxes(
    addresses: Array<{ environmentId: string; tabId: string }>,
  ): Promise<AgentMailMailboxBatchSnapshot> {
    return this.repos.agentMail.getAgentMailMailboxes(addresses);
  }

  getAgentMailInboxSnapshot(): Promise<AgentMailInboxSnapshot> {
    return this.repos.agentMail.getAgentMailInboxSnapshot();
  }

  hasUndeliveredCoordinatorRequest(
    workerEnvironmentId: string,
    workerTabId: string,
  ): Promise<boolean> {
    return this.repos.agentMail.hasUndeliveredCoordinatorRequest(workerEnvironmentId, workerTabId);
  }

  getAgentMailMessage(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.repos.agentMail.getAgentMailMessage(environmentId, tabId, messageId);
  }

  withAgentMailWorkerAdmission<T>(environmentId: string, operation: () => Promise<T>): Promise<T> {
    return this.repos.agentMail.withAgentMailWorkerAdmission(environmentId, operation);
  }

  sendAgentMail(
    sender: AgentMailSender,
    input: AgentMailSendInput,
    options: {
      newDelegation?: boolean;
      /** Structured facts for a workflow notice; ignored for any other sender. */
      notice?: AgentMailNotice;
      /**
       * Budget a workflow status notice as this stand-in sender
       * (`agentMailStatusBudgetKey`). Ignored for any other sender.
       */
      statusBudgetKey?: string;
      /**
       * Hold a scheduled wake this long so notices that land together are
       * delivered as one batch. A notice joins a window already open for the
       * recipient rather than starting its own.
       */
      coalesceMs?: number;
    } = {},
  ): Promise<AgentMailMessage> {
    return this.repos.agentMail.sendAgentMail(sender, input, options);
  }

  startRemoteWorkerBudget(
    coordinator: { environmentId: string; tabId: string },
    worker: { nodeId: string; environmentId: string; tabId: string },
  ): Promise<void> {
    return this.repos.agentMail.startRemoteWorkerBudget(coordinator, worker);
  }

  resetAgentMailBudgetForSession(
    environmentId: string,
    logicalSessionKey: string,
  ): Promise<boolean> {
    return this.repos.agentMail.resetAgentMailBudgetForSession(environmentId, logicalSessionKey);
  }

  releaseHourlyHeldAgentMail(): Promise<number> {
    return this.repos.agentMail.releaseHourlyHeldAgentMail();
  }

  replyAgentMail(
    sender: Extract<AgentMailSender, { kind: "tab" }>,
    parentMessageId: string,
    requestId: string,
    body: string,
    subject?: string,
  ): Promise<AgentMailMessage> {
    return this.repos.agentMail.replyAgentMail(sender, parentMessageId, requestId, body, subject);
  }

  ackAgentMail(environmentId: string, tabId: string, messageId: string): Promise<AgentMailMessage> {
    return this.repos.agentMail.ackAgentMail(environmentId, tabId, messageId);
  }

  markAgentMailSeen(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.repos.agentMail.markAgentMailSeen(environmentId, tabId, messageId);
  }

  promoteStoredAgentMailForMailbox(environmentId: string, tabId: string): Promise<number> {
    return this.repos.agentMail.promoteStoredAgentMailForMailbox(environmentId, tabId);
  }

  hasDelegationHeldAgentMail(
    associationId: string,
    coordinatorEnvironmentId: string,
    coordinatorTabId: string,
    workerEnvironmentId: string,
    workerTabId: string,
  ): Promise<boolean> {
    return this.repos.agentMail.hasDelegationHeldAgentMail(
      associationId,
      coordinatorEnvironmentId,
      coordinatorTabId,
      workerEnvironmentId,
      workerTabId,
    );
  }

  moveClosedCoordinatorMail(
    coordinatorId: string,
    to: { environmentId: string; tabId: string },
    owedDelegations: ReadonlySet<string>,
  ): Promise<number> {
    return this.repos.agentMail.moveClosedCoordinatorMail(coordinatorId, to, owedDelegations);
  }

  releaseOrphanedDelegationHolds(owed: ReadonlySet<string>): Promise<number> {
    return this.repos.agentMail.releaseOrphanedDelegationHolds(owed);
  }

  releaseDelegationHeldAgentMail(
    associationId: string,
    coordinatorEnvironmentId: string,
    coordinatorTabId: string,
    workerEnvironmentId: string,
    workerTabId: string,
  ): Promise<number> {
    return this.repos.agentMail.releaseDelegationHeldAgentMail(
      associationId,
      coordinatorEnvironmentId,
      coordinatorTabId,
      workerEnvironmentId,
      workerTabId,
    );
  }

  retryAgentMailInject(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.repos.agentMail.retryAgentMailInject(environmentId, tabId, messageId);
  }

  discardAgentMail(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.repos.agentMail.discardAgentMail(environmentId, tabId, messageId);
  }

  updateAgentMailboxPolicy(
    environmentId: string,
    tabId: string,
    updates: {
      inject?: "inherit" | "off" | "idle";
      mutedInbound?: boolean;
      mutedOutbound?: boolean;
    },
  ): Promise<MailboxDescriptor> {
    return this.repos.agentMail.updateAgentMailboxPolicy(environmentId, tabId, updates);
  }

  getAgentMailStatus(messageId: string): Promise<AgentMailMessageSummary> {
    return this.repos.agentMail.getAgentMailStatus(messageId);
  }

  listPendingAgentMailInjects(
    limit = 100,
    options: { includeDeferred?: boolean; includeCoalescing?: boolean } = {},
  ): Promise<PendingAgentMailInject[]> {
    return this.repos.agentMail.listPendingAgentMailInjects(limit, options);
  }

  resetAgentMailInjectBackoff(mailboxId: string): Promise<void> {
    return this.repos.agentMail.resetAgentMailInjectBackoff(mailboxId);
  }

  listInterruptedAgentMailInjects(): Promise<PendingAgentMailInject[]> {
    return this.repos.agentMail.listInterruptedAgentMailInjects();
  }

  listAgentMailSentByMailbox(
    environmentId: string,
    tabId: string,
  ): Promise<AgentMailMessageSummary[]> {
    return this.repos.agentMail.listAgentMailSentByMailbox(environmentId, tabId);
  }

  listUserSentAgentMail(): Promise<AgentMailMessageSummary[]> {
    return this.repos.agentMail.listUserSentAgentMail();
  }

  listAgentMailConversations(
    options: { participant?: string } = {},
  ): Promise<AgentMailConversationList> {
    return this.repos.agentMail.listAgentMailConversations(options);
  }

  getAgentMailConversation(
    a: string,
    b: string,
    options: { limit?: number } = {},
  ): Promise<AgentMailConversation> {
    return this.repos.agentMail.getAgentMailConversation(a, b, options);
  }

  markAgentMailConversationSeen(a: string, b: string, messageIds: string[]): Promise<number> {
    return this.repos.agentMail.markAgentMailConversationSeen(a, b, messageIds);
  }

  claimAgentMailWorkerStart(environmentId: string, messageId: string): Promise<boolean> {
    return this.repos.agentMail.claimAgentMailWorkerStart(environmentId, messageId);
  }

  beginAgentMailInject(
    mailboxId: string,
    messageId: string,
    incarnationId: string,
    verificationRequestId?: string,
    options: { joinCoalescing?: boolean } = {},
  ): Promise<AgentMailMessage | null> {
    return this.repos.agentMail.beginAgentMailInject(
      mailboxId,
      messageId,
      incarnationId,
      verificationRequestId,
      options,
    );
  }

  finishAgentMailInject(
    mailboxId: string,
    messageId: string,
    outcome:
      | { outcome: "accepted" }
      | { outcome: "held"; reason: string }
      | { outcome: "failed"; reason: "ambiguous" | "rejected" }
      /** Refused before it reached the agent: queue it again after a delay. */
      | { outcome: "retry"; reason: string }
      /** Outcome unknown: confirm `requestId` against the journal before resending. */
      | { outcome: "verify"; requestId: string },
  ): Promise<AgentMailMessage | null> {
    return this.repos.agentMail.finishAgentMailInject(mailboxId, messageId, outcome);
  }

  recoverInterruptedAgentMailInjects(): Promise<number> {
    return this.repos.agentMail.recoverInterruptedAgentMailInjects();
  }

  deleteAgentMailByProject(projectId: string): Promise<void> {
    return this.repos.agentMail.deleteAgentMailByProject(projectId);
  }

  deleteAgentMailByEnvironment(environmentId: string): Promise<void> {
    return this.repos.agentMail.deleteAgentMailByEnvironment(environmentId);
  }

  pruneAgentMail(retentionDays: number): Promise<void> {
    return this.repos.agentMail.pruneAgentMail(retentionDays);
  }

  // KanbanRepository

  getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
    return this.repos.kanban.getKanbanTasks(projectId);
  }

  getKanbanTask(taskId: string): Promise<KanbanTask | null> {
    return this.repos.kanban.getKanbanTask(taskId);
  }

  addKanbanTask(
    projectId: string,
    title: string,
    description: string,
    initial: {
      acceptanceCriteria?: string;
      status?: KanbanStatus;
      requestId?: string;
      featureBuildRequestHash?: string;
    } = {},
  ): Promise<KanbanTask> {
    return this.repos.kanban.addKanbanTask(projectId, title, description, initial);
  }

  findKanbanTaskByRequestId(projectId: string, requestId: string): Promise<KanbanTask | null> {
    return this.repos.kanban.findKanbanTaskByRequestId(projectId, requestId);
  }

  updateKanbanTask(
    taskId: string,
    updates: Partial<KanbanTask>,
    expectedProjectId?: string,
  ): Promise<KanbanTask> {
    return this.repos.kanban.updateKanbanTask(taskId, updates, expectedProjectId);
  }

  deleteKanbanTask(taskId: string): Promise<void> {
    return this.repos.kanban.deleteKanbanTask(taskId);
  }

  addKanbanComment(
    taskId: string,
    text: string,
    expectedProjectId?: string,
    requestId?: string,
  ): Promise<KanbanTask> {
    return this.repos.kanban.addKanbanComment(taskId, text, expectedProjectId, requestId);
  }

  deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
    return this.repos.kanban.deleteKanbanComment(taskId, commentId);
  }

  addKanbanImage(taskId: string, filename: string, data: string): Promise<KanbanTask> {
    return this.repos.kanban.addKanbanImage(taskId, filename, data);
  }

  addNormalizedKanbanImageForRequest(
    taskId: string,
    filename: string,
    data: string,
    requestId: string,
  ): Promise<{ task: KanbanTask; image: KanbanImage }> {
    return this.repos.kanban.addNormalizedKanbanImageForRequest(taskId, filename, data, requestId);
  }

  deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
    return this.repos.kanban.deleteKanbanImage(taskId, imageId);
  }

  getKanbanImageData(imageId: string): Promise<string> {
    return this.repos.kanban.getKanbanImageData(imageId);
  }

  getProjectNotes(projectId: string): Promise<ProjectNotes> {
    return this.repos.kanban.getProjectNotes(projectId);
  }

  saveProjectNotes(projectId: string, content: string): Promise<ProjectNotes> {
    return this.repos.kanban.saveProjectNotes(projectId, content);
  }

  getFeaturePlans(projectId: string): Promise<FeaturePlan[]> {
    return this.repos.kanban.getFeaturePlans(projectId);
  }

  createFeaturePlan(projectId: string): Promise<FeaturePlan> {
    return this.repos.kanban.createFeaturePlan(projectId);
  }

  updateFeaturePlan(featureId: string, updates: Partial<FeaturePlan>): Promise<FeaturePlan> {
    return this.repos.kanban.updateFeaturePlan(featureId, updates);
  }

  claimFeaturePlanBuild(
    featureId: string,
    taskId: string,
  ): Promise<{ claimed: boolean; feature: FeaturePlan }> {
    return this.repos.kanban.claimFeaturePlanBuild(featureId, taskId);
  }

  appendFeaturePlanMessage(
    featureId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ): Promise<FeaturePlan> {
    return this.repos.kanban.appendFeaturePlanMessage(
      featureId,
      role,
      content,
      stateApplication,
      modelId,
    );
  }

  appendFeatureStoryMessage(
    featureId: string,
    storyId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ): Promise<FeaturePlan> {
    return this.repos.kanban.appendFeatureStoryMessage(
      featureId,
      storyId,
      role,
      content,
      stateApplication,
      modelId,
    );
  }

  listAllFeaturePlans(): Promise<FeaturePlan[]> {
    return this.repos.kanban.listAllFeaturePlans();
  }

  getFeaturePlan(featureId: string): Promise<FeaturePlan | null> {
    return this.repos.kanban.getFeaturePlan(featureId);
  }

  listActiveFeaturePlanning(): Promise<FeaturePlanningRecord[]> {
    return this.repos.kanban.listActiveFeaturePlanning();
  }

  startFeaturePlanning(
    record: FeaturePlanningRecord,
  ): Promise<{ started: boolean; feature: FeaturePlan }> {
    return this.repos.kanban.startFeaturePlanning(record);
  }

  mutateFeaturePlanning<T>(
    featureId: string,
    operationId: string,
    mutator: (plan: FeaturePlan, record: FeaturePlanningRecord) => T,
  ): Promise<{ result: T; feature: FeaturePlan }> {
    return this.repos.kanban.mutateFeaturePlanning(featureId, operationId, mutator);
  }

  clearFeaturePlanning(featureId: string, operationId: string): Promise<FeaturePlan> {
    return this.repos.kanban.clearFeaturePlanning(featureId, operationId);
  }

  getLinearAuth(): Promise<LinearAuth | null> {
    return this.repos.kanban.getLinearAuth();
  }

  saveLinearAuth(apiKey: string, viewer?: LinearAuth["viewer"]): Promise<LinearAuth> {
    return this.repos.kanban.saveLinearAuth(apiKey, viewer);
  }

  clearLinearAuth(): Promise<void> {
    return this.repos.kanban.clearLinearAuth();
  }

  getLinearCompletionComment(pipelineId: string): Promise<LinearCompletionComment | null> {
    return this.repos.kanban.getLinearCompletionComment(pipelineId);
  }

  saveLinearCompletionComment(
    record: Omit<LinearCompletionComment, "updatedAt"> & { updatedAt?: string },
  ): Promise<LinearCompletionComment> {
    return this.repos.kanban.saveLinearCompletionComment(record);
  }

  getGitHubCompletionComment(pipelineId: string): Promise<GitHubCompletionComment | null> {
    return this.repos.kanban.getGitHubCompletionComment(pipelineId);
  }

  withGitHubCompletionCommentLock<T>(pipelineId: string, operation: () => Promise<T>): Promise<T> {
    return this.repos.kanban.withGitHubCompletionCommentLock(pipelineId, operation);
  }

  saveGitHubCompletionComment(
    record: Omit<GitHubCompletionComment, "updatedAt"> & { updatedAt?: string },
  ): Promise<GitHubCompletionComment> {
    return this.repos.kanban.saveGitHubCompletionComment(record);
  }

  // PreviewServicesRepository

  loadPreviewServiceStore(): Promise<LoadedPreviewServiceStore> {
    return this.repos.previewServices.loadPreviewServiceStore();
  }

  mutatePreviewServiceStore<T>(
    mutate: (store: PreviewServiceStore) => { changed: boolean; result: T },
  ): Promise<T> {
    return this.repos.previewServices.mutatePreviewServiceStore(mutate);
  }

  getPreviewBackendIdentity(): Promise<PreviewBackendIdentity> {
    return this.repos.previewServices.getPreviewBackendIdentity();
  }

  getBackendProfile(): Promise<BackendProfile> {
    return this.repos.previewServices.getBackendProfile();
  }

  updateBackendProfile(update: BackendProfileUpdate): Promise<BackendProfile> {
    return this.repos.previewServices.updateBackendProfile(update);
  }

  loadPreviewSettings(): Promise<PreviewSettings> {
    return this.repos.previewServices.loadPreviewSettings();
  }

  updatePreviewSettings(
    update: (current: PreviewSettings) => PreviewSettings,
  ): Promise<PreviewSettings> {
    return this.repos.previewServices.updatePreviewSettings(update);
  }

  // NodesRepository

  getControllerSettings(): Promise<ControllerSettingsStore> {
    return this.repos.nodes.getControllerSettings();
  }

  mutateControllerSettings<T>(
    mutate: (current: ControllerSettingsStore) => NodeStoreMutation<ControllerSettingsStore, T>,
  ): Promise<T> {
    return this.repos.nodes.mutateControllerSettings(mutate);
  }

  getPortalLayout(): Promise<PortalLayout> {
    return this.repos.nodes.getPortalLayout();
  }

  updatePortalLayout(update: PortalLayoutUpdate): Promise<PortalLayout> {
    return this.repos.nodes.updatePortalLayout(update);
  }

  loadNodeSummariesCache(): Promise<unknown> {
    return this.repos.nodes.loadNodeSummariesCache();
  }

  saveNodeSummariesCache(value: unknown): Promise<void> {
    return this.repos.nodes.saveNodeSummariesCache(value);
  }

  loadNodeMail(): Promise<unknown> {
    return this.repos.nodes.loadNodeMail();
  }

  mutateNodeMail<T>(mutate: (current: unknown) => { next: unknown; result: T }): Promise<T> {
    return this.repos.nodes.mutateNodeMail(mutate);
  }

  loadNodeActionRequests(): Promise<unknown> {
    return this.repos.nodes.loadNodeActionRequests();
  }

  saveNodeActionRequests(requests: unknown): Promise<void> {
    return this.repos.nodes.saveNodeActionRequests(requests);
  }

  loadNodeOutcomes(): Promise<unknown> {
    return this.repos.nodes.loadNodeOutcomes();
  }

  saveNodeOutcomes(records: unknown): Promise<void> {
    return this.repos.nodes.saveNodeOutcomes(records);
  }

  getNodeRegistry(): Promise<NodeRegistry> {
    return this.repos.nodes.getNodeRegistry();
  }

  mutateNodeRegistry<T>(
    mutate: (current: NodeRegistry) => NodeStoreMutation<NodeRegistry, T>,
  ): Promise<T> {
    return this.repos.nodes.mutateNodeRegistry(mutate);
  }

  getNodeAttachments(): Promise<NodeAttachments> {
    return this.repos.nodes.getNodeAttachments();
  }

  mutateNodeAttachments<T>(
    mutate: (current: NodeAttachments) => NodeStoreMutation<NodeAttachments, T>,
  ): Promise<T> {
    return this.repos.nodes.mutateNodeAttachments(mutate);
  }

  // PublicOperationsRepository

  setPublicOperationLimitsForTesting(
    limits: Partial<PublicOperationsRepository["publicOperationLimits"]>,
  ): void {
    return this.repos.publicOperations.setPublicOperationLimitsForTesting(limits);
  }

  loadPublicOperationIndex(): Promise<PublicOperationIndex> {
    return this.repos.publicOperations.loadPublicOperationIndex();
  }

  publicOperationNamespaces(now = Date.now()): Promise<{ current: string; retained: string[] }> {
    return this.repos.publicOperations.publicOperationNamespaces(now);
  }

  admitPublicOperation(
    input: AdmitPublicOperationInput,
  ): Promise<{ record: PublicOperationRecord; replayed: boolean }> {
    return this.repos.publicOperations.admitPublicOperation(input);
  }

  updatePublicOperation(
    operationId: string,
    update: (record: PublicOperationRecord) => PublicOperationRecord | null,
  ): Promise<PublicOperationRecord | null> {
    return this.repos.publicOperations.updatePublicOperation(operationId, update);
  }

  getPublicOperation(operationId: string): Promise<PublicOperationLookup> {
    return this.repos.publicOperations.getPublicOperation(operationId);
  }

  findPublicOperationByKey(requestKey: string): Promise<PublicOperationRecord | null> {
    return this.repos.publicOperations.findPublicOperationByKey(requestKey);
  }

  claimStalePublicOperation(
    operationId: string,
    generation: string,
  ): Promise<PublicOperationRecord | null> {
    return this.repos.publicOperations.claimStalePublicOperation(operationId, generation);
  }

  findPublicOperationsByRequest(
    requestId: string,
    filter: { authority: PublicAuthority; action?: PublicActionName; namespace?: string },
  ): Promise<{ records: PublicOperationRecord[]; expiredNamespace?: string }> {
    return this.repos.publicOperations.findPublicOperationsByRequest(requestId, filter);
  }

  listSettledPublicOperationsChangedSince(
    authority: PublicAuthority,
    sinceMs: number,
    limit: number,
    window?: { until: number; after?: AttentionPosition },
  ): Promise<{ records: PublicOperationRecord[]; total: number }> {
    return this.repos.publicOperations.listSettledPublicOperationsChangedSince(
      authority,
      sinceMs,
      limit,
      window,
    );
  }

  listActivePublicOperations(): Promise<PublicOperationRecord[]> {
    return this.repos.publicOperations.listActivePublicOperations();
  }

  collectPublicOperations(now = Date.now()): Promise<{ retired: string[]; kept: string[] }> {
    return this.repos.publicOperations.collectPublicOperations(now);
  }

  updateProjectAtRevision(
    projectId: string,
    expectedRevision: string | undefined,
    updates: Partial<Pick<Project, "name" | "gitUrl" | "localPath" | "folder">>,
  ): Promise<Project> {
    return this.repos.publicOperations.updateProjectAtRevision(
      projectId,
      expectedRevision,
      updates,
    );
  }

  patchRepositorySettingsAtRevision(
    projectId: string,
    expectedRevision: string | undefined,
    apply: (current: RepositoryConfig) => RepositoryConfig,
  ): Promise<RepositoryConfig> {
    return this.repos.publicOperations.patchRepositorySettingsAtRevision(
      projectId,
      expectedRevision,
      apply,
    );
  }

  patchEnvironmentSettingsAtRevision(
    environmentId: string,
    expectedRevision: string | undefined,
    apply: (
      current: {
        portMappings?: PortMapping[];
        allowedDomains?: string[];
        agentSettings?: AgentSettingsTier;
      },
      environment: Environment,
    ) => {
      portMappings?: PortMapping[];
      allowedDomains?: string[];
      agentSettings?: AgentSettingsTier;
    },
  ): Promise<Environment> {
    return this.repos.publicOperations.patchEnvironmentSettingsAtRevision(
      environmentId,
      expectedRevision,
      apply,
    );
  }

  // CoordinatorsRepository and AgentAccountsRepository

  agentAccountsDirectory(): string {
    return this.repos.agentAccounts.agentAccountsDirectory();
  }

  loadAgentAccounts(): Promise<AgentAccountStore> {
    return this.repos.agentAccounts.loadAgentAccounts();
  }

  mutateAgentAccounts<T>(
    mutate: (
      store: AgentAccountStore,
    ) => { store: AgentAccountStore; result: T } | Promise<{ store: AgentAccountStore; result: T }>,
  ): Promise<T> {
    return this.repos.agentAccounts.mutateAgentAccounts(mutate);
  }

  getCoordinatorWorkspace(projectId: string): Promise<CoordinatorWorkspace | null> {
    return this.repos.coordinators.getCoordinatorWorkspace(projectId);
  }

  getCoordinatorWorkspaceById(coordinatorId: string): Promise<CoordinatorWorkspace | null> {
    return this.repos.coordinators.getCoordinatorWorkspaceById(coordinatorId);
  }

  listCoordinatorWorkspaces(): Promise<CoordinatorWorkspace[]> {
    return this.repos.coordinators.listCoordinatorWorkspaces();
  }

  listCoordinatorWorkflowAssociations(
    projectId: string,
  ): Promise<CoordinatorWorkflowAssociation[]> {
    return this.repos.coordinators.listCoordinatorWorkflowAssociations(projectId);
  }

  listAllCoordinatorWorkflowAssociations(): Promise<CoordinatorWorkflowAssociation[]> {
    return this.repos.coordinators.listAllCoordinatorWorkflowAssociations();
  }

  getCoordinatorReconciliationState(): Promise<{
    workspaces: CoordinatorWorkspace[];
    workflows: CoordinatorWorkflowAssociation[];
  }> {
    return this.repos.coordinators.getCoordinatorReconciliationState();
  }

  mutateCoordinatorWorkspaceWithComposeDrafts(
    projectId: string,
    mutate: (
      current: CoordinatorWorkspace | null,
      drafts: Awaited<ReturnType<StorageService["listComposeDrafts"]>>,
    ) => CoordinatorWorkspace | null,
  ): Promise<CoordinatorWorkspace | null> {
    return this.repos.coordinators.mutateCoordinatorWorkspaceWithComposeDrafts(projectId, mutate);
  }

  mutateCoordinatorWorkspace(
    projectId: string,
    mutate: (current: CoordinatorWorkspace | null) => CoordinatorWorkspace | null,
  ): Promise<CoordinatorWorkspace | null> {
    return this.repos.coordinators.mutateCoordinatorWorkspace(projectId, mutate);
  }

  saveCoordinatorWorkflowAssociation(
    association: CoordinatorWorkflowAssociation,
  ): Promise<CoordinatorWorkflowAssociation> {
    return this.repos.coordinators.saveCoordinatorWorkflowAssociation(association);
  }

  reserveCoordinatorWorkflowAssociation(
    association: CoordinatorWorkflowAssociation,
  ): Promise<{ association: CoordinatorWorkflowAssociation; claimed: boolean }> {
    return this.repos.coordinators.reserveCoordinatorWorkflowAssociation(association);
  }

  completeCoordinatorWorkflowAssociation(
    associationId: string,
    resourceId: string,
  ): Promise<CoordinatorWorkflowAssociation> {
    return this.repos.coordinators.completeCoordinatorWorkflowAssociation(
      associationId,
      resourceId,
    );
  }

  addCoordinatorWorkflowRequestAlias(
    associationId: string,
    coordinatorId: string,
    conversationId: string,
    requestId: string,
    payloadHash: string,
  ): Promise<CoordinatorWorkflowAssociation> {
    return this.repos.coordinators.addCoordinatorWorkflowRequestAlias(
      associationId,
      coordinatorId,
      conversationId,
      requestId,
      payloadHash,
    );
  }

  openCoordinatorDelegation(
    associationId: string,
    workerTabId: string,
    at = new Date().toISOString(),
  ): Promise<CoordinatorWorkflowAssociation | null> {
    return this.repos.coordinators.openCoordinatorDelegation(associationId, workerTabId, at);
  }

  listOpenCoordinatorDelegations(): Promise<CoordinatorWorkflowAssociation[]> {
    return this.repos.coordinators.listOpenCoordinatorDelegations();
  }

  listUnwokenCoordinatorDelegations(): Promise<CoordinatorWorkflowAssociation[]> {
    return this.repos.coordinators.listUnwokenCoordinatorDelegations();
  }

  closeCoordinatorDelegation(
    associationId: string,
    state: "completed" | "failed" | "stopped",
    at = new Date().toISOString(),
  ): Promise<CoordinatorWorkflowAssociation | null> {
    return this.repos.coordinators.closeCoordinatorDelegation(associationId, state, at);
  }

  prepareCoordinatorDelegationWake(
    associationId: string,
    wakeKind: "report" | "notice",
  ): Promise<CoordinatorWorkflowAssociation | null> {
    return this.repos.coordinators.prepareCoordinatorDelegationWake(associationId, wakeKind);
  }

  markCoordinatorDelegationWoken(
    associationId: string,
    at = new Date().toISOString(),
  ): Promise<void> {
    return this.repos.coordinators.markCoordinatorDelegationWoken(associationId, at);
  }

  updateCoordinatorWorkflowAssociation(
    associationId: string,
    mutate: (association: CoordinatorWorkflowAssociation) => boolean,
  ): Promise<CoordinatorWorkflowAssociation | null> {
    return this.repos.coordinators.updateCoordinatorWorkflowAssociation(associationId, mutate);
  }

  markCoordinatorWorkflowNotified(associationId: string, revision: number): Promise<void> {
    return this.repos.coordinators.markCoordinatorWorkflowNotified(associationId, revision);
  }

  adoptCoordinatorWorkflowAssociation(
    projectId: string,
    coordinatorId: string,
    associationId: string,
    conversationId: string,
    options: { force?: boolean } = {},
  ): Promise<CoordinatorWorkflowAssociation> {
    return this.repos.coordinators.adoptCoordinatorWorkflowAssociation(
      projectId,
      coordinatorId,
      associationId,
      conversationId,
      options,
    );
  }

  coordinatorAttachmentDirectory(coordinatorId: string, conversationId: string): string {
    return this.repos.coordinators.coordinatorAttachmentDirectory(coordinatorId, conversationId);
  }

  pruneCoordinatorAttachmentDirectories(
    coordinatorId: string,
    retainedConversationIds: ReadonlySet<string>,
  ): Promise<void> {
    return this.repos.coordinators.pruneCoordinatorAttachmentDirectories(
      coordinatorId,
      retainedConversationIds,
    );
  }

  writeCoordinatorAttachment(
    coordinatorId: string,
    conversationId: string,
    filename: string,
    base64Data: string,
  ): Promise<string> {
    return this.repos.coordinators.writeCoordinatorAttachment(
      coordinatorId,
      conversationId,
      filename,
      base64Data,
    );
  }

  deleteCoordinatorByProject(projectId: string): Promise<void> {
    return this.repos.coordinators.deleteCoordinatorByProject(projectId);
  }
}
