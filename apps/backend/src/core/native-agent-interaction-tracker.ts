import * as shared from "./native-agent-service-shared.js";
import {
  UNATTENDED_AGENT_INTERACTION_POLICY,
  nativeAgentSessionStorageKey,
  readProviderStatus,
  INTERACTION_MONITOR_DEFAULT_CONCURRENCY,
  INTERACTION_MONITOR_DEFAULT_MAX_RETRIES,
  INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT,
  INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS,
  INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS,
  INTERACTION_MONITOR_MAX_OBSERVATIONS,
  INTERACTION_MONITOR_MAX_TRACKED_REQUESTS,
  PROVIDER_REPORTED_INTERACTION_GRACE_MS,
  isActiveBuildPhase,
  isBuildPipeline,
  isEnvironmentReadyForAgents,
} from "./native-agent-service-shared.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { type AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";

type BuildPipelineAgent = shared.BuildPipelineAgent;
type AgentInteractionKind = shared.AgentInteractionKind;
type AgentInteractionOrigin = shared.AgentInteractionOrigin;
type NativeAgentSessionProjection = shared.NativeAgentSessionProjection;
type PersistedNativeAgentSession = shared.PersistedNativeAgentSession;
type StorageService = shared.StorageService;
type NativeAgentRuntimeProvider = shared.NativeAgentRuntimeProvider;
type ProviderInteractionObservationEvent = shared.ProviderInteractionObservationEvent;
type EnsureNativeAgentSessionInput = shared.EnsureNativeAgentSessionInput;
type NativeAgentProjectionInput = shared.NativeAgentProjectionInput;
type NativeAgentServiceOptions = shared.NativeAgentServiceOptions;
type AgentInteractionObservation = shared.AgentInteractionObservation;

/** What the interaction tracker needs from the service that wires it. */
export interface NativeAgentInteractionTrackerHost {
  storage: StorageService;
  options: NativeAgentServiceOptions;
  /** Drop a cached provider whose reads keep failing, so the next sweep reconnects. */
  evictProvider(
    session: Pick<PersistedNativeAgentSession, "environmentId" | "agent">,
    provider: NativeAgentRuntimeProvider,
  ): void;
  now(): number;
  isStopped(): boolean;
  /** Resolve a provider for observation only, never starting a bridge. */
  observeProvider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider | undefined>;
  /** Track a background scan so shutdown drains it. */
  trackScan(task: Promise<void>): Promise<void>;
  /** The last projection built for a session, if any; purely in-memory. */
  cachedProjectionSnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): NativeAgentSessionProjection | null;
}

/**
 * Pending approvals and questions across every native session: the bounded
 * observation records published to the interaction monitor, the provider- and
 * sweep-reported detections behind them, the monitor's round-robin sweep with
 * its per-session retry back-off, and the short-lived pending-interaction read
 * cache. Observations are advisory: an interaction is answered (or denied on
 * timeout, disconnect or generation death) by its provider, never here.
 */
export class NativeAgentInteractionTracker {
  private readonly interactionObservations = new Map<string, AgentInteractionObservation>();
  private readonly trackedInteractions = new Map<
    string,
    {
      observationKey: string;
      sessionKey: string;
      expiresAt?: number;
      scan: number;
    }
  >();
  private readonly providerReportedInteractions = new Map<
    string,
    {
      observationKey: string;
      providerSessionKey: string;
      detectedAt: number;
      missingSince?: number;
    }
  >();
  private readonly interactionRetryAt = new Map<string, number>();
  private readonly interactionAttempts = new Map<string, number>();
  private readonly monitoredInteractionSessionKeys = new Set<string>();
  private readonly observedInteractionRevisions = new Map<string, number>();
  /** Round-robin offsets keep bounded scans from permanently favouring old sessions. */
  private readonly interactionSelectionCursors = new Map<string, number>();
  private interactionGlobalSelectionCursor = 0;
  private interactionScan: Promise<void> | null = null;
  private interactionScanNumber = 0;
  private interactionRevisionReconciliations = 0;
  private interactionMonitorAdoptionEnabled = true;
  private interactionTimer: ReturnType<typeof setInterval> | null = null;
  /** Short-lived cache of on-demand pending-interaction reads, per session. */
  private readonly pendingInteractionReads = new Map<
    string,
    { at: number; requests: AgentInteractionRequest[] }
  >();

  private readonly storage: StorageService;
  private readonly options: NativeAgentServiceOptions;

  constructor(private readonly host: NativeAgentInteractionTrackerHost) {
    this.storage = host.storage;
    this.options = host.options;
    this.interactionMonitorAdoptionEnabled =
      host.options.interactionMonitorAdoptionEnabled !== false;
  }

  /**
   * Start the observe-only monitor: one sweep now, then one per interval. A
   * no-op unless `interactionMonitorMode` is `"observe-only"`.
   */
  async start(): Promise<void> {
    if (this.options.interactionMonitorMode !== "observe-only") return;
    await this.reconcileAgentInteractions().catch(() => undefined);
    if (this.host.isStopped()) return;
    this.interactionTimer = setInterval(
      () => {
        void this.reconcileAgentInteractions().catch(() => undefined);
      },
      Math.max(100, this.options.interactionMonitorIntervalMs ?? 2_000),
    );
    this.interactionTimer.unref?.();
  }

  /** Stop the monitor timer; in-flight sweeps are drained by the service's scan tracking. */
  stop(): void {
    if (this.interactionTimer) clearInterval(this.interactionTimer);
    this.interactionTimer = null;
  }

  /**
   * Test-only view of the state this tracker owns. Service tests reach
   * interaction state here, never through the service.
   */
  forTesting() {
    return {
      interactionObservations: this.interactionObservations,
      trackedInteractions: this.trackedInteractions,
      providerReportedInteractions: this.providerReportedInteractions,
      interactionRetryAt: this.interactionRetryAt,
      interactionAttempts: this.interactionAttempts,
      monitoredInteractionSessionKeys: this.monitoredInteractionSessionKeys,
      observedInteractionRevisions: this.observedInteractionRevisions,
      interactionSelectionCursors: this.interactionSelectionCursors,
      pendingInteractionReads: this.pendingInteractionReads,
      interactionRevisionReconciliations: () => this.interactionRevisionReconciliations,
      interactionTimer: () => this.interactionTimer,
      interactionMonitorAdoptionEnabled: () => this.interactionMonitorAdoptionEnabled,
      recordInteractionDetection: (
        session: PersistedNativeAgentSession,
        interactionId: string,
        kind: AgentInteractionKind,
        expiresAt: number | undefined,
        scan: number,
      ) => this.recordInteractionDetection(session, interactionId, kind, expiresAt, scan),
      observationKey: (session: PersistedNativeAgentSession, kind: AgentInteractionKind) =>
        this.observationKey(session, kind),
    };
  }

  /**
   * Pending interactions of one session, for linking to the request whose turn
   * is waiting. Reads the provider's pending-interaction list at most once per
   * ten seconds per session (callers ask only while a turn is `waiting`),
   * falling back to the in-memory projection; `null` when neither is known.
   */
  forgetPendingInteractions(key: string): void {
    this.pendingInteractionReads.delete(key);
  }

  async sessionPendingInteractions(
    input: NativeAgentProjectionInput,
  ): Promise<AgentInteractionRequest[] | null> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const live = (requests: readonly AgentInteractionRequest[]) =>
      requests.filter((request) => request.state === "pending" || request.state === "answering");
    const cached = this.pendingInteractionReads.get(key);
    if (cached && cached.at > this.host.now() - 10_000) return live(cached.requests);
    const fallback = () => {
      const projection = this.host.cachedProjectionSnapshot(
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
      );
      return projection?.interactions ? live(projection.interactions) : null;
    };
    try {
      const session = await this.storage.getNativeAgentSession(key);
      if (!session) return null;
      const provider = await this.host.observeProvider(input);
      if (!provider?.interactions) return fallback();
      const snapshot = await provider.interactions.listPendingInteractions(
        session.providerSessionId,
      );
      if (!cached && this.pendingInteractionReads.size >= 128) {
        const oldest = this.pendingInteractionReads.keys().next().value;
        if (oldest !== undefined) this.pendingInteractionReads.delete(oldest);
      }
      this.pendingInteractionReads.set(key, { at: this.host.now(), requests: snapshot.requests });
      return live(snapshot.requests);
    } catch {
      return fallback();
    }
  }

  /**
   * Operational kill switch. Existing adopted sessions keep reconciling so a
   * request already observed is not stranded; no new session is adopted.
   */
  setInteractionMonitorAdoptionEnabled(enabled: boolean): void {
    this.interactionMonitorAdoptionEnabled = enabled;
  }

  /** Bounded, content-free evidence suitable for diagnostics and tests. */
  getInteractionObservations(): AgentInteractionObservation[] {
    return [...this.interactionObservations.values()].map((entry) => ({ ...entry }));
  }

  /** Close the polling race for a provider that applies an immediate legacy response. */
  recordProviderInteractionObservation(
    event: ProviderInteractionObservationEvent & {
      environmentId: string;
      provider: BuildPipelineAgent;
    },
  ): void {
    if (this.host.isStopped() || this.options.interactionMonitorMode !== "observe-only") return;
    const phase =
      event.registration.origin === "build-pipeline"
        ? "pipeline"
        : (event.registration.phase?.slice(0, 256) ?? "native-session");
    const observationKey = [event.provider, event.kind, event.registration.origin, phase].join(
      "\0",
    );
    const providerSessionKey = JSON.stringify([
      event.environmentId,
      event.provider,
      event.sessionId,
    ]);
    const trackedKey = JSON.stringify([
      event.environmentId,
      event.provider,
      event.sessionId,
      event.interactionId,
    ]);

    if (event.state === "withdrawn") {
      const tracked = this.providerReportedInteractions.get(trackedKey);
      if (!tracked) return;
      this.providerReportedInteractions.delete(trackedKey);
      const observation = this.interactionObservations.get(tracked.observationKey);
      if (!observation) return;
      const remainsBlocked =
        [...this.trackedInteractions.values()].some(
          (entry) => entry.observationKey === tracked.observationKey,
        ) ||
        [...this.providerReportedInteractions.values()].some(
          (entry) => entry.observationKey === tracked.observationKey,
        );
      if (!remainsBlocked) {
        observation.providerState = event.providerState ?? "running";
        observation.eventualOutcome = "withdrawn";
        observation.eventualAt = this.host.now();
      }
      return;
    }

    const existing = this.providerReportedInteractions.get(trackedKey);
    if (existing) {
      const observation = this.interactionObservations.get(existing.observationKey);
      if (observation) {
        observation.lastDetectedAt = this.host.now();
        observation.providerState = "blocked";
        delete observation.eventualOutcome;
        delete observation.eventualAt;
        return;
      }
      this.providerReportedInteractions.delete(trackedKey);
    }
    if (
      this.trackedInteractions.size + this.providerReportedInteractions.size >=
      INTERACTION_MONITOR_MAX_TRACKED_REQUESTS
    )
      return;
    const observation = this.ensureInteractionObservation(
      observationKey,
      event.provider,
      event.kind,
      event.registration.origin,
      phase,
    );
    observation.count += 1;
    observation.lastDetectedAt = this.host.now();
    observation.providerState = "blocked";
    delete observation.eventualOutcome;
    delete observation.eventualAt;
    this.providerReportedInteractions.set(trackedKey, {
      observationKey,
      providerSessionKey,
      detectedAt: this.host.now(),
    });
    this.emitInteractionObservation(observation);
  }

  /**
   * Reconcile provider-owned pending requests without applying policy.
   *
   * This is deliberately independent of renderer lifecycle and uses only
   * authoritative snapshots. Polling adapters have no subscribe/replay gap:
   * anything that arrives after one snapshot is recovered by the next.
   */
  reconcileAgentInteractions(): Promise<void> {
    if (this.host.isStopped() || this.options.interactionMonitorMode !== "observe-only")
      return Promise.resolve();
    recurringWorkMetrics.requested("native-interaction-observe");
    if (this.interactionScan) {
      recurringWorkMetrics.coalesced("native-interaction-observe");
      return this.interactionScan;
    }
    const scan = this.host
      .trackScan(
        recurringWorkMetrics.observe("native-interaction-observe", () =>
          this.reconcileAgentInteractionsOnce(),
        ),
      )
      .finally(() => {
        if (this.interactionScan === scan) this.interactionScan = null;
      });
    this.interactionScan = scan;
    return scan;
  }

  private interactionPhase(session: PersistedNativeAgentSession): string {
    if (session.origin === "looped-review") {
      const segments = session.logicalSessionKey.split(":");
      const phase = segments[2];
      if (phase && phase.length <= 256) return phase;
    }
    return session.origin === "build-pipeline" ? "pipeline" : "native-session";
  }

  private observationKey(session: PersistedNativeAgentSession, kind: AgentInteractionKind): string {
    return [session.agent, kind, session.origin, this.interactionPhase(session)].join("\0");
  }

  private evictInteractionObservation(key: string): void {
    this.interactionObservations.delete(key);
    for (const [trackedKey, tracked] of this.trackedInteractions) {
      if (tracked.observationKey === key) this.trackedInteractions.delete(trackedKey);
    }
    for (const [trackedKey, tracked] of this.providerReportedInteractions) {
      if (tracked.observationKey === key) this.providerReportedInteractions.delete(trackedKey);
    }
  }

  private ensureInteractionObservation(
    key: string,
    provider: BuildPipelineAgent,
    kind: AgentInteractionKind,
    workflowSurface: AgentInteractionOrigin,
    phase: string,
  ): AgentInteractionObservation {
    const existing = this.interactionObservations.get(key);
    if (existing) return existing;
    if (this.interactionObservations.size >= INTERACTION_MONITOR_MAX_OBSERVATIONS) {
      const oldest = [...this.interactionObservations.entries()].sort(
        ([, left], [, right]) => left.lastDetectedAt - right.lastDetectedAt,
      )[0]?.[0];
      if (oldest) this.evictInteractionObservation(oldest);
    }
    const now = this.host.now();
    const observation: AgentInteractionObservation = {
      provider,
      kind,
      workflowSurface,
      phase,
      firstDetectedAt: now,
      lastDetectedAt: now,
      count: 0,
      providerState: "blocked",
    };
    this.interactionObservations.set(key, observation);
    return observation;
  }

  private emitInteractionObservation(observation: AgentInteractionObservation): void {
    // A diagnostic consumer must never delay or fail provider reconciliation.
    try {
      void Promise.resolve(this.options.onInteractionObservation?.({ ...observation })).catch(
        () => undefined,
      );
    } catch {
      // Synchronous telemetry failures are isolated too.
    }
  }

  private recordInteractionDetection(
    session: PersistedNativeAgentSession,
    interactionId: string,
    kind: AgentInteractionKind,
    expiresAt: number | undefined,
    scan: number,
  ): void {
    const trackedKey = `${session.key}\0${interactionId}`;
    const existingTrack = this.trackedInteractions.get(trackedKey);
    if (existingTrack) {
      existingTrack.scan = scan;
      existingTrack.expiresAt = expiresAt;
      const observation = this.interactionObservations.get(existingTrack.observationKey);
      if (observation) {
        observation.lastDetectedAt = this.host.now();
        observation.providerState = "blocked";
        delete observation.eventualOutcome;
        delete observation.eventualAt;
        return;
      }
      this.trackedInteractions.delete(trackedKey);
    }
    if (
      this.trackedInteractions.size + this.providerReportedInteractions.size >=
      INTERACTION_MONITOR_MAX_TRACKED_REQUESTS
    ) {
      return;
    }
    const key = this.observationKey(session, kind);
    const now = this.host.now();
    const observation = this.ensureInteractionObservation(
      key,
      session.agent,
      kind,
      session.origin,
      this.interactionPhase(session),
    );
    observation.count += 1;
    observation.lastDetectedAt = now;
    observation.providerState = "blocked";
    delete observation.eventualOutcome;
    delete observation.eventualAt;
    this.trackedInteractions.set(trackedKey, {
      observationKey: key,
      sessionKey: session.key,
      expiresAt,
      scan,
    });
    this.emitInteractionObservation(observation);
  }

  private settleMissingInteractions(
    session: PersistedNativeAgentSession,
    scan: number,
    providerState: AgentInteractionObservation["providerState"],
  ): void {
    const prefix = `${session.key}\0`;
    const removed = new Map<string, { expiresAt?: number }>();
    for (const [trackedKey, tracked] of this.trackedInteractions) {
      if (!trackedKey.startsWith(prefix) || tracked.scan === scan) continue;
      removed.set(tracked.observationKey, { expiresAt: tracked.expiresAt });
      this.trackedInteractions.delete(trackedKey);
    }
    this.finalizeRemovedInteractions(removed, providerState);
  }

  private finalizeRemovedInteractions(
    removed: ReadonlyMap<string, { expiresAt?: number }>,
    providerState: AgentInteractionObservation["providerState"],
  ): void {
    if (removed.size === 0) return;
    const stillBlocked = new Set(
      [...this.trackedInteractions.values(), ...this.providerReportedInteractions.values()].map(
        (tracked) => tracked.observationKey,
      ),
    );
    const now = this.host.now();
    for (const [observationKey, tracked] of removed) {
      const observation = this.interactionObservations.get(observationKey);
      if (!observation) continue;
      if (stillBlocked.has(observationKey)) {
        observation.providerState = "blocked";
        delete observation.eventualOutcome;
        delete observation.eventualAt;
        continue;
      }
      observation.providerState = providerState;
      observation.eventualOutcome =
        tracked.expiresAt !== undefined && tracked.expiresAt <= now ? "expired" : "withdrawn";
      observation.eventualAt = now;
    }
  }

  private releaseMonitoredInteractionSession(
    key: string,
    providerState: AgentInteractionObservation["providerState"] = "missing",
  ): void {
    this.monitoredInteractionSessionKeys.delete(key);
    this.observedInteractionRevisions.delete(key);
    this.interactionRetryAt.delete(key);
    this.interactionAttempts.delete(key);
    const prefix = `${key}\0`;
    const removed = new Map<string, { expiresAt?: number }>();
    for (const [trackedKey, tracked] of this.trackedInteractions) {
      if (!trackedKey.startsWith(prefix)) continue;
      removed.set(tracked.observationKey, { expiresAt: tracked.expiresAt });
      this.trackedInteractions.delete(trackedKey);
    }
    this.finalizeRemovedInteractions(removed, providerState);
  }

  private async reconcileAgentInteractionsOnce(): Promise<void> {
    const [environments, nativeSessions, pipelineRecords] = await Promise.all([
      this.storage.loadEnvironments(),
      this.storage.listNativeAgentSessions(),
      this.storage.listAllBuildPipelines(),
    ]);
    if (this.host.isStopped()) return;
    const environmentIds = new Set(
      environments
        .filter(
          (environment) =>
            isEnvironmentReadyForAgents(environment) && !environment.deletionRequestedAt,
        )
        .map((environment) => environment.id),
    );
    const pipelineSessions: PersistedNativeAgentSession[] = [];
    for (const record of pipelineRecords) {
      if (!isBuildPipeline(record.snapshot) || !isActiveBuildPhase(record.snapshot.phase)) {
        continue;
      }
      const current = record.snapshot.sessions[record.snapshot.currentSessionIndex];
      if (!current || current.status !== "running") continue;
      pipelineSessions.push({
        version: 1,
        key: `build-pipeline:${record.snapshot.id}:${current.sessionKey}`,
        environmentId: record.snapshot.environmentId,
        agent: current.agent ?? record.snapshot.agentType,
        logicalSessionKey: current.phase,
        providerSessionId: current.sdkSessionId,
        origin: current.origin ?? "build-pipeline",
        interactionPolicy: current.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
        createdAt: current.startedAt,
        updatedAt: current.startedAt,
      });
    }
    const allSessions = [...nativeSessions, ...pipelineSessions];
    const eligibleSessions = allSessions.filter(
      (session) =>
        session.interactionPolicy.mode === "unattended" &&
        environmentIds.has(session.environmentId),
    );
    const liveProviderSessions = new Set(
      eligibleSessions.map((session) =>
        JSON.stringify([session.environmentId, session.agent, session.providerSessionId]),
      ),
    );
    const providerReportSweepAt = this.host.now();
    for (const [trackedKey, tracked] of this.providerReportedInteractions) {
      if (providerReportSweepAt - tracked.detectedAt >= PROVIDER_REPORTED_INTERACTION_GRACE_MS) {
        this.providerReportedInteractions.delete(trackedKey);
        const observation = this.interactionObservations.get(tracked.observationKey);
        if (!observation) continue;
        const remainsBlocked =
          [...this.trackedInteractions.values()].some(
            (entry) => entry.observationKey === tracked.observationKey,
          ) ||
          [...this.providerReportedInteractions.values()].some(
            (entry) => entry.observationKey === tracked.observationKey,
          );
        if (!remainsBlocked) {
          observation.providerState = "missing";
          observation.eventualOutcome = "withdrawn";
          observation.eventualAt = providerReportSweepAt;
        }
        continue;
      }
      if (liveProviderSessions.has(tracked.providerSessionKey)) {
        delete tracked.missingSince;
        continue;
      }
      // A provider can report detection, wait for the owner to durably fail an
      // unattended workflow, and only then withdraw the upstream request. The
      // durable failure removes the session from the active-pipeline snapshot,
      // so retain this bounded direct record briefly for that terminal event.
      // Without the grace period, a concurrent scan stamps `missing` and makes
      // the provider's authoritative `withdrawn/error` event a no-op.
      tracked.missingSince ??= providerReportSweepAt;
      if (providerReportSweepAt - tracked.missingSince < PROVIDER_REPORTED_INTERACTION_GRACE_MS)
        continue;
      this.providerReportedInteractions.delete(trackedKey);
      const observation = this.interactionObservations.get(tracked.observationKey);
      if (!observation) continue;
      const remainsBlocked =
        [...this.trackedInteractions.values()].some(
          (entry) => entry.observationKey === tracked.observationKey,
        ) ||
        [...this.providerReportedInteractions.values()].some(
          (entry) => entry.observationKey === tracked.observationKey,
        );
      if (!remainsBlocked) {
        observation.providerState = "missing";
        observation.eventualOutcome = "withdrawn";
        observation.eventualAt = this.host.now();
      }
    }
    const eligibleEnvironmentIds = new Set(
      eligibleSessions.map((session) => session.environmentId),
    );
    const liveKeys = new Set(eligibleSessions.map((session) => session.key));
    const removedInactiveTracks = new Map<string, { expiresAt?: number }>();
    for (const [trackedKey, tracked] of this.trackedInteractions) {
      if (liveKeys.has(tracked.sessionKey)) continue;
      this.trackedInteractions.delete(trackedKey);
      removedInactiveTracks.set(tracked.observationKey, {
        expiresAt: tracked.expiresAt,
      });
    }
    this.finalizeRemovedInteractions(removedInactiveTracks, "missing");
    for (const key of this.monitoredInteractionSessionKeys) {
      if (liveKeys.has(key)) continue;
      this.releaseMonitoredInteractionSession(key);
    }
    for (const key of this.interactionRetryAt.keys()) {
      if (liveKeys.has(key)) continue;
      this.interactionRetryAt.delete(key);
      this.interactionAttempts.delete(key);
    }
    for (const key of this.interactionSelectionCursors.keys()) {
      const environmentId = key.split("\0", 1)[0];
      if (environmentId && eligibleEnvironmentIds.has(environmentId)) continue;
      this.interactionSelectionCursors.delete(key);
    }
    const maxPerEnvironment = Math.max(
      1,
      this.options.interactionMonitorMaxSessionsPerEnvironment ??
        INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT,
    );
    const byEnvironment = new Map<string, PersistedNativeAgentSession[]>();
    const candidatesByEnvironment = new Map<string, PersistedNativeAgentSession[]>();
    for (const session of eligibleSessions) {
      if (
        !this.interactionMonitorAdoptionEnabled &&
        !this.monitoredInteractionSessionKeys.has(session.key)
      )
        continue;
      const candidates = candidatesByEnvironment.get(session.environmentId) ?? [];
      candidates.push(session);
      candidatesByEnvironment.set(session.environmentId, candidates);
    }
    const locallySelected: PersistedNativeAgentSession[] = [];
    for (const [environmentId, candidates] of candidatesByEnvironment) {
      const selected: PersistedNativeAgentSession[] = [];
      const pipelineCandidates = candidates.filter((session) =>
        session.key.startsWith("build-pipeline:"),
      );
      // With more than one slot, an active pipeline receives one reserved slot.
      // A one-slot configuration rotates across both classes so native work is
      // not permanently hidden by a long-running pipeline.
      if (maxPerEnvironment === 1) {
        const singleSlotCandidates = [
          ...pipelineCandidates,
          ...candidates.filter((session) => !session.key.startsWith("build-pipeline:")),
        ];
        const cursor = this.interactionSelectionCursors.get(environmentId) ?? 0;
        if (singleSlotCandidates.length > 0) {
          selected.push(singleSlotCandidates[cursor % singleSlotCandidates.length]!);
        }
        this.interactionSelectionCursors.set(
          environmentId,
          singleSlotCandidates.length > 0 ? (cursor + 1) % singleSlotCandidates.length : 0,
        );
      } else if (pipelineCandidates.length > 0) {
        const cursorKey = `${environmentId}\0pipeline`;
        const cursor = this.interactionSelectionCursors.get(cursorKey) ?? 0;
        selected.push(pipelineCandidates[cursor % pipelineCandidates.length]!);
        this.interactionSelectionCursors.set(cursorKey, (cursor + 1) % pipelineCandidates.length);
      }
      if (maxPerEnvironment > 1) {
        const remaining = candidates.filter(
          (candidate) => !selected.some((session) => session.key === candidate.key),
        );
        const cursor = this.interactionSelectionCursors.get(environmentId) ?? 0;
        for (
          let offset = 0;
          offset < remaining.length && selected.length < maxPerEnvironment;
          offset += 1
        ) {
          selected.push(remaining[(cursor + offset) % remaining.length]!);
        }
        if (remaining.length > 0) {
          const reserved = pipelineCandidates.length > 0 ? 1 : 0;
          this.interactionSelectionCursors.set(
            environmentId,
            (cursor + Math.max(1, maxPerEnvironment - reserved)) % remaining.length,
          );
        }
      }
      locallySelected.push(...selected);
    }

    let globallySelected = locallySelected;
    if (locallySelected.length > INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS) {
      const cursor = this.interactionGlobalSelectionCursor % locallySelected.length;
      globallySelected = Array.from(
        { length: INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS },
        (_, offset) => locallySelected[(cursor + offset) % locallySelected.length]!,
      );
      this.interactionGlobalSelectionCursor =
        (cursor + INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS) % locallySelected.length;
    } else {
      this.interactionGlobalSelectionCursor = 0;
    }
    const selectedKeys = new Set(globallySelected.map((session) => session.key));
    if (this.interactionMonitorAdoptionEnabled) {
      // Enabled-mode adoption is a bounded lease. Retain request evidence while
      // rotating the lease; a later authoritative snapshot settles it.
      for (const key of this.monitoredInteractionSessionKeys) {
        if (selectedKeys.has(key)) continue;
        this.monitoredInteractionSessionKeys.delete(key);
        this.observedInteractionRevisions.delete(key);
      }
    }
    for (const session of globallySelected) {
      if (!this.monitoredInteractionSessionKeys.has(session.key)) {
        if (!this.interactionMonitorAdoptionEnabled) continue;
        this.monitoredInteractionSessionKeys.add(session.key);
      }
      const group = byEnvironment.get(session.environmentId) ?? [];
      group.push(session);
      byEnvironment.set(session.environmentId, group);
    }

    const scan = ++this.interactionScanNumber;
    const groups = [...byEnvironment.values()];
    let nextEnvironment = 0;
    const worker = async (): Promise<void> => {
      while (!this.host.isStopped()) {
        const sessions = groups[nextEnvironment++];
        if (!sessions) return;
        // One environment is processed serially, explicitly bounding its
        // concurrent monitor work at one while global workers handle others.
        for (const session of sessions) {
          const retryKey = session.key;
          if ((this.interactionRetryAt.get(retryKey) ?? 0) > this.host.now()) continue;
          let provider: NativeAgentRuntimeProvider | undefined;
          try {
            provider = await this.host.observeProvider(session);
            if (!provider) {
              this.settleMissingInteractions(session, scan, "missing");
              this.interactionAttempts.delete(retryKey);
              this.interactionRetryAt.delete(retryKey);
              continue;
            }
            if (!provider.interactions) {
              this.settleMissingInteractions(session, scan, "error");
              this.interactionAttempts.delete(retryKey);
              this.interactionRetryAt.delete(retryKey);
              continue;
            }
            provider.registerSession?.(session.providerSessionId, {
              origin: session.origin,
              interactionPolicy: session.interactionPolicy,
              phase: this.interactionPhase(session),
            });
            const snapshot = await provider.interactions.listPendingInteractions(
              session.providerSessionId,
            );
            const previousRevision = this.observedInteractionRevisions.get(session.key);
            if (
              previousRevision !== undefined &&
              snapshot.revision !== previousRevision &&
              snapshot.revision !== previousRevision + 1
            ) {
              // A gap, reset, or bridge-generation change is already reconciled:
              // this is the full authoritative snapshot, never a live-event delta.
              this.interactionRevisionReconciliations = Math.min(
                Number.MAX_SAFE_INTEGER,
                this.interactionRevisionReconciliations + 1,
              );
            }
            this.observedInteractionRevisions.set(session.key, snapshot.revision);
            for (const request of snapshot.requests) {
              this.recordInteractionDetection(
                session,
                request.id,
                request.kind,
                request.expiresAt,
                scan,
              );
            }
            let providerState: AgentInteractionObservation["providerState"] =
              snapshot.requests.length > 0 ? "blocked" : "idle";
            if (snapshot.requests.length === 0) {
              try {
                // A terminal turn error is an observation, not a read fault:
                // it settles the withdrawn cards as `error` without putting the
                // whole interaction scan into retry backoff.
                providerState = (await readProviderStatus(provider, session.providerSessionId))
                  .status;
              } catch (error) {
                // The empty authoritative snapshot already proves withdrawal;
                // a failed auxiliary status read must not preserve stale cards.
                this.settleMissingInteractions(session, scan, "error");
                throw error;
              }
            }
            this.settleMissingInteractions(session, scan, providerState);
            this.interactionAttempts.delete(retryKey);
            this.interactionRetryAt.delete(retryKey);
          } catch (error) {
            const attempts = Math.min(
              Math.max(
                1,
                this.options.interactionMonitorMaxRetries ??
                  INTERACTION_MONITOR_DEFAULT_MAX_RETRIES,
              ),
              (this.interactionAttempts.get(retryKey) ?? 0) + 1,
            );
            this.interactionAttempts.set(retryKey, attempts);
            const base = Math.max(
              1,
              this.options.interactionMonitorRetryBaseMs ??
                INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS,
            );
            this.interactionRetryAt.set(
              retryKey,
              this.host.now() + Math.min(60_000, base * 2 ** Math.max(0, attempts - 1)),
            );
            if (provider) this.host.evictProvider(session, provider);
            console.warn(
              `[native-agent] Interaction observation for ${session.agent} failed:`,
              error instanceof Error ? error.name : "unknown error",
            );
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            Math.max(
              1,
              this.options.interactionMonitorMaxConcurrency ??
                INTERACTION_MONITOR_DEFAULT_CONCURRENCY,
            ),
            groups.length,
          ),
        },
        () => worker(),
      ),
    );
  }
}
