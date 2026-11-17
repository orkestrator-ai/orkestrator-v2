import type {
  BuildPipelineAgent,
  NativeAgentDiscoveryUpdateInput,
  NativeAgentMessagePage,
  NativeAgentMessagePageInput,
  NativeAgentProgressiveInput,
  NativeAgentProjectionInput,
  NativeAgentRuntimeProvider,
  NativeAgentServiceOptions,
  NativeAgentSessionProjection,
  NativeAgentToolDetails,
  NativeAgentTranscriptUpdateInput,
  PersistedNativeAgentSession,
  StorageService,
} from "./native-agent-service-shared.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import type {
  NativeAgentContextUsage,
  NativeAgentDiscoveryUpdate,
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
} from "@orkestrator/protocol/native-agent";
import type { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import { NativeAgentResumeIdentityObserver } from "./native-agent-resume-identity.js";
import { NativeAgentSessionTitles } from "./native-agent-session-titles.js";
import { UsageHistoryRecorder } from "./usage-history-recorder.js";
import type { ProgressiveReadMetric } from "./native-agent-progressive-metrics.js";
import { QueuedTurnPhaseLog } from "./native-agent-queued-turn-log.js";
import { createLogger } from "@orkestrator/protocol/logger";
import type {
  NativeAgentProjectionContext,
  NativeAgentTranscriptProjectionHost,
} from "./native-agent-projection-context.js";
import { NativeAgentProjectionParts } from "./native-agent-projection-parts.js";
import { NativeAgentProgressiveReads } from "./native-agent-progressive-reads.js";
import { NativeAgentProgressiveTranscript } from "./native-agent-progressive-transcript.js";
import { NativeAgentProgressiveSessionState } from "./native-agent-progressive-session-state.js";
import { NativeAgentProgressiveDiscovery } from "./native-agent-progressive-discovery.js";
import { NativeAgentHistoryPages } from "./native-agent-history-pages.js";
import { NativeAgentToolDetailReads } from "./native-agent-tool-detail-reads.js";
import { NativeAgentFullProjection } from "./native-agent-full-projection.js";

const log = createLogger("native-agent");

export {
  attachProgressToToolRows,
  mergeContextUsageTurns,
  mergeNativeAgentQueueItems,
  withProviderContextWindow,
} from "./native-agent-projection-helpers.js";
export type {
  NativeAgentTranscriptProjectionHost,
  ResolvedProjectionSession,
} from "./native-agent-projection-context.js";

/**
 * Renderer views of provider sessions, and the one owner of what they share.
 *
 * Each read model is its own collaborator, taking the shared
 * {@link NativeAgentProjectionContext} this class builds:
 *
 * - {@link NativeAgentFullProjection}: the whole-session projection that
 *   mutations and `get_native_agent_projection` return, and the
 *   `detail-recovery` read;
 * - {@link NativeAgentProgressiveTranscript},
 *   {@link NativeAgentProgressiveSessionState} and
 *   {@link NativeAgentProgressiveDiscovery}: the progressive views, run through
 *   {@link NativeAgentProgressiveReads};
 * - {@link NativeAgentHistoryPages}: direct history pages;
 * - {@link NativeAgentToolDetailReads}: tool details on demand.
 *
 * The caches every read model builds views from (tool details, projected rows,
 * direct pages, artifact overlays) live in one owner,
 * {@link NativeAgentProjectionParts}. This class owns the session epochs and
 * the session lifecycle (invalidate, prune, forget an environment, shutdown)
 * that crosses every read model, and keeps the public surface as one-line
 * delegates.
 *
 * Every cache is bounded and reconstructible: providers stay authoritative, so
 * dropping any of it costs a re-read, never user state.
 */
export class NativeAgentTranscriptProjection {
  /** Content-free debug line for a queue held while the turn is not running. */
  private readonly queuedTurnLog = new QueuedTurnPhaseLog();
  /** Invalidates an in-flight read when a logical tab changes provider identity. */
  private readonly projectionEpochs = new Map<string, number>();
  /** The backend's choice of title per session, and its push to the provider. */
  private readonly sessionTitles: NativeAgentSessionTitles;
  /**
   * Durable token and spend history, fed from the per-turn usage every
   * provider already reports. The recorder de-duplicates and writes off the
   * projection path, so a projection never waits on it.
   */
  private readonly usageRecorder = new UsageHistoryRecorder({
    // Optional because narrow test doubles of the storage omit it.
    write: ({ sessionKey, environmentId, platform, providerSessionId, turns }) =>
      typeof this.storage.recordAgentUsageTurns === "function"
        ? this.storage.recordAgentUsageTurns({
            sessionKey,
            environmentId,
            platform,
            ...(providerSessionId ? { providerSessionId } : {}),
            turns: turns ?? [],
          })
        : 0,
  });
  private readonly resumeIdentity: NativeAgentResumeIdentityObserver;
  private readonly storage: StorageService;
  private readonly options: NativeAgentServiceOptions;
  private readonly catalogs: NativeAgentCatalogCache;

  private readonly parts: NativeAgentProjectionParts;
  private readonly reads: NativeAgentProgressiveReads;
  private readonly transcript: NativeAgentProgressiveTranscript;
  private readonly sessionState: NativeAgentProgressiveSessionState;
  private readonly discovery: NativeAgentProgressiveDiscovery;
  private readonly history: NativeAgentHistoryPages;
  private readonly toolDetails: NativeAgentToolDetailReads;
  private readonly full: NativeAgentFullProjection;

  constructor(private readonly host: NativeAgentTranscriptProjectionHost) {
    this.storage = host.storage;
    this.resumeIdentity = new NativeAgentResumeIdentityObserver(this.storage);
    this.options = host.options;
    this.catalogs = host.catalogs;
    this.sessionTitles = new NativeAgentSessionTitles({
      storage: {
        // Optional because narrow test doubles of the storage omit it.
        recordNativeAgentSessionBackendTitle: (key, title) =>
          typeof this.storage.recordNativeAgentSessionBackendTitle === "function"
            ? this.storage.recordNativeAgentSessionBackendTitle(key, title)
            : Promise.resolve(false),
      },
      ...(this.options.sessionTitles ? { generator: this.options.sessionTitles } : {}),
      onTitleChosen: (sessionKey, title, providerSessionId) =>
        this.full.showChosenTitle(sessionKey, title, providerSessionId),
      now: () => this.host.now(),
    });
    // The read models reach the owner's lifecycle through arrow functions, so
    // a test that patches one of this class's methods still sees every call.
    // Each collaborator is added once built; none reads a sibling while it is
    // being constructed.
    const context = {
      host,
      storage: this.storage,
      options: this.options,
      catalogs: this.catalogs,
      projectionEpochs: this.projectionEpochs,
      queuedTurnLog: this.queuedTurnLog,
      sessionTitles: this.sessionTitles,
      resumeIdentity: this.resumeIdentity,
      usageRecorder: this.usageRecorder,
      observeSessionUsage: (session, usage) => this.observeSessionUsage(session, usage),
      invalidateProjection: (key) => this.invalidateProjection(key),
      pruneProjectionEpoch: (key) => this.pruneProjectionEpoch(key),
      releaseForgottenProjectionEpochs: (sessionKey) =>
        this.releaseForgottenProjectionEpochs(sessionKey),
    } as { -readonly [K in keyof NativeAgentProjectionContext]: NativeAgentProjectionContext[K] };
    context.parts = this.parts = new NativeAgentProjectionParts(context);
    context.reads = this.reads = new NativeAgentProgressiveReads(context);
    context.transcript = this.transcript = new NativeAgentProgressiveTranscript(context);
    context.sessionState = this.sessionState = new NativeAgentProgressiveSessionState(context);
    context.discovery = this.discovery = new NativeAgentProgressiveDiscovery(context);
    context.history = this.history = new NativeAgentHistoryPages(context);
    context.toolDetails = this.toolDetails = new NativeAgentToolDetailReads(context);
    context.full = this.full = new NativeAgentFullProjection(context);
  }

  /**
   * Hands a usage report read outside a full projection to the recorder: the
   * session-state view and a settled turn's outcome read see usage a session
   * driven only through the CLI would otherwise never record.
   */
  observeSessionUsage(
    session: Pick<
      PersistedNativeAgentSession,
      "environmentId" | "agent" | "logicalSessionKey" | "providerSessionId"
    >,
    usage: NativeAgentContextUsage | undefined,
  ): void {
    this.usageRecorder.observe({
      sessionKey: nativeAgentSessionStorageKey(
        session.environmentId,
        session.agent,
        session.logicalSessionKey,
      ),
      environmentId: session.environmentId,
      platform: session.agent,
      ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
      usage,
    });
  }

  /** What `get_progressive_read_metrics` reports. */
  progressiveReadSamples(): readonly ProgressiveReadMetric[] {
    return this.reads.progressiveReadSamples();
  }

  /** Keep a session's stop result until its next authoritative projection. */
  recordStopNotice(sessionKey: string, message: string): void {
    this.full.recordStopNotice(sessionKey, message);
  }

  /** Projection reads and title choices still in flight, for shutdown to settle. */
  pendingRefreshes(): Promise<unknown>[] {
    return this.full.pendingRefreshes();
  }

  getTranscriptUpdate(
    input: NativeAgentTranscriptUpdateInput,
  ): Promise<NativeAgentTranscriptUpdate> {
    return this.transcript.getTranscriptUpdate(input);
  }

  getSessionStateUpdate(
    input: NativeAgentProgressiveInput,
  ): Promise<NativeAgentSessionStateUpdate> {
    return this.sessionState.getSessionStateUpdate(input);
  }

  getDiscoveryUpdate(input: NativeAgentDiscoveryUpdateInput): Promise<NativeAgentDiscoveryUpdate> {
    return this.discovery.getDiscoveryUpdate(input);
  }

  /** Run an MCP action fenced against the session's discovery reads. */
  withMcpActionFence<T>(
    input: NativeAgentProjectionInput,
    action: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T> {
    return this.discovery.withMcpActionFence(input, action);
  }

  /** Re-read the MCP section after an action and store it for the next discovery read. */
  refreshMcpAfterAction(
    input: NativeAgentProjectionInput,
    provider: NativeAgentRuntimeProvider,
    providerSessionId: string,
  ): Promise<void> {
    return this.discovery.refreshMcpAfterAction(input, provider, providerSessionId);
  }

  getMessagePage(input: NativeAgentMessagePageInput): Promise<NativeAgentMessagePage> {
    return this.history.getMessagePage(input);
  }

  getProjectionToolDetails(
    input: NativeAgentProjectionInput & { detailRef: string },
  ): Promise<NativeAgentToolDetails> {
    return this.toolDetails.getProjectionToolDetails(input);
  }

  /** Write a session's newest pending display tail now. */
  flushDisplayTailPersist(sessionKey: string): Promise<void> {
    return this.transcript.flushDisplayTailPersist(sessionKey);
  }

  /** Withdraw an environment's pending interactions from its cached projections. */
  withdrawEnvironmentInteractions(environmentId: string): void {
    this.full.withdrawEnvironmentInteractions(environmentId);
  }

  /** Refresh a projection whose result the caller drops; reads a short tail. */
  refreshProjectionState(input: NativeAgentProjectionInput): Promise<unknown> {
    return this.full.refreshProjectionState(input);
  }

  refreshProjection(
    input: NativeAgentProjectionInput,
    force: boolean,
    resolvedSession?: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
      transient: true;
    },
    tailMessages?: number,
  ): Promise<NativeAgentSessionProjection | null> {
    return this.full.refreshProjection(input, force, resolvedSession, tailMessages);
  }

  cachedProjectionSnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): NativeAgentSessionProjection | null {
    return this.full.cachedProjectionSnapshot(environmentId, agent, logicalSessionKey);
  }

  /**
   * Test-only view of the caches the read models own and of a few internal
   * steps, gathered from each collaborator's own accessor. Service tests reach
   * projection state here, never through the service; production code must
   * not call it.
   */
  forTesting() {
    return {
      ...this.full.forTesting(),
      ...this.transcript.forTesting(),
      ...this.discovery.forTesting(),
      ...this.reads.forTesting(),
      ...this.parts.forTesting(),
      quietObservationFlag: (session: PersistedNativeAgentSession) =>
        this.parts.quietObservationFlag(session),
      recoverableDispatchStatus: (createdAt: string, kind?: "prompt" | "steer") =>
        this.parts.recoverableDispatchStatus(createdAt, kind),
      projectionEpochs: this.projectionEpochs,
      invalidateProjection: (key: string) => this.invalidateProjection(key),
      pruneProjectionEpoch: (key: string) => this.pruneProjectionEpoch(key),
    };
  }

  /**
   * Cache gauges for recurring diagnostics (`native-projection`): how many
   * keys each per-session map holds, and the bytes the bounded ones charge.
   * Every map that is keyed by a session (or a session's read) is listed, so a
   * soak can tell a cache that tracks the open sessions from one that grows
   * with every session ever seen. Counts only; reading walks no entry.
   */
  cacheGauges(): Record<string, number> {
    return {
      ...this.full.cacheGauges(),
      projectionEpochs: this.projectionEpochs.size,
      ...this.parts.cacheGauges(),
      ...this.toolDetails.cacheGauges(),
      ...this.transcript.cacheGauges(),
      ...this.sessionState.cacheGauges(),
      ...this.discovery.cacheGauges(),
      ...this.reads.cacheGauges(),
    };
  }

  /** Drop every legacy projection cache; run after shutdown settled the reads. */
  clear(): void {
    this.full.clear();
    this.parts.clearToolDetails();
    this.projectionEpochs.clear();
    this.queuedTurnLog.clear();
  }

  async settleAndClearProgressiveReads(): Promise<void> {
    // Stop accepting checkpoints and drain the newest pending previews within
    // a bounded deadline, concurrently with settling the reads below.
    const displayTailDrain = this.transcript.drainDisplayTails();
    this.transcript.cancelHydrationTimers();
    await this.reads.settle();
    await this.transcript.settleHydrations();
    this.transcript.clear();
    this.sessionState.clear();
    this.discovery.clear();
    this.reads.clear();
    this.parts.clearRowsAndPages();
    const drained = await displayTailDrain;
    if (drained.skipped > 0) {
      // Aggregate count only: previews carry transcript content.
      log.warn("shutdown.checkpoints-skipped", { skipped: drained.skipped });
    }
  }

  /**
   * Releases what this projection keeps for a deleted environment's sessions:
   * their cached views and sync revisions, history, tool details, projected
   * rows, direct pages and progressive reads. Called when an environment is
   * deleted, after its session records went; never on tab close, unmount or
   * switch. The caches are rebuildable, but without this a deleted
   * environment's views stayed resident until LRU churn pushed them out
   * (1,024 projections, 4,096 revision counters), so memory grew with every
   * environment ever deleted (todo 7100 task 1).
   *
   * Sessions are found through cached views and active read descriptors, since a
   * session key is a hash. A read still in flight is fenced by the epoch bump
   * in {@link invalidateProjection}; its epoch is reclaimed once it settles.
   */
  forgetEnvironment(environmentId: string): number {
    const sessionKeys = new Set<string>();
    this.full.collectEnvironmentSessions(environmentId, sessionKeys);
    this.reads.collectEnvironmentSessions(environmentId, sessionKeys);
    this.transcript.collectEnvironmentSessions(environmentId, sessionKeys);
    this.sessionState.collectEnvironmentSessions(environmentId, sessionKeys);
    // A queued-only session has no cached view or live read descriptor.
    this.discovery.collectEnvironmentSessions(environmentId, sessionKeys);
    for (const sessionKey of sessionKeys) {
      this.invalidateProjection(sessionKey);
      this.full.forgetRevisions(sessionKey);
      this.releaseForgottenProjectionEpochs(sessionKey);
    }
    return sessionKeys.size;
  }

  private releaseForgottenProjectionEpochs(sessionKey: string): void {
    this.reads.releaseSettledReadEpochs(sessionKey);
    this.pruneProjectionEpoch(sessionKey);
    this.pruneProjectionEpoch(`${sessionKey}\0detail-recovery`);
  }

  /**
   * The identity behind a session changed (rewind, resume, replacement): bump
   * the epochs of both full-projection keys so no read in flight commits, and
   * have every read model drop what it kept for the old history. Discovery
   * drops its deferred renewals before anything can prune an epoch back to its
   * default zero.
   */
  invalidateProjection(key: string): void {
    this.full.forgetSession(key);
    for (const candidate of [key, `${key}\0detail-recovery`]) {
      this.projectionEpochs.set(candidate, (this.projectionEpochs.get(candidate) ?? 0) + 1);
    }
    this.parts.forgetSession(key);
    this.discovery.forgetSession(key);
    this.transcript.forgetSession(key);
    this.sessionState.forgetSession(key);
    this.reads.forgetSession(key, this.projectionEpochs.get(key) ?? 0);
  }

  /**
   * Drop the epoch counter for a key that is neither cached nor being read.
   *
   * The epoch only means anything relative to a read that captured it, so once
   * a key has no cache entry and no in-flight refresh, restarting it at zero is
   * indistinguishable from keeping it. Without this the map would outlive every
   * bound the projection cache enforces and grow with key churn for the life of
   * the process.
   */
  private pruneProjectionEpoch(key: string): void {
    if (this.full.holdsKey(key)) return;
    if (this.reads.holdsSession(key)) return;
    if (this.discovery.holdsSession(key)) return;
    this.projectionEpochs.delete(key);
    this.full.releaseKey(key);
  }
}
