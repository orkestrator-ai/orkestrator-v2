import type {
  BuildPipelineAgent,
  AgentActivityState,
  Environment,
  PersistedNativeAgentSession,
  StorageService,
  NativeAgentRuntimeProvider,
  CommandInvoker,
  EnsureNativeAgentSessionInput,
  DispatchNativeAgentPromptInput,
  NativeAgentServiceOptions,
  PromptDispatchPreparation,
} from "./native-agent-service-shared.js";
import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import { bugReportRuntimeEnvironment } from "./bug-report-runtime.js";
import {
  nativeAgentSessionStorageKey,
  isEnvironmentReadyForAgents,
  ACTIVITY_RETRY_BASE_MS,
  ACTIVITY_RETRY_CEILING_MS,
  ACTIVITY_STATUS_CONCURRENCY,
  LAUNCH_RETRY_MS,
  aggregateAgentActivityState,
  resolveAgentPlatformSettings,
  resolveStartupLaunchFromSettings,
} from "./native-agent-service-shared.js";
import {
  coordinatorIdFromRuntimeId,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { nativeAsyncQuestionItemId } from "@orkestrator/protocol/native-agent";
import { coordinatorRuntimeEnvironment } from "./coordinator-runtime.js";
import { ProviderRegistry, providerCacheKey } from "./native-agent-provider-registry.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import {
  NativeAgentObservationBroker,
  nativeAgentObservationGroupKey,
  observationSatisfies,
  nativeAgentObservationCapabilities,
  QUEUE_BUSY_OBSERVATION_MAX_AGE_MS,
  type NativeAgentObservationDemand,
  type NativeAgentObservationTicket,
  type NativeAgentObservationStatus,
  type NativeAgentObservationView,
  type NativeAgentObservationWakeReason,
} from "./native-agent-observation.js";
import { NativeAgentTurnRecovery } from "./native-agent-turn-recovery.js";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  TURN_STOPPED_BY_USER_MESSAGE,
} from "./agent-provider-contract.js";
import { claudeNativeParameterValues } from "@orkestrator/protocol/agent-settings";
import {
  buildInitialPromptWithAttachmentReferences,
  type SavedInitialPromptAttachment,
} from "@orkestrator/protocol/initial-prompt-attachments";
import { buildTerminalAgentLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import { readActivityGroup } from "./native-agent-activity-reads.js";
import type { ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { queueString } from "./native-agent-queue-message.js";

/**
 * How long after a requested stop a missing bridge is put down to that stop.
 * Longer than a drain and `docker stop` take. Exemptions also name the stopped
 * requests and bridge generation, so a replacement never inherits this window.
 */
export const RUNTIME_STOP_REQUEST_WINDOW_MS = 2 * 60_000;

type ObservedSessionActivity = {
  providerSessionId: string;
  state: AgentActivityState;
  readyForInput?: boolean;
  completionPending?: boolean;
  /** The provider content revision at this observation, when reported. */
  contentRevision?: string;
  /**
   * Settled to idle because the session's runtime stopped while its turn was
   * still working or waiting (`settleStoppedSessions`), not observed idle.
   * The next real observation replaces the whole record and so clears it.
   */
  stoppedMidTurn?: true;
  /** Request that started this turn; later steering IDs do not replace it. */
  activeRequestId?: string;
};

type PrepareDispatch = (
  session: PersistedNativeAgentSession,
  provider: NativeAgentRuntimeProvider,
) => Promise<PromptDispatchPreparation>;

/** What the launch and activity reconciler needs from the service that wires it. */
export interface NativeAgentLaunchActivityReconcilerHost {
  storage: StorageService;
  invoke: CommandInvoker;
  options: NativeAgentServiceOptions;
  providerRegistry: ProviderRegistry;
  observations: NativeAgentObservationBroker;
  turnRecovery: NativeAgentTurnRecovery;
  now(): number;
  isStopped(): boolean;
  /** Resolve a provider for observation only, never starting a bridge. */
  observeProvider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider | undefined>;
  /** Track a background scan so shutdown drains it. */
  trackScan(task: Promise<void>): Promise<void>;
  recordAsyncQuestionAttention(
    environmentId: string,
    sessionKey: string,
    itemIds: readonly string[],
  ): Promise<void>;
  /** Drop a stopped environment's outstanding requests from every cached view. */
  withdrawEnvironmentInteractions(environmentId: string): void;
  /**
   * Answer the requests of a session seen `waiting` that an Orkestrator
   * permission rule covers (todo 0723), so a rule applies with no tab mounted
   * and before the waiting edge is announced. `null` when nothing was read.
   */
  applyPermissionRules?(
    session: PersistedNativeAgentSession,
    provider: NativeAgentRuntimeProvider,
  ): Promise<{ answered: number; remaining: number } | null>;
  /** The service's public prompt dispatch. */
  dispatchPrompt(input: DispatchNativeAgentPromptInput): Promise<PersistedNativeAgentSession>;
  /** Prompt dispatch with a preparation step run against the resolved session. */
  dispatchPromptWithPreparation(
    input: DispatchNativeAgentPromptInput,
    prepare: PrepareDispatch,
  ): Promise<PersistedNativeAgentSession>;
}

/**
 * Background reconciliation of what providers are doing: the activity sweep
 * and its exact turn edges (`observedSessionActivity`), per-group back-off,
 * PR-monitor completion notifications, and the startup-launch scan with its
 * per-environment retry. Runs whether or not any renderer is subscribed;
 * providers stay authoritative and every sweep re-reads them.
 */
export class NativeAgentLaunchActivityReconciler {
  private readonly launchTasks = new Map<string, Promise<void>>();
  private readonly launchRetryAt = new Map<string, number>();
  private readonly activityRetryAt = new Map<string, number>();
  private readonly activityAttempts = new Map<string, number>();
  /** Last provider-owned state per durable session, used for exact turn edges. */
  private readonly observedSessionActivity = new Map<string, ObservedSessionActivity>();
  /**
   * Environments whose exact completion edge has not yet reached the PR
   * monitor. Delivery is retried by later sweeps, while the set coalesces
   * simultaneous session completions into one environment notification.
   */
  private readonly pendingPrRefreshEnvironmentIds = new Set<string>();
  /**
   * Stopped container environments whose sessions the sweep has already
   * settled, so it does so once per stop rather than on every pass.
   */
  private readonly settledStoppedEnvironments = new Set<string>();
  /** Independent of provider generations, which resolution may legitimately re-anchor. */
  private readonly stopEpochs = new Map<string, number>();
  /** Environments this process has swept at least once. */
  private readonly sweptEnvironments = new Set<string>();
  /**
   * Environments whose durable `working` predates this process, until each of
   * their sessions has an observation or the aggregate has moved on. A session
   * first answering idle in one may have ended a turn no sweep watched end.
   */
  private readonly unwatchedWorkingEnvironments = new Set<string>();
  /** Until when a bridge going away is a stop someone asked for, not a crash. */
  private readonly runtimeStopRequests = new Map<
    string,
    {
      until: number;
      connection?: string;
      provider?: NativeAgentRuntimeProvider;
      requests: Map<string, { providerSessionId: string; requestId?: string }>;
    }
  >();
  /** Exact attention already written while an aggregate commit is withheld. */
  private readonly pendingAttentionEnvironments = new Set<string>();
  private activityScan: Promise<void> | null = null;
  /** Number of the latest sweep started; demands compare against it. */
  private activityScanNumber = 0;
  /** One follow-up scan shared by every consumer demanding a newer read. */
  private activityScanFollowUp: Promise<void> | null = null;
  private launchTimer: ReturnType<typeof setInterval> | null = null;

  private readonly storage: StorageService;
  private readonly invoke: CommandInvoker;
  private readonly options: NativeAgentServiceOptions;
  private readonly providerRegistry: ProviderRegistry;
  private readonly observations: NativeAgentObservationBroker;
  private readonly turnRecovery: NativeAgentTurnRecovery;

  constructor(private readonly host: NativeAgentLaunchActivityReconcilerHost) {
    this.storage = host.storage;
    this.invoke = host.invoke;
    this.options = host.options;
    this.providerRegistry = host.providerRegistry;
    this.observations = host.observations;
    this.turnRecovery = host.turnRecovery;
  }

  /** The last provider-owned activity observed for a durable session. */
  observedActivity(sessionKey: string): ObservedSessionActivity | undefined {
    return this.observedSessionActivity.get(sessionKey);
  }

  /**
   * Record an activity edge observed outside the sweep: provider acceptance
   * of a dispatch (`working`) or a confirmed idle provider before a move.
   */
  recordObservedActivity(sessionKey: string, activity: ObservedSessionActivity): void {
    if (activity.state === "working") {
      for (const stop of this.runtimeStopRequests.values()) stop.requests.delete(sessionKey);
    }
    this.observedSessionActivity.set(sessionKey, activity);
  }

  /**
   * The backend is about to stop this environment's bridges on purpose. Called
   * before the stop, because a sweep can find a bridge gone before the stop
   * commits. It only keeps the sweep from reading that as a crash; a stop that
   * leaves the bridge running changes nothing and the window just lapses.
   */
  async runtimeStopRequested(environmentId: string, agent?: BuildPipelineAgent): Promise<void> {
    const sessions = await this.storage.listNativeAgentSessions();
    const requestedGroups = new Set<string>();
    for (const session of sessions) {
      if (session.environmentId !== environmentId || (agent && session.agent !== agent)) continue;
      const groupKey = `${environmentId}\0${session.agent}`;
      let stop = this.runtimeStopRequests.get(groupKey);
      if (!requestedGroups.has(groupKey)) {
        requestedGroups.add(groupKey);
        stop = {
          until: this.host.now() + RUNTIME_STOP_REQUEST_WINDOW_MS,
          connection: this.providerRegistry.connectionIdentity(groupKey),
          provider: this.providerRegistry.cached(groupKey),
          requests: new Map(),
        };
        this.runtimeStopRequests.set(groupKey, stop);
      }
      stop!.requests.set(session.key, {
        providerSessionId: session.providerSessionId,
        requestId: latestRequestId(session),
      });
    }
  }

  private runtimeStopPending(session: PersistedNativeAgentSession): boolean {
    const groupKey = `${session.environmentId}\0${session.agent}`;
    const stop = this.runtimeStopRequests.get(groupKey);
    if (!stop) return false;
    const connection = this.providerRegistry.connectionIdentity(groupKey);
    if (
      stop.until <= this.host.now() ||
      (connection !== undefined && connection !== stop.connection) ||
      (this.providerRegistry.cached(groupKey) !== undefined &&
        this.providerRegistry.cached(groupKey) !== stop.provider)
    ) {
      this.runtimeStopRequests.delete(groupKey);
      return false;
    }
    const request = stop.requests.get(session.key);
    return (
      request?.providerSessionId === session.providerSessionId &&
      request.requestId === latestRequestId(session)
    );
  }

  /**
   * Whether a session whose bridge has gone lost a running turn, asked only on
   * a completion edge. A session seen working did not finish, unless the user
   * had already stopped that turn. A session this process never saw has no
   * edge of its own: it counts only where the durable aggregate says something
   * was working, and only with a dispatched turn that has no recorded end.
   */
  private bridgeLostTurn(
    session: PersistedNativeAgentSession,
    unwatchedWorking: boolean,
  ): () => Promise<boolean> {
    return async () => {
      const observed = this.observedSessionActivity.get(session.key);
      // The stop's write may be newer than the sweep's session list.
      const current = (await this.storage.getNativeAgentSession(session.key)) ?? session;
      if (this.runtimeStopPending(current)) return false;
      if (observed?.providerSessionId === session.providerSessionId && observed.state === "working")
        return (
          !latestTurnStopped(current) &&
          !current.turnOutcomes?.some(
            (entry) =>
              entry.requestId === latestRequestId(current) && entry.outcome === "completed",
          )
        );
      return observed === undefined && unwatchedWorking && hasUnsettledTurn(current);
    };
  }

  /** Forget a provider group's back-off when its provider is retired. */
  forgetActivityGroup(cacheKey: string): void {
    this.activityRetryAt.delete(cacheKey);
    this.activityAttempts.delete(cacheKey);
  }

  /** One observed launch scan; the timer-driven sweep. */
  launchScan(): Promise<void> {
    return this.observedLaunchScan();
  }

  /** The keyed scheduler's launch job: resolves with environments still holding an intent. */
  countedLaunchScan(): Promise<number> {
    return this.trackCount(this.observedLaunchCount());
  }

  /**
   * The rollback driver: one interval running the launch scan and
   * `queueScan`. The keyed queue scheduler replaces it when enabled.
   */
  startTimer(intervalMs: number, queueScan: () => Promise<void>): void {
    this.launchTimer = setInterval(() => {
      if (this.host.isStopped()) return;
      void this.host.trackScan(this.observedLaunchScan()).catch(() => undefined);
      void this.host.trackScan(queueScan()).catch(() => undefined);
    }, intervalMs);
    this.launchTimer.unref?.();
  }

  stopTimer(): void {
    if (this.launchTimer) clearInterval(this.launchTimer);
    this.launchTimer = null;
  }

  /** Startup launches still running, for shutdown to drain. */
  pendingLaunchTasks(): Promise<void>[] {
    return [...this.launchTasks.values()];
  }

  /**
   * Test-only view of the state this reconciler owns. Service tests reach
   * launch and activity state here, never through the service.
   */
  forTesting() {
    return {
      launchTasks: this.launchTasks,
      launchRetryAt: this.launchRetryAt,
      activityRetryAt: this.activityRetryAt,
      activityAttempts: this.activityAttempts,
      observedSessionActivity: this.observedSessionActivity,
      pendingPrRefreshEnvironmentIds: this.pendingPrRefreshEnvironmentIds,
      launchTimer: () => this.launchTimer,
      reconcilePendingLaunches: () => this.reconcilePendingLaunches(),
      reconcileAgentActivityOnce: () => this.reconcileAgentActivityOnce(),
    };
  }

  /** Neither sweep has an overlap guard; every tick is a full started pass. */
  private observedLaunchScan(): Promise<void> {
    recurringWorkMetrics.requested("native-launch-scan");
    return recurringWorkMetrics
      .observe("native-launch-scan", () => this.reconcilePendingLaunches())
      .then(() => undefined);
  }

  /** The keyed launch job: the scheduler already observes it as one attempt. */
  private observedLaunchCount(): Promise<number> {
    return this.reconcilePendingLaunches();
  }

  /** Tracks a counted scan so shutdown drains it like any other scan. */
  private async trackCount(task: Promise<number>): Promise<number> {
    let count = 0;
    await this.host.trackScan(
      task.then((value) => {
        count = value;
      }),
    );
    return count;
  }
  sessionActivitySnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): AgentActivityState | "unknown" {
    const observed = this.observedSessionActivity.get(
      nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
    );
    return observed?.state ?? "unknown";
  }

  /**
   * Activity as the *turn* consumers read it, with background work removed.
   *
   * {@link sessionActivitySnapshot} answers what the environment indicator
   * shows, and a bridge reports `working` there for as long as tasks the
   * session launched are alive — a backgrounded dev server or file watcher can
   * hold that for the rest of the session. The parent turn has still ended and
   * the composer is still free, which the bridge reports separately as
   * `readyForInput`.
   *
   * Everything that gates on "can this session take a prompt right now" must
   * read that release rather than the raw state. Mail injection only claims a
   * message for an `idle` mailbox, so without this collapse one long-lived
   * background process would silence a worker for as long as it runs.
   */
  sessionTurnActivitySnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): AgentActivityState | "unknown" {
    const observed = this.observedSessionActivity.get(
      nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
    );
    if (!observed) return "unknown";
    return observed.state === "working" && observed.readyForInput === true
      ? "idle"
      : observed.state;
  }

  /** Whether the session's last turn was cut off by its runtime stopping. */
  sessionStoppedMidTurn(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): boolean {
    return (
      this.observedSessionActivity.get(
        nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
      )?.stoppedMidTurn === true
    );
  }

  /**
   * An environment's runtime stopped, and its bridges with it: no turn of
   * its sessions is running any more and no parked request can be answered.
   *
   * The sweep skips environments that are not ready, so without this the
   * last observation outlived the stop: a session seen `waiting` stayed
   * `waiting`, `session send` refused it as busy and a move was refused as
   * running. Each session is settled to `idle` *quietly*. No activity
   * transition is announced, because a turn that was cut off did not finish:
   * announcing one would report a worker's turn as done to its coordinator,
   * drain queued prompts into a stopped environment and probe for a PR. No
   * completion is recorded, and the next start reads `idle` against `idle`,
   * so it fires no "finished" edge either. Views are told to re-read
   * (`onObservationInvalidation`). The transient `stoppedMidTurn` describes
   * the last observation; request-scoped interrupt records retain the evidence
   * for run observers across restart and subsequent dispatches.
   *
   * Reads already in flight are fenced first, so a pre-stop `working` cannot
   * land after the settle.
   */
  async settleStoppedSessions(
    environmentId: string,
    sessions: readonly PersistedNativeAgentSession[],
  ): Promise<void> {
    for (const groupKey of this.runtimeStopRequests.keys()) {
      if (groupKey.startsWith(`${environmentId}\0`)) this.runtimeStopRequests.delete(groupKey);
    }
    this.stopEpochs.set(environmentId, (this.stopEpochs.get(environmentId) ?? 0) + 1);
    this.observations.replaceEnvironmentGenerations(environmentId);
    const interruptions: Promise<unknown>[] = [];
    for (const session of sessions) {
      if (session.environmentId !== environmentId) continue;
      const observed = this.observedSessionActivity.get(session.key);
      if (!observed || observed.providerSessionId !== session.providerSessionId) continue;
      // A retained record would still answer "waiting" to a fresh demand.
      this.observations.forget(session.key);
      if (observed.state === "idle") continue;
      const turnWasRunning = observed.state === "waiting" || observed.readyForInput !== true;
      if (turnWasRunning) {
        // Older/adopted busy sessions have no acceptance edge in this process.
        const requestId = observed.activeRequestId ?? session.dispatchedRequestIds?.at(-1);
        if (requestId) {
          interruptions.push(
            this.storage.recordNativeAgentTurnInterrupt(
              session.key,
              session.providerSessionId,
              requestId,
            ),
          );
        }
      }
      this.observedSessionActivity.set(session.key, {
        providerSessionId: session.providerSessionId,
        state: "idle",
        ...(turnWasRunning ? { stoppedMidTurn: true as const } : {}),
      });
      this.options.onObservationInvalidation?.({
        observation: this.observations.nextStamp(),
        environmentId: session.environmentId,
        sessionKey: session.key,
        providerSessionId: session.providerSessionId,
        state: "idle",
        owner: "environment",
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
      });
    }
    await Promise.all(interruptions);
  }

  /**
   * The sweep's catch-all for runtimes that stopped without the stop command:
   * a container that exited on its own and was found by lifecycle
   * reconciliation, or one stopped by a rebuild or a recovery-copy restore.
   * Container environments only: Docker reports `stopped` only for a
   * container that is not running, whereas a local stop that could not end a
   * bridge still records `stopped` and deliberately keeps that bridge's
   * requests (`stopEnvironmentOnce`). Once per stop; a start re-arms it.
   */
  private async settleStoppedRuntimes(
    environments: readonly Environment[],
    sessions: readonly PersistedNativeAgentSession[],
    tickets: ReadonlyMap<string, NativeAgentObservationTicket[]>,
  ): Promise<Set<string>> {
    const stale = new Set<string>();
    const stopped = new Set(
      environments
        .filter(
          (environment) =>
            environment.environmentType !== "local" && environment.status === "stopped",
        )
        .map((environment) => environment.id),
    );
    for (const environmentId of Array.from(this.settledStoppedEnvironments)) {
      if (!stopped.has(environmentId)) this.settledStoppedEnvironments.delete(environmentId);
    }
    for (const environmentId of stopped) {
      if (this.settledStoppedEnvironments.has(environmentId)) continue;
      const snapshot = environments.find((environment) => environment.id === environmentId)!;
      const current = await this.storage.getEnvironment(environmentId);
      // Re-read after all sweep waits. A start/rebuild or dispatch makes the
      // original stopped snapshot inapplicable to the new runtime's turn.
      if (
        !current ||
        current.status !== "stopped" ||
        current.containerId !== snapshot.containerId ||
        current.containerLifecycle?.lastRuntimeGeneration !==
          snapshot.containerLifecycle?.lastRuntimeGeneration ||
        !(tickets.get(environmentId) ?? []).every((ticket) =>
          [...ticket.sequences.keys()].every((key) => this.observations.accepts(ticket, key)),
        )
      ) {
        stale.add(environmentId);
        continue;
      }
      this.host.withdrawEnvironmentInteractions(environmentId);
      await this.settleStoppedSessions(environmentId, sessions);
      this.settledStoppedEnvironments.add(environmentId);
    }
    return stale;
  }

  /**
   * Whether one environment's bridge has an in-flight dispatch or a session
   * last observed working, waiting, or running background tasks.
   *
   * Uses the raw state, not the turn view: replacing the bridge kills its whole
   * process tree, so a backgrounded test run or dev server is lost just like a
   * turn. Purely in-memory apart from the session list; never reads a bridge.
   */
  async hasObservedLiveWork(environmentId: string, agent: BuildPipelineAgent): Promise<boolean> {
    const provider = this.providerRegistry.cached(providerCacheKey(environmentId, agent));
    if (provider && this.providerRegistry.hasDispatchInFlight(provider)) return true;
    const sessions = await this.storage.listNativeAgentSessions();
    return sessions.some((session) => {
      if (session.environmentId !== environmentId || session.agent !== agent) return false;
      const observed = this.observedSessionActivity.get(session.key);
      if (!observed || observed.providerSessionId !== session.providerSessionId) return false;
      return observed.state === "working" || observed.state === "waiting";
    });
  }

  /**
   * Rebuild the durable environment activity projection from provider-owned
   * session state. This does not depend on a mounted tab or a renderer event.
   */
  /**
   * Run (or join) one activity sweep.
   *
   * `startedAfter` is for a consumer that needs an answer read *after* its
   * request — a demand for a post-dispatch or fresher observation. It passes
   * the sweep number it saw ({@link activityScanNumber}) when the demand was
   * made and joins a sweep in flight only if that sweep started later; a
   * sweep that started earlier may already have read the group, so every such
   * caller shares one follow-up sweep instead.
   */
  reconcileAgentActivity(options: { startedAfter?: number } = {}): Promise<void> {
    if (this.host.isStopped()) return Promise.resolve();
    recurringWorkMetrics.requested("native-activity-sweep");
    if (this.activityScan) {
      recurringWorkMetrics.coalesced("native-activity-sweep");
      if (options.startedAfter === undefined || this.activityScanNumber > options.startedAfter) {
        return this.activityScan;
      }
      this.activityScanFollowUp ??= this.activityScan
        .catch(() => undefined)
        .then(() => {
          this.activityScanFollowUp = null;
          return this.reconcileAgentActivity();
        });
      return this.activityScanFollowUp;
    }
    this.activityScanNumber += 1;
    const scan = this.host
      .trackScan(
        recurringWorkMetrics.observe("native-activity-sweep", () =>
          this.reconcileAgentActivityOnce(),
        ),
      )
      .finally(() => {
        if (this.activityScan === scan) this.activityScan = null;
      });
    this.activityScan = scan;
    return scan;
  }

  /** Fresh no-touch admission read, including background work and persisted sessions after reload. */
  async hasActiveCheckoutWork(environmentId: string): Promise<boolean> {
    const sessions = (await this.storage.listNativeAgentSessions()).filter(
      (session) => session.environmentId === environmentId,
    );
    for (const session of sessions) {
      if (session.pendingDispatch) return true;
      const provider = await this.host.observeProvider(session);
      if (!provider) continue;
      if (this.providerRegistry.hasDispatchInFlight(provider)) return true;
      let active = false;
      await readActivityGroup({
        provider,
        sessions: [session],
        apply: async (_session, activity) => {
          if (activity.state !== "idle" && activity.state !== "missing") active = true;
        },
      });
      if (active) return true;
    }
    return false;
  }

  private async reconcileAgentActivityOnce(): Promise<void> {
    // Include storage/coordinator waits in the stop fence, not just provider I/O.
    const stopEpochs = new Map(this.stopEpochs);
    const [environments, sessions] = await Promise.all([
      this.storage.loadEnvironments(),
      this.storage.listNativeAgentSessions(),
    ]);
    if (this.host.isStopped()) return;

    const stoppedTickets = new Map<string, NativeAgentObservationTicket[]>();
    const stoppedIds = new Set(
      environments
        .filter(
          (environment) =>
            environment.environmentType !== "local" && environment.status === "stopped",
        )
        .map((environment) => environment.id),
    );
    for (const session of sessions) {
      if (!stoppedIds.has(session.environmentId)) continue;
      const tickets = stoppedTickets.get(session.environmentId) ?? [];
      tickets.push(
        this.observations.beginRead(
          nativeAgentObservationGroupKey(session.environmentId, session.agent),
          [session.key],
        ),
      );
      stoppedTickets.set(session.environmentId, tickets);
    }
    const environmentsById = new Map(
      environments.map((environment) => [environment.id, environment]),
    );
    /*
     * Coordinator runtimes have no environment row, so they used to fall out of
     * this scan entirely: the group builder below skips any session whose id is
     * not an environment, and the cleanup pass at the end then deleted the
     * `working` observation dispatch had just written. A coordinator's activity
     * was therefore permanently `unknown` — it never read `idle`, so nothing
     * could react to its turn ending and mail delivery fell through to the
     * cold-tab path with a provider probe and a backoff per attempt.
     *
     * Resolving them here puts a coordinator on exactly the same footing as an
     * environment session for observation purposes. The environment-only side
     * effects — the activity aggregate, session-completion bookkeeping, the PR
     * probe — stay gated on the `owner` this records.
     *
     * Deliberately one pass over the coordinator store rather than one resolve
     * per runtime id: this runs every two seconds, and that store is read
     * uncached, so a per-id resolve would re-read and re-parse it once per
     * conversation per tick. Nothing is read at all when no coordinator session
     * exists, which is the common case.
     */
    const coordinatorEnvironmentIds = new Set<string>();
    const coordinatorRuntimeIds = new Set(
      sessions
        .map((session) => session.environmentId)
        .filter((id) => !environmentsById.has(id) && coordinatorIdFromRuntimeId(id)),
    );
    if (coordinatorRuntimeIds.size > 0) {
      const projects = new Map<string, Awaited<ReturnType<StorageService["getProject"]>>>();
      for (const workspace of await this.storage.coordinators.listCoordinatorWorkspaces()) {
        if (workspace.lifecycleState !== "ready") continue;
        if (!projects.has(workspace.projectId)) {
          projects.set(workspace.projectId, await this.storage.getProject(workspace.projectId));
        }
        const project = projects.get(workspace.projectId);
        if (!project?.localPath) continue;
        for (const conversation of workspace.conversations) {
          if (conversation.closedAt || !conversation.agent) continue;
          const runtimeId = coordinatorRuntimeId(workspace.id, conversation.id);
          if (!coordinatorRuntimeIds.has(runtimeId)) continue;
          environmentsById.set(
            runtimeId,
            coordinatorRuntimeEnvironment(runtimeId, { workspace, project }),
          );
          coordinatorEnvironmentIds.add(runtimeId);
        }
      }
    }
    // Bug reports have no environment row either, and are observed the same
    // way. They join the coordinator set because that set means "not an
    // environment": no activity aggregate, completion bookkeeping or PR probe.
    const bugReportRuntimeIds = new Set(
      sessions
        .map((session) => session.environmentId)
        .filter((id) => !environmentsById.has(id) && bugReportIdFromRuntimeId(id)),
    );
    for (const runtimeId of bugReportRuntimeIds) {
      const record = await this.storage.bugReports.getBugReport(
        bugReportIdFromRuntimeId(runtimeId)!,
      );
      if (!record?.agent) continue;
      environmentsById.set(runtimeId, bugReportRuntimeEnvironment(runtimeId, record));
      coordinatorEnvironmentIds.add(runtimeId);
    }
    if (this.host.isStopped()) return;
    const staleStoppedEnvironments = await this.settleStoppedRuntimes(
      environments,
      sessions,
      stoppedTickets,
    );
    // Preserve the aggregate's restart fallback until every session has a
    // known prior observation. Afterwards exact session edges own attention,
    // including completions announced before a detached shell finally exits.
    const environmentsWithUnknownSessions = new Set<string>();
    const sessionsByEnvironment = new Map<string, PersistedNativeAgentSession[]>();
    for (const session of sessions) {
      if (!environmentsById.has(session.environmentId)) continue;
      if (
        this.observedSessionActivity.get(session.key)?.providerSessionId !==
          session.providerSessionId &&
        !activityTurnSettled(session)
      ) {
        environmentsWithUnknownSessions.add(session.environmentId);
      }
      const grouped = sessionsByEnvironment.get(session.environmentId) ?? [];
      grouped.push(session);
      sessionsByEnvironment.set(session.environmentId, grouped);
    }
    for (const environmentId of this.sweptEnvironments) {
      if (!environmentsById.has(environmentId)) {
        this.sweptEnvironments.delete(environmentId);
        this.unwatchedWorkingEnvironments.delete(environmentId);
        this.pendingAttentionEnvironments.delete(environmentId);
      }
    }
    for (const environment of environments) {
      if (!this.sweptEnvironments.has(environment.id)) {
        this.sweptEnvironments.add(environment.id);
        if (environment.agentActivitySources?.["native-agent"]?.state === "working") {
          this.unwatchedWorkingEnvironments.add(environment.id);
          if (environment.hasUnreadWork && environment.unreadReason === "agent_failed") {
            this.pendingAttentionEnvironments.add(environment.id);
          }
        }
      }
    }

    const activityByEnvironment = new Map<
      string,
      Record<string, { state: AgentActivityState; updatedAt: string }>
    >();
    const completionCandidates = new Set<string>();
    const attentionRecordedEnvironments = this.pendingAttentionEnvironments;
    // A stale stopped snapshot must not publish an idle environment aggregate either.
    const failedEnvironments = new Set(staleStoppedEnvironments);
    const groups = new Map<string, PersistedNativeAgentSession[]>();
    for (const [environmentId, environmentSessions] of sessionsByEnvironment) {
      const environment = environmentsById.get(environmentId)!;
      if (!isEnvironmentReadyForAgents(environment)) continue;
      // A pending deletion makes every provider call throw on the liveness
      // assertion, which would otherwise warn and back off on a loop until the
      // delete finishes. Its activity is settled by the delete itself.
      if (environment.deletionRequestedAt) continue;
      for (const session of environmentSessions) {
        const key = `${environmentId}\0${session.agent}`;
        const grouped = groups.get(key) ?? [];
        grouped.push(session);
        groups.set(key, grouped);
      }
    }

    const pendingGroups = [...groups.entries()];
    let nextGroup = 0;
    const worker = async (): Promise<void> => {
      while (!this.host.isStopped()) {
        const entry = pendingGroups[nextGroup++];
        if (!entry) return;
        const [groupKey, group] = entry;
        const first = group[0]!;
        const environment = environmentsById.get(first.environmentId)!;
        const sessionOwner = coordinatorEnvironmentIds.has(first.environmentId)
          ? ("coordinator" as const)
          : ("environment" as const);
        const unwatchedWorking = this.unwatchedWorkingEnvironments.has(first.environmentId);
        // A group whose last read failed stays untouched until its backoff
        // expires. Its environment is still withheld from the commit below:
        // publishing an aggregate built from a group we deliberately skipped
        // would report the unread agent as idle.
        if ((this.activityRetryAt.get(groupKey) ?? 0) > this.host.now()) {
          failedEnvironments.add(first.environmentId);
          continue;
        }
        // A stably idle group whose provider holds a qualified wakeup path is
        // not due yet. Its retained, confirmed observations still feed the
        // aggregate; nothing is re-announced because nothing was re-read.
        if (
          !this.observations.isGroupDue(groupKey) &&
          this.contributeRetainedGroup(activityByEnvironment, group, sessionOwner)
        ) {
          recurringWorkMetrics.cacheHit("native-activity-sweep");
          continue;
        }
        recurringWorkMetrics.cacheMiss("native-activity-sweep");
        /*
         * Captured before anything is read, including the bridge peek: a
         * dispatch that begins after this point makes every answer below
         * pre-dispatch evidence for that session, and it is refused rather
         * than allowed to overwrite the `working` the dispatch recorded.
         */
        const stopEpoch = stopEpochs.get(first.environmentId) ?? 0;
        const runtimeStillCurrent = () =>
          (this.stopEpochs.get(first.environmentId) ?? 0) === stopEpoch;
        let ticket = this.observations.beginRead(
          groupKey,
          group.map((session) => session.key),
        );
        let settledIdle = true;
        let outcomeReadFailed = false;
        const applyObservation = async (
          session: PersistedNativeAgentSession,
          activity: AgentActivityState,
          details: {
            readyForInput?: boolean;
            completionPending?: boolean;
            pendingInteraction?: boolean;
            contentRevision?: string;
            readTurnFailed?: () => Promise<boolean>;
          } = {},
        ): Promise<void> => {
          if (!runtimeStillCurrent() || !this.observations.accepts(ticket, session.key)) {
            settledIdle = false;
            if (!this.contributeRetained(activityByEnvironment, session, sessionOwner)) {
              failedEnvironments.add(session.environmentId);
            }
            return;
          }
          const recorded = await this.recordActivity(
            activityByEnvironment,
            session,
            activity,
            Boolean(environment.prRecheckAfterAgentCompletionArmedAt),
            sessionOwner,
            details.readyForInput,
            () => runtimeStillCurrent() && this.observations.accepts(ticket, session.key),
            details.completionPending,
            details.contentRevision,
            details.readTurnFailed,
            unwatchedWorking,
          );
          if (recorded.completed) completionCandidates.add(session.environmentId);
          if (recorded.attentionRecorded) attentionRecordedEnvironments.add(session.environmentId);
          if (!runtimeStillCurrent() || !this.observations.accepts(ticket, session.key)) {
            settledIdle = false;
            if (!this.contributeRetained(activityByEnvironment, session, sessionOwner)) {
              failedEnvironments.add(session.environmentId);
            }
            return;
          }
          // Published after the edge is durable, so a storage failure above
          // leaves no fresh record contradicting the retained edge state.
          this.observations.record(ticket, {
            sessionKey: session.key,
            providerSessionId: session.providerSessionId,
            activity,
            ...(details.readyForInput !== undefined
              ? { readyForInput: details.readyForInput }
              : {}),
            ...(details.pendingInteraction !== undefined
              ? { pendingInteraction: details.pendingInteraction }
              : {}),
          });
          if (activity !== "idle") settledIdle = false;
        };
        // A bridge known to be absent stays absent until something starts it,
        // and starting one always runs through `provider()`, which clears this.
        // Re-probing on every tick would mean a `docker exec` per container
        // every two seconds to re-learn an answer that cannot have changed.
        const applyBridgeGone = async (): Promise<void> => {
          for (const session of group) {
            await applyObservation(session, "idle", {
              readTurnFailed: this.bridgeLostTurn(session, unwatchedWorking),
            });
          }
        };
        if (this.providerRegistry.isBridgeKnownAbsent(groupKey)) {
          await applyBridgeGone();
          continue;
        }
        let provider: NativeAgentRuntimeProvider | undefined;
        try {
          provider = await this.host.observeProvider(first);
          if (!runtimeStillCurrent()) {
            failedEnvironments.add(first.environmentId);
            continue;
          }
          if (!provider) {
            // No bridge is running for this environment, so no turn can be
            // executing. That is an answer, not a failure — recording it is
            // what retires a `working` indicator left behind by a crash.
            await applyBridgeGone();
            this.activityAttempts.delete(groupKey);
            this.activityRetryAt.delete(groupKey);
            this.providerRegistry.markBridgeAbsent(groupKey);
            this.observations.noteGroupObserved(groupKey, {
              settledIdle,
              wakeupQualified: false,
            });
            continue;
          }
          // Retire a stop tied to an older provider before a failed read can
          // evict this replacement and erase its cached connection identity.
          this.runtimeStopPending(first);
          // Results are fenced against the provider actually read from: a
          // replacement installed from here on makes them inert.
          ticket = this.observations.withCurrentGeneration(ticket);
          this.providerRegistry.clearBridgeAbsent(groupKey);
          for (const session of group) {
            provider.registerSession?.(session.providerSessionId, {
              origin: session.origin,
              interactionPolicy: session.interactionPolicy,
            });
          }
          // Batched where the provider can, bounded-concurrent per session
          // otherwise; see `readActivityGroup` for the fallback and failure
          // rules. Answers are applied one at a time, in completion order.
          const groupProvider = provider;
          await readActivityGroup({
            provider,
            sessions: group,
            apply: async (session, { state: activity, observation }) => {
              if (!runtimeStillCurrent() || !this.observations.accepts(ticket, session.key)) return;
              if (activity === "missing") {
                // Provider adapters may return `missing` only from an
                // authoritative existence read. Incremental activity/status
                // snapshots must surface uncertainty as provider unavailability.
                // Gone across a restart while working, its turn cannot have
                // finished; left alone, the aggregate would announce that it did.
                if (
                  sessionOwner === "environment" &&
                  unwatchedWorking &&
                  !this.observedSessionActivity.has(session.key) &&
                  hasUnsettledTurn(session) &&
                  !this.runtimeStopPending(session)
                ) {
                  await this.storage.recordEnvironmentSessionCompletion(
                    session.environmentId,
                    new Date(this.host.now()).toISOString(),
                    "agent_failed",
                    completionKey(session),
                  );
                  attentionRecordedEnvironments.add(session.environmentId);
                }
                await this.storage.invalidateNativeAgentSession(
                  session.key,
                  session.providerSessionId,
                );
                this.observations.forget(session.key);
                settledIdle = false;
                return;
              }
              if (session.agent === "codex" && observation?.asyncQuestionItemIds?.length) {
                try {
                  await this.host.recordAsyncQuestionAttention(
                    session.environmentId,
                    session.key,
                    observation.asyncQuestionItemIds,
                  );
                } catch (error) {
                  // A badge persistence failure is not evidence that the bridge
                  // or any session in this activity group is unhealthy.
                  console.warn(
                    `[native-agent] Could not record async-question attention for ${session.environmentId}:`,
                    error instanceof Error ? error.name : "unknown error",
                  );
                }
              }
              // A rule that answered every parked request leaves the turn
              // running: no waiting edge, no attention badge for a card
              // nobody needs to see. Anything left still waits on the user.
              let observedActivity = activity;
              const ruleProvider = provider;
              if (activity === "waiting" && ruleProvider && this.host.applyPermissionRules) {
                const ruled = await this.host
                  .applyPermissionRules(session, ruleProvider)
                  .catch(() => null);
                if (ruled && ruled.answered > 0 && ruled.remaining === 0) {
                  observedActivity = "working";
                }
              }
              await applyObservation(session, observedActivity, {
                ...(observation?.readyForInput !== undefined
                  ? { readyForInput: observation.readyForInput }
                  : {}),
                ...(observation?.completionPending !== undefined
                  ? { completionPending: observation.completionPending }
                  : {}),
                ...(observation?.contentRevision !== undefined
                  ? { contentRevision: observation.contentRevision }
                  : {}),
                pendingInteraction:
                  observedActivity === "waiting" ||
                  (observation?.asyncQuestionItemIds?.length ?? 0) > 0,
                readTurnFailed: async () => {
                  const outcome = session.turnOutcomes?.find(
                    (entry) => entry.requestId === latestRequestId(session),
                  );
                  if (outcome) return outcome.outcome === "failed";
                  if (observation?.turnFailed === true) return true;
                  try {
                    return (
                      (await readTurnTerminalFailure(groupProvider, session)) ||
                      (await readTurnLost(groupProvider, session))
                    );
                  } catch (error) {
                    outcomeReadFailed = true;
                    throw error;
                  }
                },
              });
            },
          });
          this.activityAttempts.delete(groupKey);
          this.activityRetryAt.delete(groupKey);
          // Change evidence rides the same per-bridge observation; the pull is
          // single-flight and its failures never affect the activity group.
          try {
            this.options.changeTracking?.()?.noteProviderObserved(provider, first.environmentId);
          } catch {
            // Change tracking is best effort here; its own pull logs failures.
          }
          this.observations.noteGroupObserved(groupKey, {
            settledIdle:
              settledIdle && !group.some((session) => this.turnRecovery.hasCandidate(session.key)),
            wakeupQualified: this.observationWakeupQualified(first.agent, provider),
          });
        } catch (error) {
          failedEnvironments.add(first.environmentId);
          this.observations.noteGroupFailed(groupKey);
          this.backOffActivityGroup(groupKey, error);
          // An unsettled outcome is not a failed activity connection. Keep the
          // provider that owns its pending dispatch evidence for the retry.
          if (provider && !outcomeReadFailed) {
            this.providerRegistry.evict(first, provider);
          }
          console.warn(
            `[native-agent] Activity reconciliation for ${first.environmentId} failed:`,
            error instanceof Error ? error.name : "unknown error",
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ACTIVITY_STATUS_CONCURRENCY, pendingGroups.length) }, () =>
        worker(),
      ),
    );
    if (this.host.isStopped()) return;

    // Every session has answered, so a tab opened from here on is not a turn
    // that ended across the restart, whatever its first answer says.
    for (const environmentId of this.unwatchedWorkingEnvironments) {
      const observedAll = (sessionsByEnvironment.get(environmentId) ?? []).every(
        (session) =>
          this.observedSessionActivity.get(session.key)?.providerSessionId ===
          session.providerSessionId,
      );
      if (observedAll) this.unwatchedWorkingEnvironments.delete(environmentId);
    }

    // An exact per-session completion must not wait for the environment-wide
    // aggregate to become idle: another tab using the same provider may still
    // be working. The command is backend-internal and only acts when durable
    // conflict-resolution intent is armed.
    for (const environmentId of completionCandidates) {
      this.pendingPrRefreshEnvironmentIds.add(environmentId);
    }
    const armedEnvironmentIds = new Set(
      environments
        .filter((environment) => Boolean(environment.prRecheckAfterAgentCompletionArmedAt))
        .map((environment) => environment.id),
    );
    for (const environmentId of this.pendingPrRefreshEnvironmentIds) {
      if (!armedEnvironmentIds.has(environmentId)) {
        this.pendingPrRefreshEnvironmentIds.delete(environmentId);
      }
    }
    await this.flushPendingPrRefreshNotifications();

    const liveSessionsByKey = new Map(
      sessions
        .filter((session) => environmentsById.has(session.environmentId))
        .map((session) => [session.key, session.providerSessionId]),
    );
    for (const [key, observed] of this.observedSessionActivity) {
      if (liveSessionsByKey.get(key) !== observed.providerSessionId) {
        this.observedSessionActivity.delete(key);
      }
    }
    this.observations.retainSessions(liveSessionsByKey);
    this.observations.retainGroups(new Set(groups.keys()));

    for (const environment of environments) {
      if (failedEnvironments.has(environment.id)) continue;
      const hasRegisteredSessions = sessionsByEnvironment.has(environment.id);
      const previous = environment.agentActivitySources?.["native-agent"];
      if (!hasRegisteredSessions && !previous) continue;
      const desiredState = isEnvironmentReadyForAgents(environment)
        ? aggregateAgentActivityState(activityByEnvironment.get(environment.id) ?? {})
        : "idle";
      if (previous?.state === desiredState) continue;
      await this.storage
        .setEnvironmentAgentActivity(
          environment.id,
          desiredState,
          new Date().toISOString(),
          "native-agent",
          undefined,
          false,
          {
            completionAttention:
              !attentionRecordedEnvironments.has(environment.id) &&
              (!hasRegisteredSessions || environmentsWithUnknownSessions.has(environment.id)),
          },
        )
        .then(() => {
          if (desiredState !== "working") {
            this.unwatchedWorkingEnvironments.delete(environment.id);
            this.pendingAttentionEnvironments.delete(environment.id);
          }
        })
        .catch((error) => {
          console.warn(
            `[native-agent] Failed to persist activity for ${environment.id}:`,
            error instanceof Error ? error.name : "unknown error",
          );
        });
    }
  }

  /**
   * Stage a session's retained observation into the aggregate, with no edge.
   *
   * Used where this pass holds no applicable answer for the session: its
   * group is not due, or its read was fenced by a dispatch. Returns false when
   * nothing is retained for the current provider session, in which case the
   * caller must withhold the environment's commit rather than publish an
   * aggregate that silently omits the session.
   */
  private contributeRetained(
    activityByEnvironment: Map<
      string,
      Record<string, { state: AgentActivityState; updatedAt: string }>
    >,
    session: PersistedNativeAgentSession,
    owner: "environment" | "coordinator",
  ): boolean {
    const observed = this.observedSessionActivity.get(session.key);
    if (!observed || observed.providerSessionId !== session.providerSessionId) return false;
    if (owner === "environment") {
      const sources = activityByEnvironment.get(session.environmentId) ?? {};
      sources[session.key] = { state: observed.state, updatedAt: "1970-01-01T00:00:00.000Z" };
      activityByEnvironment.set(session.environmentId, sources);
    }
    return true;
  }

  /** A not-due group is skipped only when every session has a retained idle. */
  private contributeRetainedGroup(
    activityByEnvironment: Map<
      string,
      Record<string, { state: AgentActivityState; updatedAt: string }>
    >,
    group: readonly PersistedNativeAgentSession[],
    owner: "environment" | "coordinator",
  ): boolean {
    const retained = group.every((session) => {
      const observed = this.observedSessionActivity.get(session.key);
      return (
        observed?.providerSessionId === session.providerSessionId &&
        observed.state === "idle" &&
        !this.turnRecovery.hasCandidate(session.key)
      );
    });
    if (!retained) return false;
    for (const session of group) this.contributeRetained(activityByEnvironment, session, owner);
    return true;
  }

  /**
   * Whether a stably idle group of this provider may back off right now: the
   * capability matrix names a push path for externally started work *and* the
   * provider reports that path live (an OpenCode event stream that is
   * connected, not reconnecting). Everything else keeps every sweep.
   */
  private observationWakeupQualified(
    agent: BuildPipelineAgent,
    provider: NativeAgentRuntimeProvider,
  ): boolean {
    return (
      this.options.observationSharing !== false &&
      nativeAgentObservationCapabilities(agent)?.idleBackoffWakeup === "provider-event-stream" &&
      provider.observationStreamLive?.() === true
    );
  }

  /**
   * The shared observation for one session, reading only when the retained
   * one does not satisfy the demand.
   *
   * This is the entry point for consumers that need to know whether a
   * session is busy — workflows and queues (step 08), mail, the coordinator —
   * instead of issuing their own provider read. It never starts a bridge,
   * attaches, hydrates or touches liveness: a miss wakes the session's group
   * and runs (or queues one follow-up) activity sweep, which uses the no-touch
   * observer path. `requirePostDispatch` refuses any answer read before the
   * latest dispatch to the session, so a cached pre-dispatch idle can never
   * advance a pipeline. A failed read answers `recovering`, never idle.
   */
  async observeSessionActivity(
    input: { environmentId: string; agent: BuildPipelineAgent; logicalSessionKey: string },
    demand: NativeAgentObservationDemand = {},
  ): Promise<NativeAgentObservationView> {
    if (this.host.isStopped()) return { freshness: "unknown", postDispatch: false };
    // Captured before any await: only a sweep that starts after this demand
    // can answer it if the retained observation does not.
    const demandedAfter = this.activityScanNumber;
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(key);
    if (!session) return { freshness: "unknown", postDispatch: false };
    const retained = this.observations.view(key, session.providerSessionId);
    if (observationSatisfies(retained, demand)) {
      recurringWorkMetrics.cacheHit("native-activity-sweep");
      return retained;
    }
    this.observations.wakeGroup(
      nativeAgentObservationGroupKey(input.environmentId, input.agent),
      "demand",
    );
    await this.reconcileAgentActivity({ startedAfter: demandedAfter });
    return this.observations.view(key, session.providerSessionId);
  }

  /** Wake one environment's provider group(s) for the next sweep. */
  wakeObservation(
    environmentId: string,
    reason: NativeAgentObservationWakeReason,
    agent?: BuildPipelineAgent,
  ): void {
    this.observations.wakeEnvironment(environmentId, reason, agent);
  }

  /** Content-free observer state for diagnostics and the client's gap anchor. */
  observationStatus(): NativeAgentObservationStatus & { stamp: ViewRevisionStamp } {
    return { ...this.observations.status(), stamp: this.observations.stamp() };
  }

  /** Stage one session's observed state into the per-environment aggregate. */
  private async recordActivity(
    activityByEnvironment: Map<
      string,
      Record<string, { state: AgentActivityState; updatedAt: string }>
    >,
    session: PersistedNativeAgentSession,
    state: AgentActivityState,
    countUnknownIdleAsCompletion: boolean,
    /**
     * A coordinator runtime is observed like any session but owns none of the
     * environment bookkeeping: there is no row to record a completion against
     * and no aggregate to publish. Its transition is still reported, which is
     * what wakes held worker mail.
     */
    owner: "environment" | "coordinator" = "environment",
    readyForInput?: boolean,
    stillApplicable?: () => boolean,
    completionPending?: boolean,
    contentRevision?: string,
    /**
     * Whether the turn this edge ends failed, asked only on a completion edge:
     * the activity observation's `turnFailed`, or for a provider that keeps a
     * failure off its lifecycle, a read of the turn's outcome. Also asked for
     * a session first answering idle where `unwatchedWorking` holds; there a
     * "no" stays quiet and the aggregate's restart fallback announces the end.
     */
    readTurnFailed?: () => Promise<boolean>,
    unwatchedWorking = false,
  ): Promise<{ completed: boolean; attentionRecorded: boolean }> {
    const observed = this.observedSessionActivity.get(session.key);
    const currentObservation =
      observed?.providerSessionId === session.providerSessionId ? observed : undefined;
    const previous = currentObservation?.state;
    // Readiness alone is ambiguous on older bridges. An explicit settled root
    // turn can ring while detached shells keep the environment working; an
    // owed continuation keeps its completion edge until the final result.
    const releasedCompletion =
      state === "working" && readyForInput === true && completionPending === false;
    const previousReleasedCompletion =
      previous === "working" &&
      currentObservation?.readyForInput === true &&
      currentObservation.completionPending === false;
    const durableAttentionEdge =
      (state === "waiting" &&
        previous !== "waiting" &&
        (currentObservation !== undefined || observed === undefined)) ||
      (completionPending !== true &&
        (state === "idle" || releasedCompletion) &&
        !previousReleasedCompletion &&
        (previous === "working" ||
          (state === "idle" &&
            observed === undefined &&
            countUnknownIdleAsCompletion &&
            !activityTurnSettled(session))));
    // PR reconciliation retains its narrower historical completion contract:
    // a parked waiting turn needs the user's attention, but it has not ended.
    //
    // Both flags key their "never seen before" case on `observed`, not on
    // `currentObservation`. Rotating a session's provider id is not a first
    // observation: this backend watched the previous turn under the old id, so
    // the idle that follows a rotation is already accounted for and must not be
    // replayed as a completion. `previous` still narrows to the current
    // provider session, which is what keeps a rotation from inheriting an edge.
    const completed =
      state === "idle" &&
      (previous === "working" ||
        (observed === undefined && countUnknownIdleAsCompletion && !activityTurnSettled(session)));
    // Persist the exact session edge before advancing the in-memory observation.
    // If storage fails, the provider group backs off and the next scan still
    // sees `previous === "working"`, so the durable completion is retried.
    const unwatchedTurnEnd =
      !durableAttentionEdge &&
      unwatchedWorking &&
      !activityTurnSettled(session) &&
      state === "idle" &&
      observed === undefined &&
      completionPending !== true;
    let attentionRecorded = false;
    if ((durableAttentionEdge || unwatchedTurnEnd) && owner === "environment") {
      const reason =
        state === "waiting"
          ? "agent_waiting"
          : (await readTurnFailed?.())
            ? "agent_failed"
            : "agent_finished";
      if (stillApplicable && !stillApplicable())
        return { completed: false, attentionRecorded: false };
      if (durableAttentionEdge || reason === "agent_failed") {
        await this.storage.recordEnvironmentSessionCompletion(
          session.environmentId,
          new Date(this.host.now()).toISOString(),
          reason,
          state === "waiting" ? undefined : completionKey(session),
        );
        attentionRecorded = true;
      }
    }
    if (stillApplicable && !stillApplicable())
      return { completed: false, attentionRecorded: false };
    const turnState =
      (state === "idle" && completionPending !== true) || releasedCompletion ? "settled" : "active";
    if (
      session.activityTurn?.providerSessionId !== session.providerSessionId ||
      session.activityTurn.requestId !== latestRequestId(session) ||
      session.activityTurn.state !== turnState
    ) {
      await this.storage.recordNativeAgentActivityTurn(session, turnState);
    }
    if (stillApplicable && !stillApplicable()) return { completed: false, attentionRecorded };
    if (state === "idle" || releasedCompletion) {
      this.runtimeStopRequests
        .get(`${session.environmentId}\0${session.agent}`)
        ?.requests.delete(session.key);
    }
    this.observedSessionActivity.set(session.key, {
      providerSessionId: session.providerSessionId,
      state,
      ...(readyForInput !== undefined ? { readyForInput } : {}),
      ...(completionPending !== undefined ? { completionPending } : {}),
      ...(contentRevision !== undefined ? { contentRevision } : {}),
      ...(state !== "idle" && readyForInput !== true && currentObservation?.activeRequestId
        ? { activeRequestId: currentObservation.activeRequestId }
        : {}),
    });
    const resumedForegroundTurn =
      state === "working" && currentObservation?.readyForInput === true && readyForInput !== true;
    const changedQuietContent =
      contentRevision !== undefined &&
      currentObservation?.contentRevision !== undefined &&
      currentObservation.contentRevision !== contentRevision &&
      (state === "idle" || readyForInput === true);
    if (previous === state && (resumedForegroundTurn || changedQuietContent)) {
      /*
       * The view of a session whose turn is over changed without a
       * transition: a Claude background task reported, a Codex async question
       * or late command change landed. Announce it in the same stamp
       * sequence, so an idle view that reads less often is told to read and
       * a missed announcement still shows as a gap. Resuming a released
       * composer also wakes the view, even if background work kept aggregate
       * activity working. Subsequent running content changes stay silent:
       * the view has returned to its responsive cadence.
       */
      this.options.onObservationInvalidation?.({
        observation: this.observations.nextStamp(),
        environmentId: session.environmentId,
        sessionKey: session.key,
        providerSessionId: session.providerSessionId,
        state,
        owner,
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
      });
    }
    if (previous !== state) {
      const observation = this.observations.nextStamp();
      this.options.onActivityTransition?.({
        observation,
        environmentId: session.environmentId,
        sessionKey: session.key,
        providerSessionId: session.providerSessionId,
        previousState: previous,
        state,
        owner,
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
      });
    }
    // Incomplete-turn recovery keys its candidates on these applied edges.
    this.turnRecovery.noteActivity(session, state, previous);
    if (owner === "environment") {
      const sources = activityByEnvironment.get(session.environmentId) ?? {};
      sources[session.key] = {
        state,
        // Only the state matters for this in-memory aggregate. A real timestamp
        // is supplied once per committed environment.
        updatedAt: "1970-01-01T00:00:00.000Z",
      };
      activityByEnvironment.set(session.environmentId, sources);
    }
    return { completed: completed && owner === "environment", attentionRecorded };
  }

  /** Deliver pending completion notifications with the same bound as status IO. */
  private async flushPendingPrRefreshNotifications(): Promise<void> {
    const environmentIds = [...this.pendingPrRefreshEnvironmentIds];
    let nextEnvironment = 0;
    const worker = async (): Promise<void> => {
      while (!this.host.isStopped()) {
        const environmentId = environmentIds[nextEnvironment++];
        if (!environmentId) return;
        try {
          await this.invoke("pr_monitor_agent_turn_completed", { environmentId });
          this.pendingPrRefreshEnvironmentIds.delete(environmentId);
        } catch (error) {
          console.warn(
            `[native-agent] Failed to schedule PR refresh after completion for ${environmentId}:`,
            error instanceof Error ? error.name : "unknown error",
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(ACTIVITY_STATUS_CONCURRENCY, environmentIds.length),
        },
        () => worker(),
      ),
    );
  }

  /**
   * Push a failing group's next read out geometrically.
   *
   * Without this an environment whose bridge cannot be reached is retried
   * thirty times a minute forever, each attempt re-resolving a connection and
   * emitting a warning. Mirrors the prompt queue's backoff so the two paths
   * degrade the same way.
   */
  private backOffActivityGroup(groupKey: string, error: unknown): void {
    const attempts = (this.activityAttempts.get(groupKey) ?? 0) + 1;
    this.activityAttempts.set(groupKey, attempts);
    const backoff = Math.min(
      ACTIVITY_RETRY_CEILING_MS,
      ACTIVITY_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8),
    );
    const retryAfterMs = error instanceof ProviderUnavailableError ? (error.retryAfterMs ?? 0) : 0;
    this.activityRetryAt.set(groupKey, this.host.now() + Math.max(backoff, retryAfterMs));
  }

  async reconcileInitialLaunch(environmentId: string): Promise<void> {
    if (this.host.isStopped()) return;
    const existing = this.launchTasks.get(environmentId);
    if (existing) return existing;
    const task = this.reconcileInitialLaunchOnce(environmentId).finally(() => {
      if (this.launchTasks.get(environmentId) === task) {
        this.launchTasks.delete(environmentId);
      }
    });
    this.launchTasks.set(environmentId, task);
    return task;
  }

  private async reconcilePendingLaunches(): Promise<number> {
    if (this.host.isStopped()) return 0;
    const now = Date.now();
    const environments = await this.storage.loadEnvironments();
    if (this.host.isStopped()) return 0;
    await this.providerRegistry.prune(
      new Set(
        environments
          .filter((environment) => !environment.deletionRequestedAt)
          .map((environment) => environment.id),
      ),
    );
    if (this.host.isStopped()) return 0;
    const pending = environments.filter(
      (environment) =>
        environment.pendingAgentLaunch &&
        (environment.status === "creating" || environment.status === "running"),
    );
    await Promise.allSettled(
      pending
        .filter((environment) => (this.launchRetryAt.get(environment.id) ?? 0) <= now)
        .map((environment) => this.reconcileInitialLaunch(environment.id)),
    );
    return pending.length;
  }

  /** A fresh, confirmed observation says the session cannot take this head now. */
  queueSessionObservedBusy(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
    head: unknown,
  ): boolean {
    const requestId =
      head && typeof head === "object"
        ? (queueString(head as Record<string, unknown>, "requestId") ??
          queueString(head as Record<string, unknown>, "id"))
        : undefined;
    if (this.options.observationSharing === false) return false;
    // An async-question answer is delivered *into* a running Codex turn.
    if (agent === "codex" && requestId && nativeAsyncQuestionItemId(requestId)) return false;
    const key = nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey);
    const observed = this.observedSessionActivity.get(key);
    if (!observed) return false;
    const view = this.observations.view(key, observed.providerSessionId);
    const record = view.record;
    if (
      !record ||
      // Only the provider's own confirmation. The `working` a dispatch records
      // at acceptance is not evidence the turn is still running: a turn that
      // finished before the next sweep must still release its queue here.
      record.source !== "provider" ||
      view.freshness === "recovering" ||
      view.ageMs === undefined ||
      view.ageMs > QUEUE_BUSY_OBSERVATION_MAX_AGE_MS ||
      record.activity !== observed.state
    ) {
      return false;
    }
    return (
      record.activity === "waiting" ||
      (record.activity === "working" && record.readyForInput !== true)
    );
  }

  private async reconcileInitialLaunchOnce(environmentId: string): Promise<void> {
    if (this.host.isStopped()) return;
    const environment = await this.storage.getEnvironment(environmentId);
    if (
      !environment ||
      !environment.pendingAgentLaunch ||
      (environment.status !== "creating" && environment.status !== "running")
    ) {
      return;
    }
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(environment.projectId);
    // Resolve the same inherited settings contract the renderer uses to label
    // the durable startup projection. Launching and attachment staging are now
    // backend-owned for every mode.
    const tiers = {
      environment: environment.agentSettings,
      repository: repository.agentSettings,
      global: config.global.agentSettings,
    };
    const configuredLaunch = resolveStartupLaunchFromSettings(tiers);
    const agent = environment.initialAgentPlatform ?? configuredLaunch.agent;

    const logicalSessionKey = `env-${environment.id}:startup-agent`;
    // One resolver for the whole chain. This used to read the repository's
    // single `defaultModel` for *whatever* agent launched, so a model id
    // belonging to one platform's catalogue could be sent to another; a model
    // now travels only down its own platform column.
    const resolved = resolveAgentPlatformSettings(tiers, agent);
    const mode = resolved.mode;
    const claudeNativeBackend = resolveAgentPlatformSettings(tiers, "claude").claudeNativeBackend;
    const selectedModel = environment.initialAgentModel ?? resolved.model;
    // The Claude catalogue exposes Sonnet through its stable alias. Stored
    // release ids remain valid preferences but must be dispatched as that alias.
    const model =
      agent === "claude" &&
      (selectedModel === "claude-sonnet-5" || selectedModel === "claude-sonnet-5-5")
        ? "sonnet"
        : selectedModel;
    const reasoningEffort = environment.initialReasoningEffort ?? resolved.reasoningEffort;
    // Same one-shot-over-tier rule as the two above: a launcher that offered a
    // Fast/Normal control for this run must win over the platform's durable
    // setting, or the choice the user made in the dialog is silently ignored.
    const fastMode = environment.initialFastMode ?? resolved.fastMode;
    const conversationMode = environment.initialConversationMode;
    const parameterValues = agent === "claude" ? claudeNativeParameterValues(resolved) : undefined;
    const nativeProviderLaunch =
      mode === "native" && !(agent === "claude" && claudeNativeBackend === "tmux");

    if (!nativeProviderLaunch) {
      try {
        await this.storage.ensureTerminalJobTab({
          environmentId: environment.id,
          tabId: "startup-agent",
          type: agent === "claude" && claudeNativeBackend === "tmux" ? "claude-tmux" : agent,
          // A restored renderer must not attach to a PTY identity left by a
          // previous backend generation while this launch is still pending.
          terminalSessionId: null,
        });
        const startupSession = environment.startupAgentSession;
        if (
          !startupSession ||
          startupSession.tabId !== "startup-agent" ||
          startupSession.agent !== agent ||
          startupSession.style !== "terminal" ||
          startupSession.model !== model ||
          startupSession.reasoningEffort !== reasoningEffort ||
          startupSession.status !== "starting"
        ) {
          await this.storage.updateEnvironment(environment.id, {
            startupAgentSession: {
              tabId: "startup-agent",
              agent,
              style: "terminal",
              model,
              reasoningEffort,
              status: "starting",
            },
          });
        }
        if (!isEnvironmentReadyForAgents(environment)) return;

        let prompt = environment.initialPrompt?.trim() ?? "";
        const attachments = environment.initialPromptAttachments ?? [];
        if (attachments.length > 0) {
          const saved = await this.invoke<SavedInitialPromptAttachment[]>(
            "write_initial_prompt_attachments",
            {
              environmentId: environment.id,
              attachments: attachments.map(({ id, name, base64Data }) => ({
                id,
                name,
                base64Data,
              })),
            },
          );
          prompt = buildInitialPromptWithAttachmentReferences(prompt, saved);
          // Staging is a durable step of this launch. Persist the rewritten
          // prompt and consume the bodies before starting the PTY so a retry
          // reuses the same workspace files instead of creating another batch.
          await this.storage.updateEnvironment(environment.id, {
            initialPrompt: prompt,
            initialPromptAttachments: undefined,
          });
        }

        if (agent === "claude" && claudeNativeBackend === "tmux") {
          await this.invoke("launch_terminal_job", {
            requestId: `initial-prompt:${environment.id}:startup-agent`,
            environmentId: environment.id,
            tabId: "startup-agent",
            tabType: "claude-tmux",
            initialPrompt: prompt || undefined,
            model,
            reasoningEffort,
            fastMode,
            activateTab: true,
          });
        } else {
          const command = buildTerminalAgentLaunchCommand({
            tabType: agent,
            initialPrompt: prompt || undefined,
            model,
            reasoningEffort,
            fastMode,
          });
          if (!command) throw new Error(`${agent} does not support terminal launch`);
          await this.invoke("launch_terminal_job", {
            requestId: `initial-prompt:${environment.id}:startup-agent`,
            environmentId: environment.id,
            tabId: "startup-agent",
            tabType: agent,
            data: `${command}\n`,
            activateTab: true,
          });
        }

        await this.storage.updateEnvironment(environment.id, {
          pendingAgentLaunch: false,
          initialAgentPlatform: undefined,
          initialAgentModel: undefined,
          initialReasoningEffort: undefined,
          initialFastMode: undefined,
          initialConversationMode: undefined,
          initialPromptAttachments: undefined,
          initialPromptPresentation: undefined,
          startupAgentSession: undefined,
        });
        this.launchRetryAt.delete(environment.id);
      } catch (error) {
        this.launchRetryAt.set(environment.id, Date.now() + LAUNCH_RETRY_MS);
        await this.storage.updateEnvironment(environment.id, {
          startupAgentSession: {
            tabId: "startup-agent",
            agent,
            style: "terminal",
            model,
            reasoningEffort,
            status: "error",
            error: "Agent launch failed; the backend will retry.",
          },
        });
        throw error;
      }
      return;
    }

    // Publishing runs inside the same failure handling as the launch itself. A
    // throw here (an unwritable layout file, a root over the size bound) would
    // otherwise escape before the catch below records the durable error and
    // arms `launchRetryAt`, leaving the two-second sweep retrying forever with
    // no backoff and nothing for the renderer to surface.
    try {
      const prompt = environment.initialPrompt?.trim();
      const initialAttachments = environment.initialPromptAttachments ?? [];
      const hasInitialWork = Boolean(prompt || initialAttachments.length > 0);
      const preselectOptions = hasInitialWork
        ? { lockPlatform: true as const }
        : {
            initialAgentPlatform: agent,
            ...(model ? { initialAgentModel: model } : {}),
            ...(reasoningEffort ? { initialReasoningEffort: reasoningEffort } : {}),
            ...(conversationMode ? { initialConversationMode: conversationMode } : {}),
            ...(typeof fastMode === "boolean" ? { initialFastMode: fastMode } : {}),
          };

      // Publish both startup surfaces as soon as backend intent exists,
      // including while setup is still running. Provider creation remains gated
      // below, but the durable pane can already rehydrate in an inactive
      // renderer. A prompt-less launch stays unassigned so the user can still
      // change the preselected model before the first send.
      await this.storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent,
        ...preselectOptions,
      });
      const startupSession = environment.startupAgentSession;
      if (
        !startupSession ||
        startupSession.agent !== agent ||
        startupSession.style !== "native" ||
        startupSession.status !== "starting"
      ) {
        await this.storage.updateEnvironment(environment.id, {
          startupAgentSession: {
            tabId: "startup-agent",
            agent,
            style: "native",
            model,
            reasoningEffort,
            status: "starting",
          },
        });
      }

      if (!isEnvironmentReadyForAgents(environment)) return;

      if (!hasInitialWork) {
        // No opening prompt was submitted with the environment. Leave the tab
        // unlocked, keep the create-dialog model as a one-shot preselect, and
        // do not mint a provider session the user may never use.
        const publishedLayout = await this.storage.ensureStartupNativeAgentTab({
          environmentId: environment.id,
          agent,
          activateOnSetupHandoff: true,
          ...preselectOptions,
        });
        await this.storage.updateEnvironment(environment.id, {
          pendingAgentLaunch: false,
          initialAgentPlatform: undefined,
          initialAgentModel: undefined,
          initialReasoningEffort: undefined,
          initialFastMode: undefined,
          initialConversationMode: undefined,
          initialPromptAttachments: undefined,
          initialPromptPresentation: undefined,
          startupAgentSession: publishedLayout
            ? undefined
            : {
                tabId: "startup-agent",
                agent,
                style: "native",
                model,
                reasoningEffort,
                status: "running",
                startedAt: new Date().toISOString(),
              },
        });
        this.launchRetryAt.delete(environment.id);
        return;
      }

      const files = initialAttachments.filter((attachment) => attachment.type === "file");
      // Images stay as base64 until the provider stages them inside the durable
      // dispatch lock. Files use the same lock through the preparation callback
      // below. Staging either kind before dispatch would let every supervisor
      // write a competing copy of the same startup attachment.
      const images = initialAttachments
        .filter((attachment) => attachment.type !== "file")
        .map((attachment) => ({
          filename: attachment.name,
          data: attachment.base64Data,
        }));
      const dispatchInput: DispatchNativeAgentPromptInput = {
        environmentId: environment.id,
        agent,
        logicalSessionKey,
        model,
        // A model the launch named is pinned. One read from the settings tiers
        // is an inherited default, which the runtime may replace when this
        // login cannot serve it (the shipped Codex `gpt-5.4` on a ChatGPT
        // login): otherwise every worker a coordinator launches with default
        // settings fails its first turn.
        modelSource: environment.initialAgentModel ? "explicit" : "default",
        reasoningEffort,
        ...(conversationMode ? { mode: conversationMode } : {}),
        ...(typeof fastMode === "boolean" ? { fastMode } : {}),
        ...(parameterValues ? { parameterValues } : {}),
        // A file-only turn needs non-blank text before its final workspace paths
        // can be resolved inside the dispatch lock below.
        prompt: prompt || (files.length > 0 ? "Use the attached file." : ""),
        requestId: `initial-prompt:${environment.id}:startup-agent`,
        images,
        ...(environment.initialPromptPresentation
          ? { initialPromptPresentation: environment.initialPromptPresentation }
          : {}),
      };
      const session =
        files.length > 0
          ? await this.host.dispatchPromptWithPreparation(dispatchInput, async () => {
              const saved = await this.invoke<SavedInitialPromptAttachment[]>(
                "write_initial_prompt_attachments",
                {
                  environmentId: environment.id,
                  attachments: files.map(({ id, name, base64Data }) => ({
                    id,
                    name,
                    base64Data,
                  })),
                },
              );
              return {
                dispatch: true,
                prompt: buildInitialPromptWithAttachmentReferences(prompt ?? "", saved),
              };
            })
          : await this.host.dispatchPrompt(dispatchInput);

      // The provider mapping is not enough to satisfy the launch: the user
      // needs a durable pane projection even if every renderer was inactive
      // throughout setup. Publish it before consuming the launch intent so a
      // crash at either boundary is safely retried and converges by stable id.
      const publishedLayout = await this.storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent,
        providerSessionId: session.providerSessionId,
        lockPlatform: true,
      });

      await this.storage.updateEnvironment(environment.id, {
        pendingAgentLaunch: false,
        initialAgentPlatform: undefined,
        initialAgentModel: undefined,
        initialReasoningEffort: undefined,
        initialFastMode: undefined,
        initialConversationMode: undefined,
        initialPromptAttachments: undefined,
        initialPromptPresentation: undefined,
        // Once the durable pane carries the provider session id, the snapshot
        // has no remaining reader and must reach a terminal state. Leaving it
        // set is not inert: every renderer keeps polling this environment for
        // the life of the app, and the launch effect keeps re-projecting a
        // startup tab the user has since closed.
        startupAgentSession: publishedLayout
          ? undefined
          : {
              tabId: "startup-agent",
              agent,
              style: "native",
              model,
              reasoningEffort,
              providerSessionId: session.providerSessionId,
              status: "running",
              startedAt: new Date().toISOString(),
            },
      });
      this.launchRetryAt.delete(environment.id);
    } catch (error) {
      // A rejection is the provider's verdict on this prompt, not a transient
      // fault: retrying it every ten seconds forever would never succeed and
      // leaves the environment hidden-mounted and polled for the life of the
      // app. Stop retrying and let the surfaced error stand.
      const terminal = error instanceof PromptRejectedError;
      console.warn(
        `[native-agent] Startup launch for ${environment.id} failed` +
          `${terminal ? " permanently" : ""}: ` +
          (error instanceof Error ? error.name : "unknown error"),
      );
      if (!terminal) this.launchRetryAt.set(environment.id, Date.now() + LAUNCH_RETRY_MS);
      await this.storage.updateEnvironment(environment.id, {
        ...(terminal
          ? {
              pendingAgentLaunch: false,
              initialAgentPlatform: undefined,
              initialAgentModel: undefined,
              initialReasoningEffort: undefined,
              initialFastMode: undefined,
              initialConversationMode: undefined,
              initialPromptAttachments: undefined,
              initialPromptPresentation: undefined,
            }
          : {}),
        startupAgentSession: {
          tabId: "startup-agent",
          agent,
          style: "native",
          model,
          reasoningEffort,
          status: "error",
          error: terminal
            ? `The agent rejected the initial prompt: ${error.message}`
            : "Agent launch failed; the backend will retry.",
        },
      });
      throw error;
    }
  }
}

/**
 * The failure a provider keeps off its lifecycle: OpenCode reads idle after a
 * failed turn and keeps the error on the request's answer; Grok's bridge
 * journals a turn it cut short. Read only on a completion edge, from the latest
 * dispatched request's outcome, never a session touch. The user's own stop is
 * not a failure. An unavailable outcome must reject so the group retries
 * without consuming its completion edge.
 */
async function readTurnTerminalFailure(
  provider: NativeAgentRuntimeProvider,
  session: PersistedNativeAgentSession,
): Promise<boolean> {
  const requestId = session.dispatchedRequestIds?.at(-1);
  if (!requestId || !provider.turnTerminalError) return false;
  const terminalError = await provider.turnTerminalError(session.providerSessionId, requestId);
  return terminalError !== null && terminalError !== TURN_STOPPED_BY_USER_MESSAGE;
}

/**
 * Whether the bridge answering now says an earlier process of it took the
 * session's latest request and left no outcome: its turn was cut short, however
 * idle the restored session reads. Cursor, Grok and Pi restore such a session
 * with no error, so this is the only trace. Best effort: every other answer,
 * and a failed read, leaves the turn reported as it would have been. OpenCode
 * has no such journal: it never answers `lost`, and asking reads its transcript.
 * Claude's restored dispatch claims also include successfully completed turns;
 * only its explicit interruption evidence can prove that a turn failed.
 */
async function readTurnLost(
  provider: NativeAgentRuntimeProvider,
  session: PersistedNativeAgentSession,
): Promise<boolean> {
  const requestId = session.dispatchedRequestIds?.at(-1);
  if (
    !["codex", "cursor", "grok", "pi"].includes(session.agent) ||
    !requestId ||
    !provider.dispatchStatus
  )
    return false;
  if (
    session.turnOutcomes?.some(
      (outcome) => outcome.requestId === requestId && outcome.outcome === "completed",
    )
  )
    return false;
  if (latestTurnStopped(session)) return false;
  const status = await provider
    .dispatchStatus(session.providerSessionId, requestId)
    .catch(() => "unknown" as const);
  return status === "lost";
}

function latestRequestId(session: PersistedNativeAgentSession): string | undefined {
  return session.pendingDispatch?.requestId ?? session.dispatchedRequestIds?.at(-1);
}

/** The user asked to stop the session's latest turn. */
function latestTurnStopped(session: PersistedNativeAgentSession): boolean {
  const requestId = latestRequestId(session);
  return requestId !== undefined && session.interruptedRequestIds?.includes(requestId) === true;
}

/** Positive durable activity evidence, rather than a missing outcome, proves a running turn. */
function hasUnsettledTurn(session: PersistedNativeAgentSession): boolean {
  const requestId = latestRequestId(session);
  return (
    requestId !== undefined &&
    session.activityTurn?.state === "active" &&
    session.activityTurn.providerSessionId === session.providerSessionId &&
    session.activityTurn.requestId === requestId &&
    !latestTurnStopped(session) &&
    !session.turnOutcomes?.some((outcome) => outcome.requestId === requestId)
  );
}

function activityTurnSettled(session: PersistedNativeAgentSession): boolean {
  return (
    session.activityTurn?.state === "settled" &&
    session.activityTurn.providerSessionId === session.providerSessionId &&
    session.activityTurn.requestId === latestRequestId(session)
  );
}

function completionKey(session: PersistedNativeAgentSession): string | undefined {
  const requestId = latestRequestId(session);
  return requestId
    ? JSON.stringify(["native-turn", session.key, session.providerSessionId, requestId])
    : undefined;
}
