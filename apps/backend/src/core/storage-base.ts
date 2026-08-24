import * as shared from "./storage-shared.js";
import {
  MAX_JSON_BACKUPS,
  PROMPT_QUEUE_CLAIM_LEASE_MS,
  RESOURCE_MANIFEST_KINDS,
  createHash,
  exists,
  fs,
  isCanonicalUuid,
  isMissingFileError,
  isRecord,
  path,
  randomBytes,
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

export abstract class StorageBase {
  protected readonly dataDir: string;
  /** Process identity: client revision knowledge never crosses this boundary. */
  protected readonly resourceGeneration = randomBytes(16).toString("hex");
  protected writeQueue = Promise.resolve();
  protected projectMutationQueue: Promise<unknown> = Promise.resolve();
  protected readonly projectCreationMutationQueues = new Map<string, Promise<unknown>>();
  protected environmentMutationQueue: Promise<unknown> = Promise.resolve();
  protected configMutationQueue: Promise<unknown> = Promise.resolve();
  protected openCodeModelCatalogMutationQueue: Promise<unknown> = Promise.resolve();
  protected agentModelCatalogMutationQueue: Promise<unknown> = Promise.resolve();
  protected githubCompletionCommentMutationQueue: Promise<unknown> = Promise.resolve();
  protected featurePlanMutation: Promise<unknown> = Promise.resolve();
  protected paneLayoutMutation: Promise<unknown> = Promise.resolve();
  protected loopedReviewMutation: Promise<unknown> = Promise.resolve();
  protected multiReviewMutation: Promise<unknown> = Promise.resolve();
  protected buildPipelineMutation: Promise<unknown> = Promise.resolve();
  protected nativeAgentSessionMutation: Promise<unknown> = Promise.resolve();
  protected agentInteractionJournalMutation: Promise<unknown> = Promise.resolve();
  protected promptQueueMutation: Promise<unknown> = Promise.resolve();
  protected promptQueueClaimRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  protected composeDraftMutation: Promise<unknown> = Promise.resolve();
  protected fileDraftMutation: Promise<unknown> = Promise.resolve();
  protected kanbanMutation: Promise<unknown> = Promise.resolve();
  protected agentHandoffMutation: Promise<unknown> = Promise.resolve();
  protected changeListener: ResourceChangeListener | null = null;
  protected changeRevision = 0;
  protected abstract recoverExpiredPromptQueueClaims(): Promise<void>;
  protected abstract promptQueueMessageFingerprint(message: unknown): string;
  protected abstract deleteComposeDraftsByProject(projectId: string): Promise<void>;
  protected abstract deleteSessionBuffer(sessionId: string): Promise<void>;
  /**
   * Parsed-JSON read cache for the hot stores, keyed by file path and
   * validated against an (inode, size, mtime) fingerprint on every read.
   *
   * Other backend processes may share this data directory — that is what the
   * cross-process mutation lock files exist for — so the cache can never
   * simply trust itself. A cheap `fs.stat` per read replaces the full
   * read-and-parse in the steady state while still observing every foreign
   * write: our own atomic writes rename a fresh temp file into place (new
   * inode), and an in-place foreign write moves size/mtime.
   */
  protected readonly jsonReadCache = new Map<string, { fingerprint: string; value: unknown }>();
  protected readonly promptQueueClaimLeaseMs: number;

  constructor(dataDir: string, options: { promptQueueClaimLeaseMs?: number } = {}) {
    this.dataDir = dataDir;
    this.promptQueueClaimLeaseMs = options.promptQueueClaimLeaseMs ?? PROMPT_QUEUE_CLAIM_LEASE_MS;
    if (!Number.isFinite(this.promptQueueClaimLeaseMs) || this.promptQueueClaimLeaseMs <= 0) {
      throw new Error("Prompt queue claim lease must be positive");
    }
  }

  /**
   * Installs the sink that broadcasts persistent mutations to connected
   * clients. Kept as a setter rather than a constructor argument because the
   * gateway that ultimately delivers these does not exist yet when the backend
   * builds its storage service.
   */
  setResourceChangeListener(listener: ResourceChangeListener | null): void {
    this.changeListener = listener;
  }

  /**
   * Announces a committed mutation. Called only after the write has landed, so
   * a client that refetches in response is guaranteed to observe the new value
   * rather than race the write it was told about.
   */
  protected announce(resource: ResourceKind, id: string, projectId?: string): void {
    const listener = this.changeListener;
    if (!listener) return;
    this.changeRevision += 1;
    try {
      listener({
        resource,
        id,
        revision: this.changeRevision,
        ...(projectId ? { projectId } : {}),
      });
    } catch (error) {
      // A broken client transport must never fail the mutation that succeeded.
      console.error("[Storage] Resource change listener threw:", error);
    }
  }

  /**
   * Publish a changed provider-authoritative native-session projection.
   *
   * Unlike the durable identity record, transcript and turn state live in the
   * provider. The native runtime first commits the new bounded projection to
   * its cache and only then calls this method, preserving the same
   * announce-after-commit ordering as file-backed resources.
   */
  announceNativeAgentSessionProjection(environmentId: string): void {
    this.announce("native-agent-session", environmentId);
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getLogDirectory(): string {
    return path.join(this.dataDir, "logs");
  }

  protected file(name: string): string {
    return path.join(this.dataDir, name);
  }

  protected projectsFile(): string {
    return this.file("projects.json");
  }

  protected environmentsFile(): string {
    return this.file("environments.json");
  }

  protected configFile(): string {
    return this.file("config.json");
  }

  protected agentPlatformsFile(): string {
    return this.file("agent-platforms.json");
  }

  protected openCodeModelCatalogFile(): string {
    return this.file("opencode-model-catalog.json");
  }

  protected agentModelCatalogFile(): string {
    return this.file("agent-model-catalog.json");
  }

  protected sessionsFile(): string {
    return this.file("sessions.json");
  }

  protected paneLayoutsFile(): string {
    return this.file("pane-layouts.json");
  }

  protected loopedReviewsFile(): string {
    return this.file("looped-reviews.json");
  }

  protected multiReviewsFile(): string {
    return this.file("multi-reviews.json");
  }

  protected buildPipelinesFile(): string {
    return this.file("build-pipelines.json");
  }

  protected nativeAgentSessionsFile(): string {
    return this.file("native-agent-sessions.json");
  }

  protected agentInteractionJournalFile(): string {
    return this.file("agent-interaction-resolution-journal.json");
  }

  protected promptQueuesFile(): string {
    return this.file("prompt-queues.json");
  }

  protected composeDraftsFile(): string {
    return this.file("compose-drafts.json");
  }

  protected fileDraftsFile(): string {
    return this.file("file-drafts.json");
  }

  protected agentHandoffsFile(): string {
    return this.file("agent-handoffs.json");
  }

  protected kanbanFile(): string {
    return this.file("kanban.json");
  }

  protected projectNotesFile(): string {
    return this.file("project-notes.json");
  }

  protected featurePlansFile(): string {
    return this.file("feature-plans.json");
  }

  protected resourceManifestFile(resource: ResourceManifestKind): string {
    switch (resource) {
      case "project":
        return this.projectsFile();
      case "environment":
        return this.environmentsFile();
      case "session":
        return this.sessionsFile();
      case "config":
        return this.configFile();
      case "kanban":
        return this.kanbanFile();
      case "project-notes":
        return this.projectNotesFile();
      case "feature-plan":
        return this.featurePlansFile();
      case "pane-layout":
        return this.paneLayoutsFile();
      case "looped-review":
        return this.loopedReviewsFile();
      case "multi-review":
        return this.multiReviewsFile();
      case "build-pipeline":
        return this.buildPipelinesFile();
      case "prompt-queue":
        return this.promptQueuesFile();
    }
  }

  /**
   * Returns an opaque, content-free revision for one authoritative store.
   *
   * The JSON writer atomically renames a fresh inode into place. Combining the
   * inode with size and timestamps therefore detects both this process's writes
   * and writes made by another backend sharing the same data directory, without
   * reading or hashing user content.
   */
  async getResourceSnapshotRevision(
    resource: ResourceManifestKind,
  ): Promise<ResourceSnapshotRevision> {
    const filePath = this.resourceManifestFile(resource);
    let fingerprint: string;
    try {
      const stat = await fs.stat(filePath, { bigint: true });
      fingerprint = [resource, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fingerprint = `${resource}:missing`;
    }
    return createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  }

  getResourceGeneration(): string {
    return this.resourceGeneration;
  }

  async getResourceRevisionManifest(
    knownGeneration?: string,
    knownRevisions: Partial<ResourceRevisionMap> = {},
  ): Promise<ResourceRevisionManifest> {
    const entries = await Promise.all(
      RESOURCE_MANIFEST_KINDS.map(
        async (resource) => [resource, await this.getResourceSnapshotRevision(resource)] as const,
      ),
    );
    const current = Object.fromEntries(entries) as ResourceRevisionMap;
    const reset = knownGeneration !== this.resourceGeneration;
    const revisions: Partial<ResourceRevisionMap> = {};
    for (const resource of RESOURCE_MANIFEST_KINDS) {
      if (reset || knownRevisions[resource] !== current[resource]) {
        revisions[resource] = current[resource];
      }
    }
    return { generation: this.resourceGeneration, reset, revisions };
  }

  /**
   * Revision-aware wrapper for existing snapshot commands. Their legacy shape
   * remains unchanged unless the caller supplies manifest knowledge.
   */
  async readConditionalResourceSnapshot<T>(
    resource: ResourceManifestKind,
    knownGeneration: string,
    knownRevision: ResourceSnapshotRevision,
    load: () => Promise<T> | T,
  ): Promise<ConditionalResourceSnapshot<T>> {
    const revision = await this.getResourceSnapshotRevision(resource);
    if (knownGeneration === this.resourceGeneration && knownRevision === revision) {
      return {
        status: "unchanged",
        generation: this.resourceGeneration,
        revision,
      };
    }
    const snapshot = await load();
    // Deliberately publish the pre-read revision. If a concurrent writer lands
    // during the read, the next event/manifest comparison still sees a mismatch
    // instead of incorrectly blessing a potentially older body as current.
    return {
      status: "changed",
      generation: this.resourceGeneration,
      revision,
      snapshot,
    };
  }

  protected linearAuthFile(): string {
    return this.file("linear-auth.json");
  }

  protected linearCompletionCommentsFile(): string {
    return this.file("linear-completion-comments.json");
  }

  protected githubCompletionCommentsFile(): string {
    return this.file("github-completion-comments.json");
  }

  protected githubCompletionCommentLockTarget(pipelineId: string): string {
    const key = createHash("sha256").update(pipelineId).digest("hex");
    return this.file(path.join("github-completion-comment-locks", key));
  }

  protected buffersDir(): string {
    return path.join(this.dataDir, "buffers");
  }

  protected bufferFile(sessionId: string): string {
    return path.join(this.buffersDir(), `${sessionId}.txt`);
  }

  protected kanbanImagesDir(): string {
    return path.join(this.dataDir, "kanban-images");
  }

  protected kanbanImageFile(imageId: string): string {
    if (!isCanonicalUuid(imageId)) {
      throw new Error("Kanban image ID is invalid");
    }
    return path.join(this.kanbanImagesDir(), `${imageId}.webp`);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.recoverExpiredPromptQueueClaims();
  }

  protected async writeAtomic(
    filePath: string,
    contents: string,
    makeBackup = true,
    mode?: number,
    refreshRecoveryBackup = false,
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomUUID()}.tmp`,
    );
    const recoveryTempPath = refreshRecoveryBackup
      ? path.join(
          path.dirname(filePath),
          `.${path.basename(filePath)}.recovery.${randomUUID()}.tmp`,
        )
      : null;

    await this.enqueueWrite(async () => {
      await fs.writeFile(tempPath, contents, mode === undefined ? undefined : { mode });
      if (recoveryTempPath) {
        // Volatile environment updates deliberately do not rotate five
        // historical backups, but they still need one current, valid recovery
        // point. Write the same validated snapshot to .bak.1 before publishing
        // the primary so corruption cannot roll structural fields back.
        await fs.writeFile(recoveryTempPath, contents, mode === undefined ? undefined : { mode });
      }
      if (mode !== undefined) {
        await fs.chmod(tempPath, mode);
      }
      if (mode !== undefined && (await exists(filePath))) {
        // Backups of sensitive files must inherit the restricted mode too.
        await fs.chmod(filePath, mode);
      }
      if (makeBackup && (await exists(filePath))) {
        await this.rotateBackups(filePath, mode);
      }
      if (recoveryTempPath) {
        await fs.rename(recoveryTempPath, this.backupPath(filePath, 1));
      }
      await fs.rename(tempPath, filePath);
      // The next read must re-validate against the file we just renamed in.
      this.jsonReadCache.delete(filePath);
      if (mode !== undefined) {
        await fs.chmod(filePath, mode);
      }
    }).catch(async (error) => {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      if (recoveryTempPath) {
        await fs.rm(recoveryTempPath, { force: true }).catch(() => undefined);
      }
      throw error;
    });
  }

  protected enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected enqueueEnvironmentMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireEnvironmentMutationLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.environmentMutationQueue.then(run, run);
    this.environmentMutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Serializes every projects.json read-modify-write in this process and across
   * backend processes sharing the same data directory.
   */
  protected enqueueProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(this.projectsFile(), "project storage");
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.projectMutationQueue.then(run, run);
    this.projectMutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Reserves one canonical local path for the complete repository creation
   * transaction. The hashed lock filename avoids putting user paths in storage
   * or logs while still coordinating backend processes that share dataDir.
   *
   * The timings are sized for the critical section rather than for a JSON
   * write: creation spans `git init`, a commit, `gh repo create` and a push,
   * whose timeouts total 310s. A waiter must therefore outlast a legitimate
   * holder, and the stale threshold must survive a holder whose event loop
   * stalls — otherwise two backends enter and one rolls back the other's work.
   */
  protected static readonly PROJECT_CREATION_LOCK_STALE_MS = 90_000;
  protected static readonly PROJECT_CREATION_LOCK_TIMEOUT_MS = 360_000;

  async withProjectCreationLock<T>(
    canonicalProjectPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = createHash("sha256").update(canonicalProjectPath).digest("hex");
    const target = this.file(path.join("project-creation-locks", key));
    const previous = this.projectCreationMutationQueues.get(key) ?? Promise.resolve();
    const run = async () => {
      const release = await this.acquireMutationLock(target, "project creation", {
        staleMs: StorageBase.PROJECT_CREATION_LOCK_STALE_MS,
        acquireTimeoutMs: StorageBase.PROJECT_CREATION_LOCK_TIMEOUT_MS,
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.projectCreationMutationQueues.set(key, settled);
    void settled.finally(() => {
      if (this.projectCreationMutationQueues.get(key) === settled) {
        this.projectCreationMutationQueues.delete(key);
      }
    });
    return next;
  }

  protected enqueueConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireConfigMutationLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.configMutationQueue.then(run, run);
    this.configMutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected enqueueGitHubCompletionCommentMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.githubCompletionCommentsFile(),
        "GitHub completion comment storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.githubCompletionCommentMutationQueue.then(run, run);
    this.githubCompletionCommentMutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected enqueueLoopedReviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.loopedReviewsFile(),
        "looped review workflow storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.loopedReviewMutation.then(run, run);
    this.loopedReviewMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected enqueueMultiReviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.multiReviewsFile(),
        "multi review workflow storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.multiReviewMutation.then(run, run);
    this.multiReviewMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Serializes build pipeline writes across backend processes sharing this data
   * directory. The cross-process lock matters more here than the in-process
   * queue: two renderers driving the same pipeline is precisely the race the
   * compare-and-swap revision exists to reject, and it can only reject it if the
   * read-modify-write is atomic.
   */
  protected enqueueBuildPipelineMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.buildPipelinesFile(),
        "build pipeline storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.buildPipelineMutation.then(run, run);
    this.buildPipelineMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Serializes every native-agent-sessions.json read-modify-write in this
   * process and across backend processes sharing the same data directory.
   *
   * The acquire timeout is sized for the critical section rather than for a
   * JSON write, like `withProjectCreationLock` above. This lock is deliberately
   * held across provider I/O: a prompt dispatch keeps it until the provider has
   * acknowledged the request id, and `getOrCreateNativeAgentSession` keeps it
   * across the external session create so two processes cannot mint two
   * provider sessions for one logical key. Those bound at ~90s (the bridge
   * prompt/attach budget) and ~122s (four 30s ACP create attempts plus backoff)
   * respectively, so the 20s default would fail a second process that is
   * waiting on a perfectly healthy holder — and the caller most exposed to that
   * is environment deletion, whose session cleanup is best-effort and would
   * therefore leave the deleted environment's record, provider session id and
   * pending prompt behind.
   *
   * This only extends patience with a *live* holder. A holder that dies stops
   * heartbeating, so the unchanged 15s stale threshold still reclaims the lock.
   */
  protected static readonly NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS = 180_000;

  protected enqueueNativeAgentSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.nativeAgentSessionsFile(),
        "native agent session storage",
        {
          acquireTimeoutMs: StorageBase.NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS,
        },
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.nativeAgentSessionMutation.then(run, run);
    this.nativeAgentSessionMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected enqueueAgentInteractionJournalMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.agentInteractionJournalFile(),
        "agent interaction journal storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.agentInteractionJournalMutation.then(run, run);
    this.agentInteractionJournalMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected enqueuePaneLayoutMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(this.paneLayoutsFile(), "pane layout storage");
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.paneLayoutMutation.then(run, run);
    this.paneLayoutMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * `staleMs` and `acquireTimeoutMs` must both exceed the critical section they
   * guard. The defaults suit a JSON read-modify-write; a caller that holds the
   * lock across child processes has to raise them, or a waiter will steal the
   * lock from a live holder whose event loop merely stalled (machine sleep is
   * the realistic case) and both will enter at once.
   */
  protected async acquireMutationLock(
    targetPath: string,
    description: string,
    options: { staleMs?: number; acquireTimeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    const staleMs = options.staleMs ?? 15_000;
    const acquireTimeoutMs = options.acquireTimeoutMs ?? 20_000;
    const heartbeatMs = Math.max(1_000, Math.floor(staleMs / 3));
    const lockPath = `${targetPath}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + acquireTimeoutMs;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    while (true) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(token, "utf8");
        } catch (error) {
          await handle.close();
          await fs.rm(lockPath, { force: true });
          throw error;
        }
        const heartbeat = setInterval(() => {
          void handle.utimes(new Date(), new Date()).catch(() => undefined);
        }, heartbeatMs);
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          await handle.close();
          const currentToken = await fs.readFile(lockPath, "utf8").catch(() => null);
          if (currentToken === token) await fs.rm(lockPath, { force: true });
        };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "EEXIST") throw error;
        const stat = await fs.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > staleMs) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${description} lock`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  protected async acquireConfigMutationLock(): Promise<() => Promise<void>> {
    return this.acquireMutationLock(this.configFile(), "configuration storage");
  }

  protected async acquireEnvironmentMutationLock(): Promise<() => Promise<void>> {
    return this.acquireMutationLock(this.environmentsFile(), "environment storage");
  }

  protected backupPath(filePath: string, index: number): string {
    return path.join(path.dirname(filePath), `${path.basename(filePath)}.bak.${index}`);
  }

  protected async rotateBackups(filePath: string, mode?: number): Promise<void> {
    for (let index = MAX_JSON_BACKUPS - 1; index >= 1; index -= 1) {
      const current = this.backupPath(filePath, index);
      const next = this.backupPath(filePath, index + 1);
      if (await exists(next)) await fs.rm(next, { force: true });
      if (await exists(current)) {
        if (mode !== undefined) await fs.chmod(current, mode);
        await fs.rename(current, next);
      }
    }

    const first = this.backupPath(filePath, 1);
    if (await exists(first)) await fs.rm(first, { force: true });
    await fs.copyFile(filePath, first);
    if (mode !== undefined) await fs.chmod(first, mode);
  }

  /**
   * Newest-first walk of the retained backups. Returns a box rather than the
   * value itself so callers can tell "recovered `null`/`[]` from a backup"
   * apart from "no backup was readable".
   */
  protected async recoverJsonFromBackups<T>(filePath: string): Promise<{ value: T } | null> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(filePath, index);
      if (!(await exists(backup))) continue;
      try {
        return { value: JSON.parse(await fs.readFile(backup, "utf8")) as T };
      } catch {
        continue;
      }
    }
    return null;
  }

  protected async loadJson<T>(filePath: string, fallback: () => T): Promise<T> {
    if (!(await exists(filePath))) return fallback();

    try {
      const raw = await fs.readFile(filePath, "utf8");
      if (!raw.trim()) return fallback();
      return JSON.parse(raw) as T;
    } catch {
      const recovered = await this.recoverJsonFromBackups<T>(filePath);
      return recovered ? recovered.value : fallback();
    }
  }

  /**
   * Stat-validated cached variant of {@link loadJson} for the stores that are
   * read on nearly every command. Returns a clone so callers can mutate the
   * result (every mutation path does) without corrupting the cached value.
   *
   * The stat happens *before* the read: if a foreign write lands in between,
   * the fresh content is cached under the stale fingerprint, which merely
   * costs one extra re-read on the next access — never a stale result.
   *
   * Only a genuinely absent file yields the fallback; see the stat catch.
   */
  protected async loadJsonCached<T>(filePath: string, fallback: () => T): Promise<T> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      this.jsonReadCache.delete(filePath);
      if (!isMissingFileError(error)) {
        // A stat that fails for a reason other than "not there" is no evidence
        // that the store is empty. Handing back the fallback would show the
        // user zero environments while their data sits intact on disk, and the
        // next mutation would load that empty list, append to it and persist it
        // over the real file. Take the same backup ladder a corrupt primary
        // takes, and surface the failure when nothing is readable.
        const recovered = await this.recoverJsonFromBackups<T>(filePath);
        if (recovered) return recovered.value;
        throw error;
      }
      return fallback();
    }
    const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this.jsonReadCache.get(filePath);
    if (cached && cached.fingerprint === fingerprint) {
      return structuredClone(cached.value) as T;
    }
    const value = await this.loadJson(filePath, fallback);
    this.jsonReadCache.set(filePath, { fingerprint, value: structuredClone(value) });
    return value;
  }

  /**
   * `backup: false` skips the five-file backup rotation. Reserved for
   * high-churn writes that only refresh volatile activity fields (lease
   * renewals, activity timestamps): rotating backups on every one of those
   * costs ~13 extra fs operations per write and makes every retained backup a
   * copy of a snapshot that differs only in timestamps. Structural mutations
   * must keep the default so the backups stay useful for corruption recovery.
   */
  protected async saveJson(
    filePath: string,
    value: unknown,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    await this.writeAtomic(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      options.backup ?? true,
      undefined,
      options.backup === false,
    );
  }

  protected async saveSensitiveJson(
    filePath: string,
    value: unknown,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    await this.writeAtomic(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      options.backup ?? true,
      0o600,
      options.backup === false,
    );
  }

  /**
   * Removes records from every retained backup of a sensitive JSON file.
   *
   * Rotating the primary file leaves the deleted records readable in its
   * backups, so a delete that is meant to remove user content — prompt text,
   * pasted attachments, review findings — is not complete until the backups
   * agree. Call while still holding the file's mutation lock.
   *
   * `keep` receives each stored entry; anything it rejects is dropped, so a
   * caller passes the same predicate it used on the primary file.
   */
  protected async scrubSensitiveJsonBackups(
    filePath: string,
    keep: (storedId: string, record: unknown) => boolean,
  ): Promise<void> {
    await this.transformSensitiveJsonBackups(filePath, (parsed) =>
      Object.fromEntries(
        Object.entries(parsed).filter(([storedId, record]) => keep(storedId, record)),
      ),
    );
  }

  /** Rewrites every retained sensitive backup while preserving its record shape. */
  protected async transformSensitiveJsonBackups(
    filePath: string,
    transform: (records: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(filePath, index);
      if (!(await exists(backup))) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(backup, "utf8")) as Record<string, unknown>;
        if (!isRecord(parsed)) throw new Error("Backup is not a record");
        const sanitized = transform(parsed);
        await this.writeAtomic(backup, `${JSON.stringify(sanitized, null, 2)}\n`, false, 0o600);
      } catch {
        // A corrupt backup cannot be proven free of the deleted records.
        await fs.rm(backup, { force: true });
      }
    }
  }

  protected async scrubPendingNativeAgentDispatchBackups(
    key: string,
    requestId: string,
  ): Promise<void> {
    await this.transformSensitiveJsonBackups(this.nativeAgentSessionsFile(), (records) => {
      const stored = records[key];
      if (!isRecord(stored)) return records;
      const pending = stored.pendingDispatch;
      if (!isRecord(pending) || pending.requestId !== requestId) return records;
      return {
        ...records,
        [key]: { ...stored, pendingDispatch: undefined },
      };
    });
  }
}
