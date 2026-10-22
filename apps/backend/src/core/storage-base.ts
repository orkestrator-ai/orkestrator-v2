import {
  PROMPT_QUEUE_CLAIM_LEASE_MS,
  createHash,
  isCanonicalUuid,
  isRecord,
  path,
} from "./storage-shared.js";
import type {
  ConditionalResourceSnapshot,
  ResourceChangeListener,
  ResourceKind,
  ResourceManifestKind,
  ResourceRevisionManifest,
  ResourceRevisionMap,
  ResourceSnapshotRevision,
  ScopedResourceRevisionManifest,
} from "./storage-shared.js";
import { StorageContext } from "./storage-context.js";
import type { RowUpdate, StorageDatabase } from "./storage-database.js";

/**
 * Base of the `StorageService` chain. The shared state and the store
 * primitives live in its {@link StorageContext}; the methods here forward to
 * it under the names the layers above have always called, so
 * `storage-writer-guards.test.ts` keeps following every write through them.
 * The layers never reach the context directly.
 */
export abstract class StorageBase {
  protected readonly dataDir: string;
  /** Shared by every layer; the only one this `StorageService` owns. */
  private readonly context: StorageContext;
  protected promptQueueClaimRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  protected abstract recoverExpiredPromptQueueClaims(): Promise<void>;
  protected abstract promptQueueMessageFingerprint(message: unknown): string;
  protected abstract deleteComposeDraftsByProject(projectId: string): Promise<void>;
  protected abstract deleteSessionBuffer(sessionId: string): Promise<void>;
  protected readonly promptQueueClaimLeaseMs: number;

  constructor(
    dataDir: string,
    options: { promptQueueClaimLeaseMs?: number; snapshots?: boolean } = {},
  ) {
    this.dataDir = dataDir;
    this.promptQueueClaimLeaseMs = options.promptQueueClaimLeaseMs ?? PROMPT_QUEUE_CLAIM_LEASE_MS;
    if (!Number.isFinite(this.promptQueueClaimLeaseMs) || this.promptQueueClaimLeaseMs <= 0) {
      throw new Error("Prompt queue claim lease must be positive");
    }
    this.context = new StorageContext(dataDir, { snapshots: options.snapshots });
  }

  /**
   * Installs the sink that broadcasts persistent mutations to connected
   * clients. Kept as a setter rather than a constructor argument because the
   * gateway that ultimately delivers these does not exist yet when the backend
   * builds its storage service.
   */
  setResourceChangeListener(listener: ResourceChangeListener | null): void {
    this.context.changes.setResourceChangeListener(listener);
  }

  /** Subscribe backend services without replacing the gateway's broadcast sink. */
  addResourceChangeListener(listener: ResourceChangeListener): () => void {
    return this.context.changes.addResourceChangeListener(listener);
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
    scope?: { agent: string; logicalSessionKey: string },
    deleted = false,
  ): void {
    this.context.changes.announce(resource, id, projectId, scope, deleted);
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
    await this.context.open();
    await this.recoverExpiredPromptQueueClaims();
    this.context.startSnapshots();
  }

  /** The backend database, opened on first use; see {@link StorageContext.database}. */
  protected get database(): StorageDatabase {
    return this.context.database;
  }

  /** Closes the database connection. Later calls reopen it. */
  close(): void {
    this.context.close();
  }

  // Store primitives: see their implementations on StorageContext.

  protected storeForFile(filePath: string): string | null {
    return this.context.storeForFile(filePath);
  }

  protected async storeExists(filePath: string): Promise<boolean> {
    return this.context.storeExists(filePath);
  }

  protected async atomically<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.atomically(operation);
  }

  protected updateStore<V, T>(filePath: string, fallback: () => V, mutate: (value: V) => T): T {
    return this.context.updateStore(filePath, fallback, mutate);
  }

  protected updateStoreRow<T>(
    filePath: string,
    key: string,
    mutate: (current: unknown) => RowUpdate<T>,
    options: { collection?: string } = {},
  ): T {
    return this.context.updateStoreRow(filePath, key, mutate, options);
  }

  /** See {@link StorageContext.serialize}, which also records the lease order. */
  protected serializeMutation<T>(
    target: string,
    description: string,
    operation: () => Promise<T>,
    options: { staleMs?: number; acquireTimeoutMs?: number } = {},
  ): Promise<T> {
    return this.context.serialize(target, description, operation, options);
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

  protected async acquireMutationLock(
    targetPath: string,
    description: string,
    options: { staleMs?: number; acquireTimeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    return this.context.acquireLease(targetPath, description, options);
  }

  protected async acquireConfigMutationLock(): Promise<() => Promise<void>> {
    return this.acquireMutationLock(this.configFile(), "configuration storage");
  }

  protected async acquireEnvironmentMutationLock(): Promise<() => Promise<void>> {
    return this.acquireMutationLock(this.environmentsFile(), "environment storage");
  }

  protected async loadJson<T>(filePath: string, fallback: () => T): Promise<T> {
    return this.context.loadJson(filePath, fallback);
  }

  protected loadStoreRowsByOwner<T>(filePath: string, owner: string): T[] {
    return this.context.loadStoreRowsByOwner(filePath, owner);
  }

  protected loadStoreRow(
    filePath: string,
    key: string,
    options: { collection?: string } = {},
  ): unknown {
    return this.context.loadStoreRow(filePath, key, options);
  }

  protected loadStoreStrict<T>(filePath: string): { value: T } | null {
    return this.context.loadStoreStrict(filePath);
  }

  protected async loadJsonCached<T>(filePath: string, fallback: () => T): Promise<T> {
    return this.context.loadJsonCached(filePath, fallback);
  }

  protected async saveJson(
    filePath: string,
    value: unknown,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    return this.context.saveJson(filePath, value, options);
  }

  protected async saveSensitiveJson(
    filePath: string,
    value: unknown,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    return this.context.saveSensitiveJson(filePath, value, options);
  }

  protected async deleteStore(filePath: string): Promise<void> {
    return this.context.deleteStore(filePath);
  }

  protected async scrubSensitiveJsonBackups(
    filePath: string,
    keep: (storedId: string, record: unknown) => boolean,
  ): Promise<void> {
    return this.context.scrubSensitiveJsonBackups(filePath, keep);
  }

  protected scrubLegacyArchive(store: string, transform: (value: unknown) => unknown): void {
    this.context.scrubLegacyArchive(store, transform);
  }

  protected async transformSensitiveJsonBackups(
    filePath: string,
    transform: (records: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    return this.context.transformSensitiveJsonBackups(filePath, transform);
  }

  protected scrubDeletedDatabaseContent(): void {
    this.context.scrubDeletedDatabaseContent();
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
