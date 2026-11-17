import type {
  StorageService,
  NativeAgentRuntimeProvider,
  ProviderInteractiveSnapshot,
  NativeAgentProjectionInput,
  NativeAgentProgressiveInput,
} from "./native-agent-service-shared.js";
import {
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  readProviderStatus,
  ProviderUnavailableError,
} from "./native-agent-service-shared.js";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import { heldCoordinatorConversation } from "./coordinator-runtime.js";
import {
  type NativeAgentSessionStateView,
  type NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { randomUUID } from "node:crypto";
import {
  ProgressiveReadMetrics,
  monotonicMs,
  type ProgressiveCacheTier,
  type ProgressiveReadMetric,
  type ProgressiveReadOutcome,
  type ProgressiveReadPhases,
} from "./native-agent-progressive-metrics.js";
import {
  type NativeAgentTranscriptProjectionHost,
  type InteractiveSnapshotShare,
  type NativeAgentProjectionContext,
} from "./native-agent-projection-context.js";

/**
 * How the progressive transcript, session-state and discovery reads run:
 * equivalent source work is joined (`progressiveRead`), a read the session
 * epoch overtook gets one trailing re-read, overlapping reads of a session
 * share one provider snapshot, live requests are registered so a deleted
 * environment's late reads can be released, and each read records a metric.
 * Held coordinator conversations are read from storage here too.
 */
export class NativeAgentProgressiveReads {
  private readonly host: NativeAgentTranscriptProjectionHost;
  private readonly storage: StorageService;

  constructor(private readonly context: NativeAgentProjectionContext) {
    this.host = context.host;
    this.storage = context.storage;
  }

  /** Test-only view of the read state; production code must not call it. */
  forTesting() {
    return {
      progressiveReads: this.progressiveReads,
      progressiveDirtyFollowUps: this.progressiveDirtyFollowUps,
      progressiveTrailing: this.progressiveTrailing,
      progressiveMetrics: this.progressiveMetrics,
      progressiveReadWaiterCount: () => this.progressiveReadWaiterCount,
    };
  }

  /** Key counts of the read state, for `native-projection` diagnostics. */
  cacheGauges(): Record<string, number> {
    return {
      progressiveReads: this.progressiveReads.size,
      progressiveReadWaiters: this.progressiveReadWaiters.size,
      progressiveReadEpochs: this.progressiveReadEpochs.size,
      progressiveDirtyFollowUps: this.progressiveDirtyFollowUps.size,
      progressiveTrailing: this.progressiveTrailing.size,
      interactiveSnapshotShares: this.interactiveSnapshotShares.size,
    };
  }

  /** Wait for every joined and trailing read to settle (shutdown). */
  async settle(): Promise<void> {
    await Promise.allSettled(this.progressiveReads.values());
    await Promise.allSettled(this.progressiveTrailing.values());
  }

  /** Drop all read state; run after `settle`. */
  clear(): void {
    this.progressiveReads.clear();
    this.progressiveReadWaiters.clear();
    this.progressiveReadWaiterCount = 0;
    this.progressiveReadEpochs.clear();
    this.progressiveDirtyFollowUps.clear();
    this.progressiveTrailing.clear();
    this.interactiveSnapshotShares.clear();
    this.progressiveMetrics.clear();
  }

  /**
   * A session's identity changed (its epoch was just bumped to `epoch`): drop
   * its shared snapshots and mark its in-flight transcript and state reads so
   * each runs one trailing re-read.
   */
  forgetSession(sessionKey: string, epoch: number): void {
    const progressivePrefix = `${sessionKey}\0progressive-v1\0`;
    for (const candidate of Array.from(this.interactiveSnapshotShares.keys())) {
      if (candidate.startsWith(`${sessionKey}\0`)) this.interactiveSnapshotShares.delete(candidate);
    }
    /*
     * Only transcript and state reads are covered by `progressiveReadCovering`,
     * so only they have a trailing read that can consume — and then clear — a
     * follow-up marker. Marking a discovery key would strand it: discovery goes
     * through `progressiveRead` directly, never reaches the trailing path, and
     * the stranded marker would block `pruneProjectionEpoch` forever. Discovery
     * needs no marker anyway; its cache entries were dropped with the session,
     * so the next read reschedules it.
     */
    for (const candidate of Array.from(this.progressiveReads.keys())) {
      if (!candidate.startsWith(progressivePrefix)) continue;
      if (candidate.includes("\0progressive-v1\0discovery:")) continue;
      // Action fences are discarded on epoch change; they never run trailing reads.
      if (candidate.includes("\0progressive-v1\0mcp-action:")) continue;
      this.progressiveDirtyFollowUps.set(candidate, epoch);
    }
  }

  /** Whether a live request, read, trailing read or follow-up still needs the session's epoch. */
  holdsSession(sessionKey: string): boolean {
    if (this.progressiveRequests.has(sessionKey)) return true;
    const progressivePrefix = `${sessionKey}\0progressive-v1\0`;
    return (
      Array.from(this.progressiveReads.keys()).some((candidate) =>
        candidate.startsWith(progressivePrefix),
      ) ||
      Array.from(this.progressiveTrailing.keys()).some((candidate) =>
        candidate.startsWith(progressivePrefix),
      ) ||
      Array.from(this.progressiveDirtyFollowUps.keys()).some((candidate) =>
        candidate.startsWith(progressivePrefix),
      )
    );
  }

  /** Mark a deleted environment's live requests forgotten and collect their sessions. */
  collectEnvironmentSessions(environmentId: string, sessionKeys: Set<string>): void {
    for (const [key, request] of this.progressiveRequests) {
      if (request.environmentId !== environmentId) continue;
      request.forgotten = true;
      sessionKeys.add(key);
    }
  }

  /** Drop the start epochs of a forgotten session's reads that have settled. */
  releaseSettledReadEpochs(sessionKey: string): void {
    for (const candidate of Array.from(this.progressiveReadEpochs.keys())) {
      if (candidate.startsWith(`${sessionKey}\0`) && !this.progressiveReads.has(candidate))
        this.progressiveReadEpochs.delete(candidate);
    }
  }

  private readonly progressiveInstanceId = randomUUID();
  /** Only live requests are registered; settled views carry their own identity. */
  readonly progressiveRequests = new Map<
    string,
    { environmentId: string; readers: number; forgotten: boolean }
  >();
  readonly progressiveReads = new Map<string, Promise<unknown>>();
  private readonly progressiveReadWaiters = new Map<string, number>();
  private progressiveReadWaiterCount = 0;
  readonly progressiveReadEpochs = new Map<string, number>();
  private readonly progressiveDirtyFollowUps = new Map<string, number>();
  private readonly progressiveTrailing = new Map<string, Promise<unknown>>();
  private readonly interactiveSnapshotShares = new Map<string, InteractiveSnapshotShare>();
  private readonly progressiveMetrics = new ProgressiveReadMetrics();
  /** What `get_progressive_read_metrics` reports. */
  progressiveReadSamples(): readonly ProgressiveReadMetric[] {
    return this.progressiveMetrics.list();
  }
  progressiveKey(
    input: Pick<NativeAgentProgressiveInput, "environmentId" | "agent" | "logicalSessionKey">,
    domain: string,
  ): string {
    return `${nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    )}\0progressive-v1\0${domain}`;
  }

  progressiveIdentity(
    input: NativeAgentProgressiveInput,
    providerSessionId: string,
    sourceGeneration: string | number,
  ): NativeAgentViewIdentity {
    return {
      backendInstanceId: this.progressiveInstanceId,
      environmentId: input.environmentId,
      platform: input.agent,
      logicalSessionKey: input.logicalSessionKey,
      providerSessionId,
      sourceGeneration,
    };
  }

  /** Join equivalent source work; one renderer leaving never cancels the read. */
  progressiveRead<T>(key: string, read: () => Promise<T>, sessionKey?: string): Promise<T> {
    const pending = this.progressiveReads.get(key) as Promise<T> | undefined;
    if (pending) {
      const waiters = this.progressiveReadWaiters.get(key) ?? 0;
      if (waiters >= 32 || this.progressiveReadWaiterCount >= 512) {
        return Promise.reject(new ProviderUnavailableError("Native agent read is overloaded"));
      }
      this.progressiveReadWaiters.set(key, waiters + 1);
      this.progressiveReadWaiterCount += 1;
      return pending.finally(() => {
        const remaining = Math.max(0, (this.progressiveReadWaiters.get(key) ?? 1) - 1);
        if (remaining === 0) this.progressiveReadWaiters.delete(key);
        else this.progressiveReadWaiters.set(key, remaining);
        this.progressiveReadWaiterCount = Math.max(0, this.progressiveReadWaiterCount - 1);
      });
    }
    const sourceReads = Array.from(this.progressiveReads.keys()).filter(
      (candidate) => !candidate.includes("\0progressive-v1\0discovery:"),
    ).length;
    if (!key.includes("\0progressive-v1\0discovery:") && sourceReads >= 8) {
      return Promise.reject(new ProviderUnavailableError("Native agent read is overloaded"));
    }
    if (sessionKey)
      this.progressiveReadEpochs.set(key, this.context.projectionEpochs.get(sessionKey) ?? 0);
    const operation = read();
    const tracked = operation.finally(() => {
      if (this.progressiveReads.get(key) !== tracked) return;
      this.progressiveReads.delete(key);
      // The epoch a read started at matters only while another caller can
      // join it (`progressiveReadCovering`); once it settles nothing reads it,
      // and keeping it grew the map by one key per session ever read (todo
      // 7100 task 3).
      this.progressiveReadEpochs.delete(key);
      if (sessionKey) this.releaseSettledSnapshotShares(sessionKey);
    });
    this.progressiveReads.set(key, tracked);
    return tracked;
  }

  /**
   * Join equivalent work, then run at most one trailing read when the session
   * epoch moved. A forced refresh never settles from an older joined read.
   */
  async progressiveReadCovering<T>(
    key: string,
    sessionKey: string,
    requestedEpoch: number,
    force: boolean,
    read: () => Promise<T>,
  ): Promise<T> {
    const pending = this.progressiveReads.get(key) as Promise<T> | undefined;
    const startedEpoch = this.progressiveReadEpochs.get(key);
    if (pending && force && startedEpoch !== undefined && startedEpoch < requestedEpoch) {
      await pending.catch(() => undefined);
    }
    const value = await this.progressiveRead(key, read, sessionKey);
    const latest = this.context.projectionEpochs.get(sessionKey) ?? 0;
    if (latest <= requestedEpoch && (!force || latest >= requestedEpoch)) return value;
    this.progressiveDirtyFollowUps.set(
      key,
      Math.max(this.progressiveDirtyFollowUps.get(key) ?? 0, latest),
    );
    return this.scheduleProgressiveTrailing(key, sessionKey, read);
  }

  private scheduleProgressiveTrailing<T>(
    key: string,
    sessionKey: string,
    read: () => Promise<T>,
  ): Promise<T> {
    const existing = this.progressiveTrailing.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const trailing = (async () => {
      const required = this.progressiveDirtyFollowUps.get(key) ?? 0;
      const value = await this.progressiveRead(key, read, sessionKey);
      const latest = this.context.projectionEpochs.get(sessionKey) ?? 0;
      if (latest > required) {
        this.progressiveDirtyFollowUps.set(key, latest);
        return this.progressiveRead(key, read, sessionKey);
      }
      return value;
    })().finally(() => {
      if (this.progressiveTrailing.get(key) === trailing) this.progressiveTrailing.delete(key);
      // The marker is what `pruneProjectionEpoch` reads to decide the session
      // is still busy, so it has to clear on every exit — including the second
      // re-read above and a thrown read. Leaving it set on one branch pinned
      // the session's epoch in memory for the lifetime of the process.
      this.progressiveDirtyFollowUps.delete(key);
    });
    this.progressiveTrailing.set(key, trailing);
    return trailing;
  }

  sharedInteractiveSnapshot(
    input: NativeAgentProgressiveInput,
    provider: NativeAgentRuntimeProvider,
    sessionId: string,
  ): Promise<ProviderInteractiveSnapshot> {
    if (!provider.interactiveSnapshot) {
      return Promise.reject(new ProviderUnavailableError("Provider snapshot is unavailable"));
    }
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.context.projectionEpochs.get(sessionKey) ?? 0;
    const key = `${sessionKey}\0${sessionId}`;
    const existing = this.interactiveSnapshotShares.get(key);
    if (existing && existing.epoch === epoch) return existing.promise;
    const promise = provider.interactiveSnapshot(sessionId);
    const share: InteractiveSnapshotShare = { promise, sessionKey, epoch, degraded: true };
    this.interactiveSnapshotShares.set(key, share);
    /*
     * A share joins the transcript and state reads of one session that run
     * together; it is not a cache. The epoch moves only on an invalidation,
     * not on streamed rows, so a settled share kept for the rest of its epoch
     * answered every later read with an older snapshot and held a whole
     * snapshot per session ever read (todo 7100 task 3). Once it settles it is
     * kept only while another transcript or state read of the session is in
     * flight, which is what lets a state read join the transcript read it was
     * issued with; the last of them to settle drops it
     * (`releaseSettledSnapshotShares`).
     */
    const settle = () => {
      share.settled = true;
      this.releaseSettledSnapshotShares(sessionKey);
    };
    promise.then(settle, settle);
    return promise;
  }

  /**
   * Whether a read that can join an interactive snapshot share — a transcript
   * or state read — is in flight for the session. Discovery and MCP action
   * reads never take a share, and discovery settles without a session key, so
   * counting them kept a settled share alive after the reads that shared it
   * had finished, and nothing released it when the discovery did.
   */
  private snapshotShareReadInFlight(sessionKey: string): boolean {
    const transcriptPrefix = `${sessionKey}\0progressive-v1\0transcript:`;
    const stateKey = `${sessionKey}\0progressive-v1\0state`;
    for (const candidate of this.progressiveReads.keys()) {
      if (candidate === stateKey || candidate.startsWith(transcriptPrefix)) return true;
    }
    return false;
  }

  private releaseSettledSnapshotShares(sessionKey: string): void {
    const sharePrefix = `${sessionKey}\0`;
    if (this.snapshotShareReadInFlight(sessionKey)) return;
    for (const [candidate, share] of Array.from(this.interactiveSnapshotShares)) {
      if (share.settled && candidate.startsWith(sharePrefix))
        this.interactiveSnapshotShares.delete(candidate);
    }
  }

  recordProgressiveMetric(
    domain: "transcript" | "state" | "discovery",
    startedAt: number,
    cacheTier: ProgressiveCacheTier,
    outcome: ProgressiveReadOutcome,
    extras: ProgressiveReadPhases & { degraded?: boolean } = {},
  ): void {
    this.progressiveMetrics.record({
      domain,
      cacheTier,
      outcome,
      durationMs: monotonicMs() - startedAt,
      ...extras,
    });
  }

  /**
   * The conversation this read names when it may be read but not run: paused,
   * failed to start, or on a platform that is unavailable. `undefined` for every
   * other session, whose reads go on to the provider.
   */
  async heldCoordinatorRead(
    input: NativeAgentProjectionInput,
  ): Promise<{ message: string } | undefined> {
    if (!coordinatorIdFromRuntimeId(input.environmentId)) return undefined;
    const held = await heldCoordinatorConversation(this.storage, input.environmentId);
    if (!held) return undefined;
    if (
      held.conversation.agent !== input.agent ||
      held.conversation.logicalSessionKey !== input.logicalSessionKey
    )
      throw new Error("Native agent session key collision");
    return { message: held.message };
  }

  /** Held reads preserve an existing turn's activity so Stop stays available. */
  async heldCoordinatorSessionState(
    input: NativeAgentProjectionInput,
    message: string,
  ): Promise<NativeAgentSessionStateView | null> {
    const session = await this.storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
    );
    if (!session) return null;
    const provider = this.host.cachedProvider?.(input);
    const status = provider
      ? await readProviderStatus(provider, session.providerSessionId).catch(() => ({
          status: "running" as const,
        }))
      : undefined;
    const phase =
      status?.status === "running" || status?.status === "blocked" || status?.status === "error"
        ? status.status
        : "idle";
    return {
      identity: this.progressiveIdentity(
        { ...input, viewVersion: 1 },
        session.providerSessionId,
        `saved:${input.agent}`,
      ),
      connection: "error",
      turn: { phase, error: message },
      interactions: [],
      composerControls: [],
      capabilities: nativeCapabilities(input.agent),
      notices: [],
    };
  }

  async trackProgressiveRequest<T>(
    input: NativeAgentProgressiveInput,
    read: () => Promise<T>,
  ): Promise<T> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const request = this.progressiveRequests.get(key) ?? {
      environmentId: input.environmentId,
      readers: 0,
      forgotten: false,
    };
    request.readers += 1;
    this.progressiveRequests.set(key, request);
    try {
      return await read();
    } finally {
      request.readers -= 1;
      if (request.readers === 0) {
        this.progressiveRequests.delete(key);
        if (request.forgotten) {
          // Also release artifacts produced while the provider read was settling.
          this.context.invalidateProjection(key);
          this.context.releaseForgottenProjectionEpochs(key);
        }
      }
    }
  }
}
