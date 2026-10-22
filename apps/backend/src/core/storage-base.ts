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
import { AsyncLocalStorage } from "node:async_hooks";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { BACKUP_CHECK_INTERVAL_MS, takeHourlySnapshotIfDue } from "./storage-backups.js";
import { StoreCorruptError, type RowUpdate, type StorageDatabase } from "./storage-database.js";
import {
  commitWithLegacyJsonCleanup,
  type LegacyJsonCleanup,
  databaseStoreForPath,
  hasLegacyJsonStore,
  openBackendDatabase,
  pruneRemovedContent,
  replayLegacyJsonCleanup,
  scrubLegacyJsonStore,
  storeLayout,
} from "./storage-stores.js";
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
type ScopedResourceRevisionManifest = shared.ScopedResourceRevisionManifest;
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
  /** Serializes this process's writes of the JSON files that remain files. */
  protected writeQueue = Promise.resolve();
  /**
   * In-process FIFO per mutation target. One map replaces the per-store
   * promise-chain fields: a target's tail is dropped once it settles.
   */
  private readonly mutationTails = new Map<string, Promise<unknown>>();
  protected promptQueueClaimRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private storageDatabase: StorageDatabase | null = null;
  /** Writes and announcements buffered by an open {@link atomically} scope. */
  private readonly atomicScope = new AsyncLocalStorage<AtomicStorageScope>();
  protected changeListener: ResourceChangeListener | null = null;
  private readonly resourceChangeObservers = new Set<ResourceChangeListener>();
  protected changeRevision = 0;
  protected readonly scopedChanges: Array<{
    change: ResourceChange;
    snapshotRevision?: Promise<ResourceSnapshotRevision | undefined>;
  }> = [];
  protected scopedChangeBytes = 0;
  protected abstract recoverExpiredPromptQueueClaims(): Promise<void>;
  protected abstract promptQueueMessageFingerprint(message: unknown): string;
  protected abstract deleteComposeDraftsByProject(projectId: string): Promise<void>;
  protected abstract deleteSessionBuffer(sessionId: string): Promise<void>;
  /**
   * Parsed-JSON read cache for the stores that remain JSON files, keyed by file
   * path and validated against an (inode, size, mtime) fingerprint on every
   * read, so writes by the desktop process are always observed.
   */
  protected readonly jsonReadCache = new Map<string, { fingerprint: string; value: unknown }>();
  protected readonly promptQueueClaimLeaseMs: number;

  /** Periodic database snapshots; off by default under the test runner. */
  private readonly snapshots: boolean;
  private snapshotTimers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(
    dataDir: string,
    options: { promptQueueClaimLeaseMs?: number; snapshots?: boolean } = {},
  ) {
    this.dataDir = dataDir;
    this.snapshots = options.snapshots ?? process.env.NODE_ENV !== "test";
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

  /** Subscribe backend services without replacing the gateway's broadcast sink. */
  addResourceChangeListener(listener: ResourceChangeListener): () => void {
    this.resourceChangeObservers.add(listener);
    return () => this.resourceChangeObservers.delete(listener);
  }

  /**
   * Announces a committed mutation. Called only after the write has landed, so
   * a client that refetches in response is guaranteed to observe the new value
   * rather than race the write it was told about.
   */
  protected announce(
    resource: ResourceKind,
    id: string,
    projectId?: string,
    scope_?: { agent: string; logicalSessionKey: string },
    deleted = false,
  ): void {
    const scope = this.openAtomicScope();
    if (scope) {
      // Announce-after-commit: the scope commits first, then replays these.
      scope.announcements.push(() => this.announce(resource, id, projectId, scope_, deleted));
      return;
    }
    this.changeRevision += 1;
    const change: ResourceChange = {
      resource,
      id,
      revision: this.changeRevision,
      ...(projectId ? { projectId } : {}),
      ...(scope_ ? scope_ : {}),
      ...(deleted ? { deleted: true } : {}),
    };
    const journalEntry = {
      change,
      ...(RESOURCE_MANIFEST_KINDS.includes(resource as ResourceManifestKind)
        ? {
            snapshotRevision: this.getResourceSnapshotRevision(
              resource as ResourceManifestKind,
            ).catch(() => undefined),
          }
        : {}),
    };
    this.scopedChanges.push(journalEntry);
    this.scopedChangeBytes += Buffer.byteLength(JSON.stringify(change));
    while (this.scopedChanges.length > 4_096 || this.scopedChangeBytes > 2 * 1024 * 1024) {
      const removed = this.scopedChanges.shift();
      if (!removed) break;
      this.scopedChangeBytes -= Buffer.byteLength(JSON.stringify(removed.change));
    }
    const listener = this.changeListener;
    for (const subscriber of [listener, ...this.resourceChangeObservers]) {
      if (!subscriber) continue;
      try {
        subscriber(change);
      } catch (error) {
        // A broken client transport/service observer must never fail a committed mutation.
        console.error("[Storage] Resource change listener threw:", error);
      }
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
  announceNativeAgentSessionProjection(
    environmentId: string,
    scope?: { agent: string; logicalSessionKey: string },
  ): void {
    this.announce("native-agent-session", environmentId, undefined, scope);
  }

  /**
   * Publish a content-free hint that a conversation's transcript artifacts
   * (drafts, verification operations or publication ledger) changed. The
   * artifact service commits to its own store first and only then calls
   * this; the id is the conversation's logical session key.
   */
  announceTranscriptArtifact(conversationKey: string): void {
    this.announce("transcript-artifact", conversationKey);
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

  protected agentMailFile(): string {
    return this.file("agent-mail.json");
  }

  protected coordinatorsFile(): string {
    return this.file("coordinators.json");
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
      case "agent-mail-summary":
        return this.agentMailFile();
    }
  }

  /**
   * Returns an opaque, content-free revision for one authoritative store.
   *
   * A database store's committed revision moves on every write by any backend
   * sharing the data directory; the database identity keeps two databases'
   * revisions apart. The configuration stays a file, fingerprinted by inode,
   * size and timestamps (the writer renames a fresh inode into place), which
   * also detects the desktop process's writes without reading user content.
   */
  async getResourceSnapshotRevision(
    resource: ResourceManifestKind,
  ): Promise<ResourceSnapshotRevision> {
    const filePath = this.resourceManifestFile(resource);
    const store = this.storeForFile(filePath);
    let fingerprint: string;
    if (store !== null) {
      const revision = this.database.storeRevision(store);
      fingerprint =
        revision === null
          ? `${resource}:missing`
          : [resource, this.database.instanceId, revision].join(":");
    } else {
      try {
        const stat = await fs.stat(filePath, { bigint: true });
        fingerprint = [resource, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fingerprint = `${resource}:missing`;
      }
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

  async getScopedResourceRevisionManifest(
    knownGeneration: string | undefined,
    cursor: number,
    knownRevisions: Partial<ResourceRevisionMap> = {},
    requestedHighWater?: number,
  ): Promise<ScopedResourceRevisionManifest> {
    const highWater = Math.min(requestedHighWater ?? this.changeRevision, this.changeRevision);
    if (knownGeneration !== this.resourceGeneration) {
      const broad = await this.getResourceRevisionManifest(undefined, knownRevisions);
      return {
        generation: this.resourceGeneration,
        cursor: highWater,
        highWater,
        reset: true,
        resetResources: [...RESOURCE_MANIFEST_KINDS],
        changes: [],
        revisions: broad.revisions,
        hasMore: false,
      };
    }
    const oldest = this.scopedChanges[0]?.change.revision ?? highWater + 1;
    if (cursor < oldest - 1 || cursor > highWater) {
      const broad = await this.getResourceRevisionManifest(undefined, knownRevisions);
      return {
        generation: this.resourceGeneration,
        cursor: highWater,
        highWater,
        reset: true,
        resetResources: [...RESOURCE_MANIFEST_KINDS],
        changes: [],
        revisions: broad.revisions,
        hasMore: false,
      };
    }
    const pending: typeof this.scopedChanges = [];
    let pageBytes = 0;
    for (const entry of this.scopedChanges) {
      if (entry.change.revision <= cursor || entry.change.revision > highWater) continue;
      const entryBytes = Buffer.byteLength(JSON.stringify(entry.change));
      if (pending.length >= 256 || (pending.length > 0 && pageBytes + entryBytes > 64 * 1024)) {
        break;
      }
      pending.push(entry);
      pageBytes += entryBytes;
    }
    const lastCursor = pending.at(-1)?.change.revision ?? cursor;
    const hasMore = lastCursor < highWater;
    if (hasMore) {
      const latestByResource = new Map<ResourceManifestKind, (typeof pending)[number]>();
      for (const entry of pending) {
        if (RESOURCE_MANIFEST_KINDS.includes(entry.change.resource as ResourceManifestKind)) {
          latestByResource.set(entry.change.resource as ResourceManifestKind, entry);
        }
      }
      const revisions: Partial<ResourceRevisionMap> = {};
      await Promise.all(
        Array.from(latestByResource.entries()).map(async ([resource, entry]) => {
          const revision = await entry.snapshotRevision?.catch(() => undefined);
          if (revision) revisions[resource] = revision;
        }),
      );
      return {
        generation: this.resourceGeneration,
        cursor: lastCursor,
        highWater,
        reset: false,
        resetResources: [],
        changes: pending.map((entry) => entry.change),
        revisions,
        hasMore: true,
      };
    }
    const current = await this.getResourceRevisionManifest(this.resourceGeneration, knownRevisions);
    const resetResources: ResourceManifestKind[] = [];
    for (const resource of Object.keys(current.revisions) as ResourceManifestKind[]) {
      // These two collections establish the owner hierarchy for every scoped
      // read. Refresh them authoritatively before replaying dependent records.
      if (resource === "project" || resource === "environment") {
        resetResources.push(resource);
        continue;
      }
      const latestAccounted = Array.from(pending)
        .reverse()
        .find((entry) => entry.change.resource === resource);
      const accountedRevision = latestAccounted?.snapshotRevision
        ? await latestAccounted.snapshotRevision.catch(() => undefined)
        : undefined;
      if (!accountedRevision || accountedRevision !== current.revisions[resource]) {
        resetResources.push(resource);
      }
    }
    return {
      generation: this.resourceGeneration,
      cursor: lastCursor,
      highWater,
      reset: false,
      resetResources,
      changes: pending.map((entry) => entry.change),
      revisions: current.revisions,
      hasMore: false,
    };
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
    // Open (and on first run, import into) the database before any store is
    // read, so a migration failure surfaces at start-up rather than mid-command.
    this.database.purgeAbandonedLeases();
    await this.recoverExpiredPromptQueueClaims();
    if (this.snapshots && this.snapshotTimers.length === 0) {
      // Off the start-up path; then a cheap "is one due?" check every few minutes.
      const check = () => void takeHourlySnapshotIfDue(this.database, this.dataDir);
      const first = setTimeout(check, 60_000);
      const periodic = setInterval(check, BACKUP_CHECK_INTERVAL_MS);
      first.unref?.();
      periodic.unref?.();
      this.snapshotTimers = [first, periodic];
    }
  }

  /**
   * The backend database, opened on first use. Opening is synchronous and runs
   * any pending migration, including the one-time import of the JSON stores.
   */
  protected get database(): StorageDatabase {
    if (!this.storageDatabase || this.storageDatabase.isClosed()) {
      // Reads are charged to recurring work by the default observers.
      this.storageDatabase = openBackendDatabase(this.dataDir);
    }
    return this.storageDatabase;
  }

  /** Closes the database connection. Later calls reopen it. */
  close(): void {
    for (const timer of this.snapshotTimers) clearInterval(timer);
    this.snapshotTimers = [];
    this.storageDatabase?.close();
    this.storageDatabase = null;
  }

  /** The database store replacing `filePath`, or `null` for a file that stays a file. */
  protected storeForFile(filePath: string): string | null {
    const relative = path.relative(this.dataDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return databaseStoreForPath(relative);
  }

  /** Whether a store has ever been written (its file existed, for file stores). */
  protected async storeExists(filePath: string): Promise<boolean> {
    const store = this.storeForFile(filePath);
    if (store === null) return exists(filePath);
    const scope = this.atomicScope.getStore();
    if (scope?.writes.has(store)) return scope.writes.get(store) !== DELETED_STORE;
    return this.database.hasStore(store);
  }

  /**
   * Runs `operation` with every database-store write buffered, then commits
   * them in one SQLite transaction and only afterwards publishes the resource
   * announcements made inside. Reads inside see the buffered writes. Either
   * every store changes or none does, which replaces ordering-plus-marker
   * protocols between stores.
   *
   * Use only for pure storage work: anything that must be durable *before* an
   * external side effect (a provider send, a Docker call) belongs outside.
   * Locks are the caller's responsibility, exactly as without the scope.
   */
  protected async atomically<T>(operation: () => Promise<T>): Promise<T> {
    if (this.atomicScope.getStore()) return operation();
    const scope: AtomicStorageScope = {
      writes: new Map(),
      announcements: [],
      archiveCleanups: [],
      archiveTransforms: [],
      scrub: false,
      closed: false,
    };
    let result: T;
    try {
      result = await this.atomicScope.run(scope, operation);
    } finally {
      scope.closed = true;
    }
    const writes = [...scope.writes];
    if (writes.length > 0) {
      commitWithLegacyJsonCleanup(
        this.database,
        this.dataDir,
        () => {
          for (const [store, value] of writes) {
            if (value === DELETED_STORE) this.database.deleteStoreInTransaction(store);
            else this.database.writeStoreInTransaction(store, value);
          }
        },
        scope.archiveCleanups,
      );
      if (scope.scrub || writes.some(([, value]) => value === DELETED_STORE)) {
        this.database.scrubDeletedContent();
      }
    }
    for (const transform of scope.archiveTransforms) transform();
    for (const announcement of scope.announcements) announcement();
    return result;
  }

  /** The open atomic scope, if any; a closed one no longer buffers. */
  private openAtomicScope(): AtomicStorageScope | undefined {
    const scope = this.atomicScope.getStore();
    return scope && !scope.closed ? scope : undefined;
  }

  /**
   * Synchronous read-modify-write of one database store in a single SQLite
   * transaction. Because nothing awaits inside, SQLite's write lock alone
   * serializes it against this and every other backend process; no lease or
   * queue is needed. `mutate` changes the loaded value in place.
   */
  protected updateStore<V, T>(filePath: string, fallback: () => V, mutate: (value: V) => T): T {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("updateStore requires a database store");
    const scope = this.openAtomicScope();
    if (scope) {
      const current = this.loadStore(store, fallback);
      const result = mutate(current);
      scope.writes.set(store, current);
      return result;
    }
    recurringWorkMetrics.work("storage-write");
    return this.database.updateStore(store, fallback, mutate);
  }

  /**
   * Synchronous read-modify-write of one row of a database store (a record
   * store's key, or a key in an envelope collection); see
   * {@link StorageDatabase.updateStoreRow}. Inside an atomic scope it applies
   * to the buffered whole value instead.
   */
  protected updateStoreRow<T>(
    filePath: string,
    key: string,
    mutate: (current: unknown) => RowUpdate<T>,
    options: { collection?: string } = {},
  ): T {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("updateStoreRow requires a database store");
    const scope = this.openAtomicScope();
    if (scope) {
      const whole = this.loadStore<unknown>(store, () => ({}));
      const value: Record<string, unknown> = isRecord(whole) ? whole : {};
      const records: Record<string, unknown> = options.collection
        ? isRecord(value[options.collection])
          ? (value[options.collection] as Record<string, unknown>)
          : {}
        : value;
      const update = mutate(records[key]);
      if (update.delete) delete records[key];
      else if ("value" in update) records[key] = update.value;
      else return update.result;
      if (options.collection) value[options.collection] = records;
      scope.writes.set(store, value);
      return update.result;
    }
    recurringWorkMetrics.work("storage-write");
    return this.database.updateStoreRow(store, key, mutate, options);
  }

  private readStoreOr<V>(store: string, fallback: () => V): V {
    try {
      const snapshot = this.database.readStore(store);
      return snapshot ? (snapshot.value as V) : fallback();
    } catch (error) {
      // Imported from a legacy file that no backup could repair: like the old
      // JSON reader, treat it as absent; the next write replaces it.
      if (error instanceof StoreCorruptError) return fallback();
      throw error;
    }
  }

  protected async writeAtomic(
    filePath: string,
    contents: string,
    makeBackup = true,
    mode?: number,
    refreshRecoveryBackup = false,
  ): Promise<void> {
    recurringWorkMetrics.work("storage-write");
    recurringWorkMetrics.bytes(contents.length);
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

    // Structural writes (makeBackup) fsync so a crash cannot promote an empty
    // remnant. Volatile writes treat a lost refresh as recoverable.
    const writeDurableTemp = async (targetPath: string) => {
      const handle = await fs.open(targetPath, "w", mode ?? 0o666);
      try {
        await handle.writeFile(contents, "utf8");
        if (makeBackup) await handle.sync();
      } finally {
        await handle.close();
      }
    };

    await this.enqueueWrite(async () => {
      await writeDurableTemp(tempPath);
      if (recoveryTempPath) {
        // Volatile updates do not rotate five historical backups, but they
        // still need one current, valid recovery point.
        await writeDurableTemp(recoveryTempPath);
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

  /**
   * Serializes one store's (or one key's) asynchronous read-modify-write in
   * this process and, through a database lease named after `target`, across
   * every backend process sharing the data directory.
   *
   * Prefer {@link updateStore} when the mutation is synchronous. This is for
   * critical sections that await other stores or external work.
   */
  protected serializeMutation<T>(
    target: string,
    description: string,
    operation: () => Promise<T>,
    options: { staleMs?: number; acquireTimeoutMs?: number } = {},
  ): Promise<T> {
    const key = this.leaseName(target);
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    const run = async () => {
      const release = await this.acquireMutationLock(target, description, options);
      try {
        // A retried deletion may now be a no-op. Finish its durable cleanup
        // before invoking code that can return without another write.
        replayLegacyJsonCleanup(this.database, this.dataDir);
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
    this.mutationTails.set(key, settled);
    void settled.finally(() => {
      if (this.mutationTails.get(key) === settled) this.mutationTails.delete(key);
    });
    return next;
  }

  protected enqueueEnvironmentMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.environmentsFile(), "environment storage", operation);
  }

  /** Serializes every project-store read-modify-write across processes. */
  protected enqueueProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.projectsFile(), "project storage", operation);
  }

  protected enqueueCoordinatorMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.coordinatorsFile(), "coordinator storage", operation);
  }

  /**
   * Reserves one canonical local path for the complete repository creation
   * transaction. The hashed lease name avoids putting user paths in storage
   * or logs while still coordinating backend processes that share dataDir.
   *
   * The default acquire timeout covers one critical section: scratch creation
   * spans `git init`, a commit, `gh repo create` and a push (310s), and a path
   * key may be held across a 600s clone. Callers that nest a path-key wait
   * inside a Git-URL lock must pass a larger `acquireTimeoutMs` so a waiter
   * can outlast that composed hold. The stale threshold must survive a holder
   * whose event loop stalls — otherwise two backends enter and one rolls back
   * the other's work.
   */
  protected static readonly PROJECT_CREATION_LOCK_STALE_MS = 90_000;
  protected static readonly PROJECT_CREATION_LOCK_TIMEOUT_MS = 660_000;

  async withProjectCreationLock<T>(
    canonicalProjectPath: string,
    operation: () => Promise<T>,
    options?: { acquireTimeoutMs?: number },
  ): Promise<T> {
    const key = createHash("sha256").update(canonicalProjectPath).digest("hex");
    return this.serializeMutation(
      this.file(path.join("project-creation-locks", key)),
      "project creation",
      operation,
      {
        staleMs: StorageBase.PROJECT_CREATION_LOCK_STALE_MS,
        acquireTimeoutMs: options?.acquireTimeoutMs ?? StorageBase.PROJECT_CREATION_LOCK_TIMEOUT_MS,
      },
    );
  }

  protected enqueueConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.configFile(), "configuration storage", operation);
  }

  protected enqueueLoopedReviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(
      this.loopedReviewsFile(),
      "looped review workflow storage",
      operation,
    );
  }

  protected enqueueMultiReviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(
      this.multiReviewsFile(),
      "multi review workflow storage",
      operation,
    );
  }

  /**
   * Serializes build pipeline writes across backend processes sharing this data
   * directory. The cross-process lease matters more here than the in-process
   * queue: two renderers driving the same pipeline is precisely the race the
   * compare-and-swap revision exists to reject, and it can only reject it if the
   * read-modify-write is atomic.
   */
  protected enqueueBuildPipelineMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.buildPipelinesFile(), "build pipeline storage", operation);
  }

  /**
   * Serializes one native agent session's read-modify-write in this process
   * and across backend processes sharing the same data directory.
   *
   * The acquire timeout is sized for the critical section rather than for a
   * store write, like `withProjectCreationLock` above. This lease is
   * deliberately held across provider I/O: a prompt dispatch keeps it until the
   * provider has acknowledged the request id, and `getOrCreateNativeAgentSession`
   * keeps it across the external session create so two processes cannot mint
   * two provider sessions for one logical key. Those bound at ~90s (the bridge
   * prompt/attach budget) and ~122s (four 30s ACP create attempts plus backoff)
   * respectively, so the 20s default would fail a second process that is
   * waiting on a perfectly healthy holder — and the caller most exposed to that
   * is environment deletion, whose session cleanup is best-effort and would
   * therefore leave the deleted environment's record, provider session id and
   * pending prompt behind.
   *
   * This only extends patience with a *live* holder. A holder that dies stops
   * heartbeating, so the unchanged 15s stale threshold still reclaims the lease.
   */
  protected static readonly NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS = 180_000;

  /**
   * One lease per session key: a slow provider create or send for one session
   * no longer stalls every other session in every environment. Keys are
   * arbitrary strings, so the lease is named by their hash. Writes under it
   * touch only that key's row (`updateStoreRow`), so holders of different
   * keys cannot overwrite each other.
   *
   * Ordering: the service's per-key work fence, then this lease, then leaf
   * leases (prompt queue, display tails). Never take a native session lease
   * while holding another one, a prompt-queue lease or the environment lease.
   */
  protected enqueueNativeAgentSessionMutation<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const digest = createHash("sha256").update(key).digest("hex");
    return this.serializeMutation(
      this.file(path.join("native-agent-session-leases", digest)),
      "native agent session storage",
      operation,
      { acquireTimeoutMs: StorageBase.NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS },
    );
  }

  protected enqueueAgentInteractionJournalMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(
      this.agentInteractionJournalFile(),
      "agent interaction journal storage",
      operation,
    );
  }

  protected enqueuePaneLayoutMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.paneLayoutsFile(), "pane layout storage", operation);
  }

  /** Data-dir relative lease name for a mutation target path. */
  private leaseName(targetPath: string): string {
    const relative = path.relative(this.dataDir, targetPath);
    return relative.startsWith("..") || path.isAbsolute(relative)
      ? path.resolve(targetPath)
      : relative.split(path.sep).join("/");
  }

  /**
   * Cross-process exclusive lease for `targetPath`, held in the database.
   *
   * `staleMs` and `acquireTimeoutMs` must both exceed the critical section they
   * guard. The defaults suit a store read-modify-write; a caller that holds the
   * lease across child processes has to raise them, or a waiter will steal the
   * lease from a live holder whose event loop merely stalled (machine sleep is
   * the realistic case) and both will enter at once.
   */
  protected async acquireMutationLock(
    targetPath: string,
    description: string,
    options: { staleMs?: number; acquireTimeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    return this.database.acquireLease(this.leaseName(targetPath), description, options);
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
    // Never promote an empty/corrupt crash remnant over a valid recovery
    // ladder. The replacement write below can publish recovered state while
    // keeping the newest known-good backup at .bak.1.
    const cached = this.jsonReadCache.get(filePath);
    let primaryKnownGood = false;
    if (cached) {
      try {
        const stat = await fs.stat(filePath);
        const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        primaryKnownGood = cached.fingerprint === fingerprint;
      } catch {
        return;
      }
    }
    if (!primaryKnownGood) {
      try {
        const primary = await fs.readFile(filePath, "utf8");
        if (!primary.trim()) return;
        JSON.parse(primary);
      } catch {
        return;
      }
    }
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
   * Newest-first walk of a JSON file's retained backups. Returns a box rather
   * than the value itself so callers can tell "recovered `null`/`[]` from a
   * backup" apart from "no backup was readable". Database stores have no
   * backups: SQLite's journal makes every commit atomic.
   */
  protected async recoverJsonFromBackups<T>(filePath: string): Promise<{ value: T } | null> {
    if (this.storeForFile(filePath) !== null) return null;
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

  /**
   * Reads a store. Database stores come from SQLite (an unreadable imported
   * document reads as absent, as a corrupt file without backups did); the
   * stores that remain files keep the backup-ladder reader.
   */
  protected async loadJson<T>(filePath: string, fallback: () => T): Promise<T> {
    const store = this.storeForFile(filePath);
    if (store !== null) return this.loadStore(store, fallback);
    if (!(await exists(filePath))) return fallback();

    try {
      const raw = await fs.readFile(filePath, "utf8");
      recurringWorkMetrics.work("storage-read");
      recurringWorkMetrics.bytes(raw.length);
      if (!raw.trim()) throw new SyntaxError("Empty JSON store");
      return JSON.parse(raw) as T;
    } catch {
      const recovered = await this.recoverJsonFromBackups<T>(filePath);
      return recovered ? recovered.value : fallback();
    }
  }

  private loadStore<T>(store: string, fallback: () => T): T {
    const scope = this.openAtomicScope();
    if (scope?.writes.has(store)) {
      const buffered = scope.writes.get(store);
      return buffered === DELETED_STORE ? fallback() : (structuredClone(buffered) as T);
    }
    return this.readStoreOr(store, fallback);
  }

  /**
   * The items of an array/record store whose indexed owner column equals
   * `owner` (e.g. one project's Kanban tickets), without assembling the whole
   * store. Inside an atomic scope it filters the buffered value instead.
   */
  protected loadStoreRowsByOwner<T>(filePath: string, owner: string): T[] {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("loadStoreRowsByOwner requires a database store");
    const scope = this.openAtomicScope();
    if (scope?.writes.has(store)) {
      const layout = storeLayout(store);
      const ownerOf =
        layout.kind === "array" || layout.kind === "record" ? layout.owner : undefined;
      const buffered = this.loadStore<unknown>(store, () => []);
      const items = Array.isArray(buffered)
        ? buffered
        : isRecord(buffered)
          ? Object.values(buffered)
          : [];
      return items.filter((item) => ownerOf?.(item) === owner) as T[];
    }
    try {
      return (this.database.readStoreRowsByOwner(store, owner) ?? []) as T[];
    } catch (error) {
      if (error instanceof StoreCorruptError) return [];
      throw error;
    }
  }

  /**
   * One row of a database store by key (an array item, a record key, or a key
   * of one envelope collection) without assembling the whole store, so a
   * lookup costs the row, not every other record. `undefined` when absent or
   * unreadable, as {@link loadJson} treats an unreadable store. Inside an
   * atomic scope it reads the buffered value instead.
   */
  protected loadStoreRow(
    filePath: string,
    key: string,
    options: { collection?: string } = {},
  ): unknown {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("loadStoreRow requires a database store");
    const scope = this.openAtomicScope();
    if (scope?.writes.has(store)) {
      const buffered = this.loadStore<unknown>(store, () => ({}));
      if (Array.isArray(buffered)) {
        const layout = storeLayout(store);
        const field = layout.kind === "array" ? (layout.key ?? "id") : "id";
        return buffered.find((item) => isRecord(item) && item[field] === key);
      }
      const records = options.collection
        ? isRecord(buffered)
          ? buffered[options.collection]
          : undefined
        : buffered;
      return isRecord(records) ? records[key] : undefined;
    }
    try {
      return this.database.readStoreRow(store, key, options.collection);
    } catch (error) {
      if (error instanceof StoreCorruptError) return undefined;
      throw error;
    }
  }

  /**
   * Strict read of a database store: an unreadable value throws rather than
   * reading as absent. For stores whose corruption must refuse work instead of
   * looking empty (the public operation ledger).
   */
  protected loadStoreStrict<T>(filePath: string): { value: T } | null {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("loadStoreStrict requires a database store");
    const scope = this.openAtomicScope();
    if (scope?.writes.has(store)) {
      const buffered = scope.writes.get(store);
      return buffered === DELETED_STORE ? null : { value: structuredClone(buffered) as T };
    }
    const snapshot = this.database.readStore(store);
    return snapshot ? { value: snapshot.value as T } : null;
  }

  /**
   * Cached variant of {@link loadJson}. Database stores are always cached
   * (validated against their committed revision); files are validated with a
   * stat fingerprint, which also observes the desktop process's writes.
   * Returns a fresh value callers may mutate.
   */
  protected async loadJsonCached<T>(filePath: string, fallback: () => T): Promise<T> {
    const store = this.storeForFile(filePath);
    if (store !== null) return this.loadStore(store, fallback);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      this.jsonReadCache.delete(filePath);
      if (!isMissingFileError(error)) {
        // A stat that fails for a reason other than "not there" is no evidence
        // that the store is empty; take the backup ladder or surface it.
        const recovered = await this.recoverJsonFromBackups<T>(filePath);
        if (recovered) return recovered.value;
        throw error;
      }
      return fallback();
    }
    const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this.jsonReadCache.get(filePath);
    if (cached && cached.fingerprint === fingerprint) {
      recurringWorkMetrics.work("storage-stat");
      return structuredClone(cached.value) as T;
    }
    const value = await this.loadJson(filePath, fallback);
    this.jsonReadCache.set(filePath, { fingerprint, value: structuredClone(value) });
    return value;
  }

  /**
   * Persists a store's complete new value. For database stores only the
   * changed rows are written, in one transaction (or buffered by an open
   * {@link atomically} scope); `backup` is meaningless there.
   *
   * For files, `backup: false` skips the five-file backup rotation. Reserved
   * for high-churn writes that only refresh volatile fields.
   */
  protected async saveJson(
    filePath: string,
    value: unknown,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    if (this.saveStore(filePath, value)) return;
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
    const store = this.storeForFile(filePath);
    if (store !== null) {
      // The retired JSON archive stays the pre-migration copy a downgrade
      // restores from. A save that removes content prunes only that content
      // from every archived copy; one that removes nothing leaves the archive
      // untouched. Environment copies have an attributable scrub at the
      // deleting boundary.
      const archived = store !== "environments" && hasLegacyJsonStore(this.dataDir, store);
      let previous: unknown = MISSING_PREVIOUS;
      if (archived) {
        try {
          const snapshot = this.loadStoreStrict<unknown>(filePath);
          previous = snapshot ? snapshot.value : MISSING_PREVIOUS;
        } catch (error) {
          if (!(error instanceof StoreCorruptError)) throw error;
          previous = UNKNOWN_PREVIOUS;
        }
      }
      const cleanups: LegacyJsonCleanup[] =
        archived &&
        previous !== MISSING_PREVIOUS &&
        (previous === UNKNOWN_PREVIOUS || pruneRemovedContent(previous, value) !== previous)
          ? [{ store, kind: "prune", next: structuredClone(value) }]
          : [];
      // The intent and write share a commit, including inside atomically().
      this.saveStore(filePath, value, cleanups);
      return;
    }
    await this.writeAtomic(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      options.backup ?? true,
      0o600,
      options.backup === false,
    );
  }

  /** Writes a database store; `false` when `filePath` remains a file. */
  private saveStore(filePath: string, value: unknown, cleanups: LegacyJsonCleanup[] = []): boolean {
    const store = this.storeForFile(filePath);
    if (store === null) return false;
    const scope = this.openAtomicScope();
    if (scope) {
      scope.writes.set(store, structuredClone(value));
      scope.archiveCleanups.push(...cleanups);
      return true;
    }
    recurringWorkMetrics.work("storage-write");
    commitWithLegacyJsonCleanup(
      this.database,
      this.dataDir,
      () => {
        this.database.writeStoreInTransaction(store, value);
      },
      cleanups,
    );
    return true;
  }

  /**
   * Removes a database store entirely, with every retired JSON copy of it, or
   * the file that holds a file store.
   */
  protected async deleteStore(filePath: string): Promise<void> {
    const store = this.storeForFile(filePath);
    if (store === null) {
      await fs.rm(filePath, { force: true });
      this.jsonReadCache.delete(filePath);
      return;
    }
    const scope = this.openAtomicScope();
    if (scope) {
      scope.writes.set(store, DELETED_STORE);
      scope.archiveCleanups.push({ store, kind: "delete" });
    } else {
      commitWithLegacyJsonCleanup(
        this.database,
        this.dataDir,
        () => {
          this.database.deleteStoreInTransaction(store);
        },
        [{ store, kind: "delete" }],
      );
      this.database.scrubDeletedContent();
    }
  }

  /**
   * Makes records removed from a sensitive store unrecoverable.
   *
   * For a database store the deleting commit is already the only copy:
   * `secure_delete` zeroes freed pages and a truncating checkpoint discards
   * the WAL frames that still hold the old rows. The JSON files that remain
   * files keep rewriting their retained backups.
   *
   * `keep` receives each stored entry; anything it rejects is dropped, so a
   * caller passes the same predicate it used on the primary store.
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

  /** Archive transforms share the deleting mutation's atomic commit boundary. */
  protected scrubLegacyArchive(store: string, transform: (value: unknown) => unknown): void {
    const scrub = () => scrubLegacyJsonStore(this.dataDir, store, transform);
    const scope = this.openAtomicScope();
    if (scope) scope.archiveTransforms.push(scrub);
    else scrub();
  }

  /** Rewrites every retained sensitive backup while preserving its record shape. */
  protected async transformSensitiveJsonBackups(
    filePath: string,
    transform: (records: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    if (this.storeForFile(filePath) !== null) {
      this.scrubLegacyArchive(this.storeForFile(filePath)!, (value) => {
        if (!isRecord(value)) throw new Error("Unattributable legacy backup");
        return transform(value);
      });
      this.scrubDeletedDatabaseContent();
      return;
    }
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

  /** Discards WAL frames holding content that a committed delete removed. */
  protected scrubDeletedDatabaseContent(): void {
    // Inside an atomic scope the delete has not committed yet: scrub once the
    // scope's transaction has.
    const scope = this.openAtomicScope();
    if (scope) {
      scope.scrub = true;
      return;
    }
    this.database.scrubDeletedContent();
  }

  protected async scrubPendingNativeAgentDispatchBackups(
    key: string,
    requestId: string,
  ): Promise<void> {
    await this.transformSensitiveJsonBackups(this.nativeAgentSessionsFile(), (records) => {
      const record = records[key];
      if (
        isRecord(record) &&
        isRecord(record.pendingDispatch) &&
        record.pendingDispatch.requestId === requestId
      ) {
        const next = { ...record };
        delete next.pendingDispatch;
        return { ...records, [key]: next };
      }
      return records;
    });
  }

  protected async scrubPendingNativeAgentSteerBackups(
    key: string,
    requestId: string,
  ): Promise<void> {
    await this.transformSensitiveJsonBackups(this.nativeAgentSessionsFile(), (records) => {
      const record = records[key];
      if (
        isRecord(record) &&
        isRecord(record.pendingSteer) &&
        record.pendingSteer.requestId === requestId
      ) {
        const next = { ...record };
        delete next.pendingSteer;
        return { ...records, [key]: next };
      }
      return records;
    });
  }
}

const DELETED_STORE: unique symbol = Symbol("deleted store");

const MISSING_PREVIOUS: unique symbol = Symbol("missing previous value");

/** A present but unreadable store: nothing shows what the save kept. */
const UNKNOWN_PREVIOUS: unique symbol = Symbol("unknown previous value");

type AtomicStorageScope = {
  /** Buffered new value per store, or {@link DELETED_STORE}. */
  writes: Map<string, unknown>;
  announcements: Array<() => void>;
  archiveCleanups: LegacyJsonCleanup[];
  archiveTransforms: Array<() => void>;
  /** A delete inside asked for the post-commit WAL scrub. */
  scrub: boolean;
  closed: boolean;
};
