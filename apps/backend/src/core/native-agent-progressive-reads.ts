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
import { heldCoordinatorConversation } from "./coordinator/index.js";
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

/** How long a push-observed session's settled read answers equivalent reads. */
export const OBSERVED_SETTLED_SHARE_MS = 750;
const MAX_OBSERVED_SETTLED = 2_048;
const MAX_OBSERVED_SETTLED_BYTES = 16 * 1024 * 1024;
const MAX_PROGRESSIVE_SOURCE_READS = 8;
const MAX_OBSERVER_SOURCE_READS = 6;
const MAX_QUEUED_OBSERVER_READS = 1024;
const DISCOVERY_KEY_PREFIX = "\0progressive-v1\0discovery:";

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
      setObservedShareClock: (now: () => number) => {
        this.observedShareNow = now;
      },
    };
  }

  /** Key counts of the read state, for `native-projection` diagnostics. */
  cacheGauges(): Record<string, number> {
    return {
      observedSessions: this.observedSessions.size,
      observedSettled: this.observedSettled.size,
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

  /**
   * The push layer observes this session (`core/push/native-session-push-topic.ts`):
   * one observer reads it at a viewer's cadence and announces each change, and
   * every viewer then reads once. While it is observed, a transcript or state
   * read that settled within {@link OBSERVED_SETTLED_SHARE_MS} answers the
   * next equivalent read of the same epoch instead of a second provider read,
   * so N viewers cost one provider read per change. Forced and fresh-source
   * reads never take it, a running read is joined in preference to it, and an
   * epoch change or a wake (activity announcement, invalidation) drops it. A
   * bridge hint does not ({@link noteObservationHint}).
   * Returns the stop.
   */
  observeSession(sessionKey: string): () => void {
    if (!this.observedSessions.has(sessionKey)) {
      this.observationGenerations.set(sessionKey, {});
      this.hintGenerations.set(sessionKey, {});
    }
    this.observedSessions.set(sessionKey, (this.observedSessions.get(sessionKey) ?? 0) + 1);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const remaining = (this.observedSessions.get(sessionKey) ?? 1) - 1;
      if (remaining > 0) {
        this.observedSessions.set(sessionKey, remaining);
        return;
      }
      this.observedSessions.delete(sessionKey);
      this.observationGenerations.delete(sessionKey);
      this.hintGenerations.delete(sessionKey);
      this.forgetObservedSettled(sessionKey);
      for (const [key, queued] of Array.from(this.observerQueue)) {
        if (queued.sessionKey !== sessionKey) continue;
        this.observerQueue.delete(key);
        queued.cancel();
      }
    };
  }

  /** Something says the session moved: the next read goes to the provider. */
  forgetObservedSettled(sessionKey: string): void {
    if (this.observedSessions.has(sessionKey)) this.observationGenerations.set(sessionKey, {});
    const prefix = `${sessionKey}\0progressive-v1\0`;
    for (const key of Array.from(this.observedSettled.keys())) {
      if (key.startsWith(prefix)) this.removeObservedSettled(key);
    }
  }

  /**
   * A bridge hint says the session moved (to-do 8102 task 2). The observer's
   * next read must not join provider work that started before the hint, but
   * the settled answer stays shared: viewers read only after the frame the
   * observer's own read announces, so the share they take is that answer.
   * Dropping it on every hint sent each viewer's post-frame read to the
   * provider while a turn streamed.
   */
  noteObservationHint(sessionKey: string): void {
    if (this.observedSessions.has(sessionKey)) this.hintGenerations.set(sessionKey, {});
  }

  private observedShareNow: () => number = () => monotonicMs();
  private readonly observationGenerations = new Map<string, object>();
  private readonly sourceObservationGenerations = new Map<string, object>();
  /** Bumped by {@link noteObservationHint}; only the observer's join consults it. */
  private readonly hintGenerations = new Map<string, object>();
  private readonly sourceHintGenerations = new Map<string, object>();
  private readonly observerQueue = new Map<
    string,
    {
      sessionKey: string;
      promise: Promise<unknown>;
      start(): void;
      cancel(): void;
    }
  >();
  private observedShareBytes = 0;
  private observedShareTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly observedSessions = new Map<string, number>();
  private readonly observedSettled = new Map<
    string,
    { value: unknown; epoch: number; expiresAt: number; bytes: number }
  >();

  private takeObservedSettled<T>(key: string, sessionKey: string, epoch: number): T | undefined {
    const entry = this.observedSettled.get(key);
    if (!entry) return undefined;
    if (
      !this.observedSessions.has(sessionKey) ||
      entry.epoch !== epoch ||
      entry.expiresAt <= this.observedShareNow()
    ) {
      this.removeObservedSettled(key);
      return undefined;
    }
    return entry.value as T;
  }

  private removeObservedSettled(key: string): void {
    const entry = this.observedSettled.get(key);
    if (!entry) return;
    this.observedShareBytes -= entry.bytes;
    this.observedSettled.delete(key);
    if (this.observedSettled.size === 0) {
      clearTimeout(this.observedShareTimer);
      this.observedShareTimer = undefined;
    }
  }

  private scheduleObservedExpiry(): void {
    if (this.observedShareTimer) return;
    const oldest = this.observedSettled.values().next().value;
    if (!oldest) return;
    this.observedShareTimer = setTimeout(
      () => {
        this.observedShareTimer = undefined;
        const now = this.observedShareNow();
        for (const [key, entry] of Array.from(this.observedSettled)) {
          if (entry.expiresAt > now) break;
          this.removeObservedSettled(key);
        }
        this.scheduleObservedExpiry();
      },
      Math.max(1, oldest.expiresAt - this.observedShareNow()),
    );
    this.observedShareTimer.unref();
  }

  private recordObservedSettled(key: string, epoch: number, value: unknown): void {
    if (
      this.observedSettled.get(key)?.value === value &&
      this.observedSettled.get(key)?.epoch === epoch
    )
      return;
    // Charge UTF-16 storage for the serialized projection and its cache key.
    const bytes = 2 * (key.length + (JSON.stringify(value)?.length ?? 0));
    this.removeObservedSettled(key);
    if (bytes > MAX_OBSERVED_SETTLED_BYTES) return;
    this.observedSettled.set(key, {
      value,
      epoch,
      bytes,
      expiresAt: this.observedShareNow() + OBSERVED_SETTLED_SHARE_MS,
    });
    this.observedShareBytes += bytes;
    while (
      this.observedSettled.size > MAX_OBSERVED_SETTLED ||
      this.observedShareBytes > MAX_OBSERVED_SETTLED_BYTES
    ) {
      this.removeObservedSettled(this.observedSettled.keys().next().value!);
    }
    this.scheduleObservedExpiry();
  }

  /** Drop all read state; run after `settle`. */
  clear(): void {
    clearTimeout(this.observedShareTimer);
    this.observedShareTimer = undefined;
    this.observedShareBytes = 0;
    this.observedSettled.clear();
    this.observationGenerations.clear();
    this.sourceObservationGenerations.clear();
    this.hintGenerations.clear();
    this.sourceHintGenerations.clear();
    for (const queued of this.observerQueue.values()) queued.cancel();
    this.observerQueue.clear();
    this.observedSessions.clear();
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
    this.forgetObservedSettled(sessionKey);
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
    if (
      !key.includes(DISCOVERY_KEY_PREFIX) &&
      this.sourceReadCount() >= MAX_PROGRESSIVE_SOURCE_READS
    ) {
      return Promise.reject(new ProviderUnavailableError("Native agent read is overloaded"));
    }
    if (sessionKey)
      this.progressiveReadEpochs.set(key, this.context.projectionEpochs.get(sessionKey) ?? 0);
    const observed =
      sessionKey === undefined ? undefined : this.observationGenerations.get(sessionKey);
    if (observed) this.sourceObservationGenerations.set(key, observed);
    const hinted = sessionKey === undefined ? undefined : this.hintGenerations.get(sessionKey);
    if (hinted) this.sourceHintGenerations.set(key, hinted);
    const operation = read();
    const tracked = operation.finally(() => {
      if (this.progressiveReads.get(key) !== tracked) return;
      this.progressiveReads.delete(key);
      // The epoch a read started at matters only while another caller can
      // join it (`progressiveReadCovering`); once it settles nothing reads it,
      // and keeping it grew the map by one key per session ever read (todo
      // 7100 task 3).
      this.progressiveReadEpochs.delete(key);
      this.sourceObservationGenerations.delete(key);
      this.sourceHintGenerations.delete(key);
      if (sessionKey) this.releaseSettledSnapshotShares(sessionKey);
      this.drainObserverQueue();
    });
    this.progressiveReads.set(key, tracked);
    return tracked;
  }

  private sourceReadCount(): number {
    let count = 0;
    for (const key of this.progressiveReads.keys()) {
      if (!key.includes(DISCOVERY_KEY_PREFIX)) count += 1;
    }
    return count;
  }

  private drainObserverQueue(): void {
    for (const [key, queued] of this.observerQueue) {
      if (this.sourceReadCount() >= MAX_OBSERVER_SOURCE_READS) break;
      this.observerQueue.delete(key);
      queued.start();
    }
  }

  private queueObservation<T>(key: string, sessionKey: string, read: () => Promise<T>): Promise<T> {
    const queued = this.observerQueue.get(key);
    if (queued) return queued.promise as Promise<T>;
    if (this.observerQueue.size >= MAX_QUEUED_OBSERVER_READS) {
      return Promise.reject(new ProviderUnavailableError("Native agent observation is overloaded"));
    }
    const deferred = Promise.withResolvers<T>();
    this.observerQueue.set(key, {
      sessionKey,
      promise: deferred.promise,
      start: () => {
        void read().then(deferred.resolve, deferred.reject);
      },
      cancel: () =>
        deferred.reject(new ProviderUnavailableError("Native agent observation stopped")),
    });
    return deferred.promise;
  }

  /**
   * Join equivalent work, then run at most one trailing read when the session
   * epoch moved. A forced refresh never settles from an older joined read.
   * An unread confirmation also waits for work started in the same epoch.
   */
  async progressiveReadCovering<T>(
    key: string,
    sessionKey: string,
    requestedEpoch: number,
    force: boolean,
    read: () => Promise<T>,
    freshSource = false,
    pushObservation = false,
  ): Promise<T> {
    const pending = this.progressiveReads.get(key) as Promise<T> | undefined;
    const startedEpoch = this.progressiveReadEpochs.get(key);
    const startedObservation = this.sourceObservationGenerations.get(key);
    const startedHint = this.sourceHintGenerations.get(key);
    if (
      pending &&
      (freshSource ||
        (pushObservation &&
          (startedObservation !== this.observationGenerations.get(sessionKey) ||
            startedHint !== this.hintGenerations.get(sessionKey))) ||
        (force && startedEpoch !== undefined && startedEpoch < requestedEpoch))
    ) {
      await pending.catch(() => undefined);
    }
    if (
      pushObservation &&
      !this.progressiveReads.has(key) &&
      this.sourceReadCount() >= MAX_OBSERVER_SOURCE_READS
    ) {
      return this.queueObservation(key, sessionKey, () =>
        this.progressiveReadCovering(
          key,
          sessionKey,
          requestedEpoch,
          force,
          read,
          freshSource,
          true,
        ),
      );
    }
    if (!pending && !force && !freshSource && !pushObservation) {
      const shared = this.takeObservedSettled<T>(key, sessionKey, requestedEpoch);
      if (shared !== undefined) return shared;
    }
    const source = this.progressiveRead(key, read, sessionKey);
    const generation = this.sourceObservationGenerations.get(key);
    const value = await source;
    const latest = this.context.projectionEpochs.get(sessionKey) ?? 0;
    if (latest <= requestedEpoch && (!force || latest >= requestedEpoch)) {
      if (
        latest === requestedEpoch &&
        generation &&
        generation === this.observationGenerations.get(sessionKey)
      ) {
        this.recordObservedSettled(key, latest, value);
      }
      return value;
    }
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
    if (input.freshSource) return provider.interactiveSnapshot(sessionId);
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
