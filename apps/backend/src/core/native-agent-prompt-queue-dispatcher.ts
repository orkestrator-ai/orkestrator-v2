import type {
  BuildPipelineAgent,
  NativeAgentSessionActionOutcome,
  Environment,
  PersistedNativeAgentSession,
  StorageService,
  NativeAgentRuntimeProvider,
  PromptAttachment,
  EnsureNativeAgentSessionInput,
  DispatchNativeAgentPromptInput,
  NativeAgentProjectionInput,
} from "./native-agent-service-shared.js";
import {
  BUILD_PIPELINE_AGENTS,
  nativeAgentSessionStorageKey,
  nonBlank,
  readProviderStatus,
  isEnvironmentReadyForAgents,
  MAX_QUEUE_DISPATCH_ATTEMPTS,
  QUEUE_RETRY_BASE_MS,
  QUEUE_RETRY_CEILING_MS,
  assertValidPromptAttachments,
} from "./native-agent-service-shared.js";
import { nativeAsyncQuestionItemId } from "@orkestrator/protocol/native-agent";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { NativeQueueScheduling } from "./native-agent-queue-scheduling.js";
import { PromptRejectedError } from "./agent-provider-contract.js";
import { parseNativeAgentCommandIntent } from "@orkestrator/protocol/agent-command-catalogue";
import { composeDraftHoldsQueue } from "./compose-draft-occupancy.js";
import {
  queueBoolean,
  queueDispatchMode,
  queueExecutionMode,
  queueFastMode,
  queueReasoningEffort,
  queueString,
} from "./native-agent-queue-message.js";

type SettledSteer = "dispatched" | "absent" | undefined;

/** What the prompt-queue dispatcher needs from the service that wires it. */
export interface NativeAgentPromptQueueDispatcherHost {
  storage: StorageService;
  isStopped(): boolean;
  /** Track a background task so shutdown drains it. */
  trackScan(task: Promise<void>): Promise<void>;
  /** Re-read a session's authoritative projection after a parked dispatch settles. */
  refreshProjection(input: NativeAgentProjectionInput): Promise<unknown>;
  /** A fresh, provider-confirmed observation says the session cannot take this head now. */
  queueSessionObservedBusy(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
    head: unknown,
  ): boolean;
  assertEnvironmentLive(environmentId: string): Promise<Environment>;
  ensureSession(input: EnsureNativeAgentSessionInput): Promise<PersistedNativeAgentSession>;
  provider(input: EnsureNativeAgentSessionInput): Promise<NativeAgentRuntimeProvider>;
  dispatchPrompt(input: DispatchNativeAgentPromptInput): Promise<PersistedNativeAgentSession>;
  /** Deliver a queued asynchronous-question answer into the running turn. */
  dispatchQueuedAsyncQuestionAnswer(
    input: NativeAgentProjectionInput,
    resolved: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
    },
    text: string,
    requestId: string,
  ): Promise<NativeAgentSessionActionOutcome>;
  recordObservedTurnOutcome(
    session: PersistedNativeAgentSession,
    status: string,
    detail: string | undefined,
    provider?: Pick<NativeAgentRuntimeProvider, "turnTerminalError">,
  ): Promise<void>;
  /** Resolve a parked prompt dispatch as confirmed or permanently retired. */
  settleAmbiguousDispatch(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    provider?: NativeAgentRuntimeProvider,
  ): Promise<"confirmed" | "retired" | undefined>;
  /** Resolve a parked steer against its provider. */
  settleAmbiguousSteer(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    provider?: NativeAgentRuntimeProvider,
  ): Promise<SettledSteer>;
}

/**
 * Admission ordering and the durable prompt queues.
 *
 * Owns the per-session work fence (dispatch, Stop and publication take it in
 * order), the mutation-intent counts and unpersisted Stop fences that publication
 * reads, the queue drains with their back-off, the keyed queue scheduler, and the
 * in-flight parked-dispatch settles. Each bound moves with its state: 1,024 work
 * fences and mutation keys, 256 unpersisted interrupts (overflow fences every
 * publication rather than evicting a Stop), and one drain task per queue.
 *
 * The storage lease is still taken inside the dispatch path, and queue claims
 * still go through `storage.enqueueNativeAgentSessionMutation`'s ordering; this
 * class only decides when a drain runs.
 */
export class NativeAgentPromptQueueDispatcher {
  private readonly sessionWorkFences = new Map<string, Promise<void>>();
  private sessionWorkFenceCount = 0;
  private readonly pendingSessionMutations = new Map<string, number>();

  /** Make waiting user work visible before it can acquire the publication fence. */
  withSessionMutationFence<T>(
    input: NativeAgentProjectionInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withSessionMutationIntent(input, () => this.withSessionWorkFence(input, operation));
  }

  /** Stop publishes its intent immediately, without waiting behind a cold dispatch. */
  async withSessionMutationIntent<T>(
    input: NativeAgentProjectionInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (!this.pendingSessionMutations.has(key) && this.pendingSessionMutations.size >= 1024) {
      throw new Error("Native session mutation admission is at capacity");
    }
    this.pendingSessionMutations.set(key, (this.pendingSessionMutations.get(key) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.pendingSessionMutations.get(key) ?? 1) - 1;
      if (remaining > 0) this.pendingSessionMutations.set(key, remaining);
      else this.pendingSessionMutations.delete(key);
    }
  }
  /** Failed interrupt writes remain publication fences until storage acknowledges them. */
  private readonly pendingTurnInterrupts = new Map<
    string,
    {
      providerSessionId: string;
      requestId: string;
    }
  >();
  private interruptFenceOverflow = false;

  /** Orders publication admission against dispatch and Stop for this session only. */
  async withSessionWorkFence<T>(
    input: NativeAgentProjectionInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (this.sessionWorkFenceCount >= 1024)
      throw new Error("Native session work admission is at capacity");
    this.sessionWorkFenceCount += 1;
    const previous = this.sessionWorkFences.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.sessionWorkFences.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      this.sessionWorkFenceCount -= 1;
      if (this.sessionWorkFences.get(key) === tail) this.sessionWorkFences.delete(key);
    }
  }
  private readonly queueTasks = new Map<string, Promise<void>>();
  private readonly queueRetryAt = new Map<string, number>();
  /** Keyed launch/queue driver (step 08); `null` on the rollback timer. */
  private queueScheduling: NativeQueueScheduling | null = null;
  private readonly queueAttempts = new Map<string, number>();

  /**
   * Parked dispatches currently being settled against their provider, keyed by
   * session and request id. Projection reads are frequent and the settle is a
   * network round trip, so this keeps one refresh from queueing another.
   */
  private readonly settlingDispatches = new Set<string>();

  private readonly storage: StorageService;

  constructor(private readonly host: NativeAgentPromptQueueDispatcherHost) {
    this.storage = host.storage;
  }

  /**
   * Fence publication behind a Stop until storage records the interrupt. At
   * most 256 are held; past that every publication stays fenced rather than an
   * unpersisted Stop being evicted.
   */
  fenceTurnInterrupt(sessionKey: string, providerSessionId: string, requestId: string): void {
    const interruptKey = `${sessionKey}\0${requestId}`;
    if (this.pendingTurnInterrupts.size < 256 || this.pendingTurnInterrupts.has(interruptKey)) {
      this.pendingTurnInterrupts.set(interruptKey, { providerSessionId, requestId });
    } else {
      // Never evict an unpersisted Stop to make room for another one.
      this.interruptFenceOverflow = true;
    }
  }

  /** Storage acknowledged the interrupt; publication no longer needs the fence. */
  releaseTurnInterrupt(sessionKey: string, requestId: string): void {
    this.pendingTurnInterrupts.delete(`${sessionKey}\0${requestId}`);
  }

  /** The unpersisted Stop fencing this request, if any. */
  pendingTurnInterrupt(
    sessionKey: string,
    requestId: string,
  ): { providerSessionId: string; requestId: string } | undefined {
    return this.pendingTurnInterrupts.get(`${sessionKey}\0${requestId}`);
  }

  /** Whether a Stop could not be fenced individually, so no outcome is trustworthy. */
  interruptFencesOverflowed(): boolean {
    return this.interruptFenceOverflow;
  }

  /** Whether user work for this session is waiting for, or holding, its fence. */
  hasPendingSessionMutation(sessionKey: string): boolean {
    return this.pendingSessionMutations.has(sessionKey);
  }

  /** One observed pass over every queue; the timer-driven sweep. */
  queueScan(): Promise<void> {
    return this.observedQueueScan();
  }

  /** Start the keyed launch/queue driver (step 08) in place of the rollback timer. */
  startKeyedScheduling(
    launchScan: () => Promise<number>,
    options: ConstructorParameters<typeof NativeQueueScheduling>[1],
  ): void {
    this.queueScheduling = new NativeQueueScheduling(
      {
        launchScan,
        listQueues: () => this.storage.listAllPromptQueues(),
        drainQueue: (queueKey) => this.host.trackScan(this.drainPromptQueue(queueKey)),
        queueRetryDelayMs: (queueKey) =>
          Math.max(0, (this.queueRetryAt.get(queueKey) ?? 0) - Date.now()),
      },
      options,
    );
    this.queueScheduling.start();
  }

  stopScheduling(): void {
    this.queueScheduling?.stop();
    this.queueScheduling = null;
  }

  /** A durable queue changed; wake only its own due key. */
  queueChanged(queueKey: string): void {
    this.queueScheduling?.queueChanged(queueKey);
  }

  /** Queue drains still running, for shutdown to drain. */
  pendingDrains(): Promise<void>[] {
    return [...this.queueTasks.values()];
  }

  /**
   * Test-only view of the state this dispatcher owns. Service tests reach
   * queue and fence state here, never through the service.
   */
  forTesting() {
    return {
      queueTasks: this.queueTasks,
      queueRetryAt: this.queueRetryAt,
      queueAttempts: this.queueAttempts,
      settlingDispatches: this.settlingDispatches,
      pendingSessionMutations: this.pendingSessionMutations,
      pendingTurnInterrupts: this.pendingTurnInterrupts,
      queueScheduling: () => this.queueScheduling,
      drainPromptQueues: () => this.drainPromptQueues(),
      drainPromptQueueOnce: (queueKey: string) => this.drainPromptQueueOnce(queueKey),
    };
  }

  private observedQueueScan(): Promise<void> {
    recurringWorkMetrics.requested("native-queue-scan");
    return recurringWorkMetrics.observe("native-queue-scan", () => this.drainPromptQueues());
  }

  /**
   * Settle a parked dispatch in the background, at most once at a time per
   * session.
   *
   * Driven from projection reads so a record that outlived the dispatch that
   * created it — a backend restart mid-flight, a bridge that came back after
   * the tab was closed — is resolved by the next refresh rather than waiting
   * for the user. Never awaited by the projection: an authoritative snapshot
   * must not be delayed by, or fail because of, an optional reconciliation.
   */
  scheduleAmbiguousDispatchSettle(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved: NativeAgentRuntimeProvider,
  ): void {
    const inFlight = `${key}\0${requestId}`;
    if (this.settlingDispatches.has(inFlight)) return;
    this.settlingDispatches.add(inFlight);
    void this.host
      .trackScan(
        this.host
          .settleAmbiguousDispatch(input, key, requestId, resolved)
          .then((settled) => {
            if (settled) void this.host.refreshProjection(input).catch(() => undefined);
          })
          .catch(() => undefined)
          .finally(() => this.settlingDispatches.delete(inFlight)),
      )
      .catch(() => undefined);
  }

  scheduleAmbiguousSteerSettle(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved: NativeAgentRuntimeProvider,
  ): void {
    const inFlight = `steer\0${key}\0${requestId}`;
    if (this.settlingDispatches.has(inFlight)) return;
    this.settlingDispatches.add(inFlight);
    void this.host
      .trackScan(
        this.host
          .settleAmbiguousSteer(input, key, requestId, resolved)
          .then((settled) => {
            if (settled) void this.host.refreshProjection(input).catch(() => undefined);
          })
          .catch(() => undefined)
          .finally(() => this.settlingDispatches.delete(inFlight)),
      )
      .catch(() => undefined);
  }

  /**
   * Wake the durable queue worker after an intent-level queue mutation.
   *
   * The periodic scan remains the crash/restart safety net, but a newly queued
   * interactive prompt should not wait for that timer. The worker owns all
   * provider I/O and its per-queue task map coalesces concurrent notifications.
   */
  /** Step 08 diagnostics for the keyed launch/queue driver (`null` on rollback). */
  schedulingStatus() {
    return this.queueScheduling?.status() ?? null;
  }

  wakeEnvironment(environmentId: string): void {
    this.queueScheduling?.wakeEnvironment(environmentId);
  }

  async reconcileScheduling() {
    return this.queueScheduling ? this.queueScheduling.reconcileNow() : null;
  }

  notifyPromptQueueChanged(queueKey: string): void {
    if (this.host.isStopped() || !nonBlank(queueKey)) return;
    // Index the key so a busy session's queue keeps its 2 s due check.
    this.queueScheduling?.wakeQueue(queueKey, "enqueue");
    void this.drainPromptQueue(queueKey);
  }

  /**
   * Drain one session's queue now, named by the session's own identity.
   *
   * The turn-end edge already knows which session became free; waiting for the
   * next two-second sweep to rediscover that is latency for nothing. A session
   * with no queue costs one storage read, and the drain coalesces with any
   * pass already running.
   */
  async drainPromptQueueForSession(input: {
    agent?: BuildPipelineAgent;
    logicalSessionKey?: string;
  }): Promise<void> {
    if (this.host.isStopped()) return;
    const { agent, logicalSessionKey } = input;
    if (!agent || !nonBlank(logicalSessionKey)) return;
    if (!BUILD_PIPELINE_AGENTS.includes(agent)) return;
    const queueKey = `${agent}\0${logicalSessionKey}`;
    const queue = await this.storage.getPromptQueue(queueKey);
    this.queueScheduling?.note(queue, queueKey);
    if (!queue || (queue.dispatchError && !queue.inFlight?.steer)) return;
    if (queue.inFlight === undefined && queue.messages.length === 0) return;
    await this.drainPromptQueue(queueKey);
  }

  private async drainPromptQueues(): Promise<void> {
    if (this.host.isStopped()) return;
    const now = Date.now();
    const queues = await this.storage.listAllPromptQueues();
    if (this.host.isStopped()) return;
    await Promise.allSettled(
      queues
        .filter((queue) => {
          const agent = queue.queueKey.split("\0", 1)[0];
          return (
            BUILD_PIPELINE_AGENTS.includes(agent as BuildPipelineAgent) &&
            (queue.messages.length > 0 || queue.inFlight !== undefined) &&
            (queue.inFlight?.steer || queue.dispatchError === undefined) &&
            (this.queueRetryAt.get(queue.queueKey) ?? 0) <= now
          );
        })
        .map((queue) => this.drainPromptQueue(queue.queueKey)),
    );
  }

  /**
   * Back off a queue and, once the attempts are clearly not transient, park it
   * with a durable error the renderer can show.
   *
   * An unbounded 2s retry is invisible: nothing is logged, no dispatchError is
   * latched, and the user sees a queue that simply never drains.
   */
  private async deferQueue(
    queueKey: string,
    reason: string,
    requestId?: string,
    park?: {
      /**
       * Reserve the queue head so an exhausted deferral can park it even though
       * no dispatch ever claimed it. Only for conditions the drain itself can
       * never clear; a transient one must keep retrying instead.
       */
      reserveHead?: boolean;
      /** Persisted for the user; `reason` is what reaches the log. */
      message?: string;
    },
  ): Promise<void> {
    const attempts = (this.queueAttempts.get(queueKey) ?? 0) + 1;
    this.queueAttempts.set(queueKey, attempts);
    if (attempts >= MAX_QUEUE_DISPATCH_ATTEMPTS) {
      // The key and the reason are safe to log; the prompt itself never is, and
      // neither is provider-authored detail — that is persisted, not logged.
      console.warn(
        `[native-agent] Prompt queue ${queueKey} has failed ${attempts} times: ${reason}`,
      );
      // A head no dispatch ever reserved has no request id, so the park path a
      // failed dispatch uses could not run: the prompt was neither sent nor
      // failed and the queue stalled at the backoff ceiling with nothing shown
      // to the user. Reserving it here gives that path its identity.
      const parkedRequestId =
        requestId ??
        (park?.reserveHead
          ? (await this.storage.reservePromptQueueHeadForDispatch(queueKey))?.requestId
          : undefined);
      if (parkedRequestId !== undefined) {
        this.queueAttempts.delete(queueKey);
        this.queueRetryAt.delete(queueKey);
        await this.storage.failPromptQueueDispatch(
          queueKey,
          parkedRequestId,
          park?.message ?? reason,
        );
        return;
      }
    }
    // Exponential up to a ceiling so a wedged provider is retried rarely rather
    // than every two seconds forever.
    const backoff = Math.min(
      QUEUE_RETRY_CEILING_MS,
      QUEUE_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8),
    );
    this.queueRetryAt.set(queueKey, Date.now() + backoff);
  }

  private clearQueueBackoff(queueKey: string): void {
    this.queueAttempts.delete(queueKey);
    this.queueRetryAt.delete(queueKey);
  }

  private async drainPromptQueue(queueKey: string): Promise<void> {
    if (this.host.isStopped()) return;
    const existing = this.queueTasks.get(queueKey);
    if (!existing) {
      const task = this.drainPromptQueueOnce(queueKey).finally(() => {
        if (this.queueTasks.get(queueKey) === task) {
          this.queueTasks.delete(queueKey);
        }
      });
      this.queueTasks.set(queueKey, task);
      return task;
    }
    // Coalesce concurrent notifications onto the in-flight pass, but guarantee
    // a fresh pass after it settles: that pass may already have read the queue
    // before this notification's mutation was persisted, so only a follow-up
    // pass is certain to see the new head. The in-flight pass removes itself
    // from the task map before these follow-ups run, so any number of
    // notifications collapse onto a single extra pass rather than one per
    // notification.
    return existing.finally(() => {
      if (this.queueTasks.has(queueKey)) return;
      void this.drainPromptQueue(queueKey);
    });
  }

  private async drainPromptQueueOnce(queueKey: string): Promise<void> {
    try {
      await this.drainReadyPromptQueue(queueKey);
    } catch (error) {
      // Any fault that escapes the drain must still back off. A storage read or
      // reservation that throws bypasses every inner handler, and the scan's
      // `allSettled` swallows the rejection — so without this the queue was
      // retried every two seconds with no attempt counter, no latch and no log:
      // the same invisible hot loop deferQueue exists to prevent, reached
      // through a storage fault instead of a provider fault.
      await this.deferQueue(
        queueKey,
        error instanceof Error ? error.name : "unknown drain error",
      ).catch(() => undefined);
    }
  }

  private async drainReadyPromptQueue(queueKey: string): Promise<void> {
    if (this.host.isStopped()) return;
    const separator = queueKey.indexOf("\0");
    if (separator <= 0) return;
    const agent = queueKey.slice(0, separator) as BuildPipelineAgent;
    const logicalSessionKey = queueKey.slice(separator + 1);
    if (!BUILD_PIPELINE_AGENTS.includes(agent) || !nonBlank(logicalSessionKey)) {
      return;
    }
    const queue = await this.storage.getPromptQueue(queueKey);
    this.queueScheduling?.note(queue, queueKey);
    if (!queue) return;
    if (queue.inFlight?.steer) {
      const key = nativeAgentSessionStorageKey(queue.environmentId, agent, logicalSessionKey);
      await this.storage.recoverPromptQueueSteer(key, queue.inFlight.requestId);
      const session = await this.storage.getNativeAgentSession(key);
      if (session?.pendingSteer?.requestId === queue.inFlight.requestId) {
        await this.host.settleAmbiguousSteer(
          { environmentId: queue.environmentId, agent, logicalSessionKey },
          key,
          queue.inFlight.requestId,
        );
      }
      return;
    }
    if (queue.dispatchError) return;
    if (queue.inFlight === undefined && queue.messages.length === 0) return;
    const environment = await this.host.assertEnvironmentLive(queue.environmentId);
    // The launch path has always required this; so must the drain path. A
    // stopped or still-provisioning environment must not be started by a
    // leftover queued prompt.
    if (!isEnvironmentReadyForAgents(environment)) {
      await this.deferQueue(queueKey, "environment is not ready for agents");
      return;
    }
    const draftKey = `${agent}:${queue.environmentId}:${encodeURIComponent(logicalSessionKey)}`;
    const draft = await this.storage.getComposeDraft(draftKey);
    if (composeDraftHoldsQueue(draft?.value)) return;

    const head = queue.inFlight?.message ?? queue.messages[0];
    /*
     * Share the activity sweep's answer instead of reading the provider again.
     * `ensureSession` and the status read below are tab-facing reads — a
     * liveness touch on Codex, a transcript hydrate on Claude — and a busy
     * session with a queued prompt used to pay both on every two-second pass
     * for the whole turn. A fresh, confirmed busy answer ends this pass exactly
     * as a `running` status would; the turn-end edge drains the queue, and an
     * answer older than two sweeps falls back to the authoritative read.
     * Idle is never taken from here: dispatch still requires the provider's
     * own current status below.
     */
    if (this.host.queueSessionObservedBusy(queue.environmentId, agent, logicalSessionKey, head)) {
      recurringWorkMetrics.cacheHit("native-queue-scan");
      return;
    }
    const mode = queueExecutionMode(agent, head);
    const session = await this.host.ensureSession({
      environmentId: queue.environmentId,
      agent,
      logicalSessionKey,
      model: queueString(head, "model"),
      reasoningEffort: queueReasoningEffort(head),
      phase: mode === "plan" ? "review" : "build",
    });
    const provider = await this.host.provider({
      environmentId: queue.environmentId,
      agent,
      logicalSessionKey,
      model: queueString(head, "model"),
      reasoningEffort: queueReasoningEffort(head),
    });
    await this.host.assertEnvironmentLive(queue.environmentId);
    // Read as data: a failed last turn must defer with a bounded backoff and a
    // reason, not escape as a throw that the outer handler can only report as
    // an anonymous drain fault.
    const { status, error: statusDetail } = await readProviderStatus(
      provider,
      session.providerSessionId,
    );
    // This read is the last look at the previous turn before the next prompt
    // replaces its status; keep its content-free outcome for observers.
    await this.host.recordObservedTurnOutcome(session, status, statusDetail, provider);
    await this.host.assertEnvironmentLive(queue.environmentId);
    if (status === "running") {
      const requestId =
        head && typeof head === "object"
          ? (queueString(head as Record<string, unknown>, "requestId") ??
            queueString(head as Record<string, unknown>, "id"))
          : undefined;
      if (agent !== "codex" || !requestId || !nativeAsyncQuestionItemId(requestId)) return;

      const reservation = await this.storage.reservePromptQueueHeadForDispatch(queueKey);
      if (!reservation || typeof reservation.message !== "object") return;
      const message = reservation.message as Record<string, unknown>;
      const latestSession = await this.storage.getNativeAgentSession(session.key);
      if (latestSession?.dispatchedRequestIds?.includes(reservation.requestId)) {
        await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
        this.clearQueueBackoff(queueKey);
        return;
      }
      if (!nonBlank(message.text)) {
        await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
        return;
      }
      // Async-question answers are text-only and keep their queue reservation
      // until reliable steering has either been confirmed or the live turn has
      // ended. The latter case falls through to ordinary next-turn dispatch on
      // a later drain pass without changing the request identity.
      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        await this.storage.failPromptQueueDispatch(
          queueKey,
          reservation.requestId,
          "Asynchronous-question answers cannot include attachments",
        );
        return;
      }
      try {
        const outcome = await this.host.dispatchQueuedAsyncQuestionAnswer(
          { environmentId: queue.environmentId, agent, logicalSessionKey },
          { key: session.key, session, provider },
          message.text,
          reservation.requestId,
        );
        if (outcome.outcome === "applied") {
          await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
          this.clearQueueBackoff(queueKey);
        }
        // idle/mismatch means the turn ended during qualification, and
        // rejected means the bridge refused more steering for this turn. Keep
        // the reservation for the next idle pass, which sends it as a normal turn.
        // unknown is protected by pendingSteer and the recoverable-dispatch UI.
      } catch {
        // A bridge without reliable steering can still deliver this response as
        // an ordinary prompt after the active turn ends. Keep it reserved and
        // avoid treating capability skew as a failed user answer.
      }
      return;
    }
    if (status === "blocked") return;
    if (status !== "idle") {
      await this.deferQueue(queueKey, `provider session is ${status}`, queue.inFlight?.requestId, {
        /*
         * A terminal turn error is sticky until the next turn runs, and the
         * drain is the only thing that would have run it — so retrying can
         * never clear this on its own. Deferring alone left the prompt
         * neither sent nor failed and told the user nothing. Park it instead:
         * the composer shows the provider's own explanation and the existing
         * retry control resends it once the model is changed. Auto-sending
         * here would be worse than silence, because an at-capacity model
         * fails every queued prompt in turn and burns the whole queue.
         */
        reserveHead: true,
        message: statusDetail
          ? `The ${agent} session failed before this prompt was sent: ${statusDetail.slice(0, 500)}`
          : `The ${agent} session is ${status}; the queued prompt was not sent.`,
      });
      return;
    }
    if (this.host.isStopped()) return;
    const latestDraft = await this.storage.getComposeDraft(draftKey);
    if (composeDraftHoldsQueue(latestDraft?.value)) return;
    const reservation = await this.storage.reservePromptQueueHeadForDispatch(queueKey);
    if (!reservation || typeof reservation.message !== "object") return;
    const message = reservation.message as Record<string, unknown>;
    if (!nonBlank(message.text)) {
      await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
      return;
    }

    // Queued attachments were staged by the renderer, so they already carry
    // workspace paths and can be attached for real. Flattening them into prose
    // silently degraded an image to a filename the model had to guess at.
    let attachments: PromptAttachment[] = [];
    try {
      attachments = Array.isArray(message.attachments)
        ? assertValidPromptAttachments(message.attachments)
        : [];
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Queued attachment is invalid";
      await this.storage.failPromptQueueDispatch(queueKey, reservation.requestId, reason);
      this.clearQueueBackoff(queueKey);
      return;
    }
    // A backend-authored prompt that relies on the session's own mode (a
    // read-only web annotation discussion in a session-scoped Plan mode) is
    // sent only while the session is still in that mode. Sending it anyway
    // would switch the mode back, or run it with write access; park it with
    // the reason instead, and the owner retries or cancels.
    const requiredMode = message.requireSessionMode;
    if (requiredMode !== undefined) {
      const current = (await this.storage.getNativeAgentSession(session.key))?.controls?.mode;
      if (requiredMode !== "plan" || current !== "plan") {
        await this.storage.failPromptQueueDispatch(
          queueKey,
          reservation.requestId,
          `The session is no longer in Plan mode, so this read-only prompt was not sent. Switch the session back to Plan and retry, or cancel it.`,
        );
        this.clearQueueBackoff(queueKey);
        return;
      }
    }
    try {
      await this.host.dispatchPrompt({
        environmentId: queue.environmentId,
        agent,
        logicalSessionKey,
        model: queueString(message, "model"),
        reasoningEffort: queueReasoningEffort(message),
        phase: queueExecutionMode(agent, message) === "plan" ? "review" : "build",
        mode: queueDispatchMode(agent, message),
        fastMode: queueFastMode(agent, message),
        subAgent: queueString(message, "agent"),
        executionAgent: queueString(message, "executionAgent") ?? queueString(message, "agent"),
        includeLocalSettings: queueBoolean(message, "includeLocalSettings"),
        promptSuggestions: queueBoolean(message, "promptSuggestions"),
        attachments,
        prompt: message.text,
        requestId: reservation.requestId,
        // Revalidated now, at dequeue: a selection whose binding changed while
        // queued fails with its reason instead of running something else.
        ...(parseNativeAgentCommandIntent(message.command)
          ? { command: parseNativeAgentCommandIntent(message.command) }
          : {}),
      });
      await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
      this.clearQueueBackoff(queueKey);
    } catch (error) {
      if (error instanceof PromptRejectedError) {
        await this.storage.failPromptQueueDispatch(queueKey, reservation.requestId, error.message, {
          requestIdRetired: error.requestIdRetired,
        });
        this.clearQueueBackoff(queueKey);
        return;
      }
      // Keep the in-flight record durable. The same request id is retried after
      // backoff, so an ambiguous provider response cannot become a second turn.
      // Handled here rather than rethrown so the attempt is counted once, with
      // the reservation id the latch needs.
      await this.deferQueue(
        queueKey,
        error instanceof Error ? error.name : "unknown dispatch error",
        reservation.requestId,
      );
    }
  }
}
