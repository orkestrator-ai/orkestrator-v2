/**
 * Continues a turn the model refused for capacity, with exponential backoff.
 *
 * The policy (what is retried, how long to wait, what is sent) is
 * `sessions/capacity-retry.ts`; this drives it against one thread. The turn
 * stays one turn throughout: the same `TurnAccumulator`, the same rows, the
 * same dispatch request id. Only the app-server turn behind it changes. So
 * the session reports `running` from the refusal until the last attempt ends,
 * `/dispatch` keeps answering `pending`, a workflow result submitted during a
 * continuation is credited to the original request, and nothing a workflow
 * polls ever reads an `error` that a retry is about to clear.
 *
 * Nothing here holds a lock while it waits. Each turn has its own timer;
 * Stop, a last-tab close, a restart and bridge shutdown each end the wait.
 */
import { stat } from "node:fs/promises";

import type { CodexRuntimeContext } from "./app-server-runtime-context.js";
import type { CodexRuntimeLifecycle } from "./app-server-runtime-lifecycle.js";
import type { EngineError, EngineGeneration, EngineTurnStatus } from "./engine/types.js";
import {
  CAPACITY_RETRY_CANCELLED_TEXT,
  CAPACITY_RETRY_START_FAILED_TEXT,
  DEFAULT_CAPACITY_RETRY_POLICY,
  capacityRetriesExhaustedError,
  capacityRetryClientId,
  capacityRetryContinuationText,
  capacityRetryDelayMs,
  capacityRetryItemId,
  capacityRetryStartedText,
  capacityRetryWaitingText,
  isModelCapacityError,
  type CapacityRetryPolicy,
} from "./sessions/capacity-retry.js";
import type { ThreadContext } from "./sessions/thread-registry.js";
import { unconfirmedTurnId, type TurnAccumulator } from "./sessions/turn-accumulator.js";

interface PendingCapacityRetry {
  /** The attempt the continuation will be. */
  attempt: number;
  itemId: string;
  /** The refusal that ended the previous attempt. */
  error: EngineError;
  stage: "waiting" | "starting";
  timer?: ReturnType<typeof setTimeout>;
  /** Stop arrived while `turn/start` was in flight. */
  stopAfterStart?: boolean;
}

export type CapacityFailureDecision = { retrying: true } | { retrying: false; error?: EngineError };

export class CodexCapacityRetry {
  private readonly pending = new Map<TurnAccumulator, PendingCapacityRetry>();

  constructor(
    private readonly ctx: CodexRuntimeContext,
    private readonly lifecycle: CodexRuntimeLifecycle,
  ) {}

  policy(): CapacityRetryPolicy {
    return { ...DEFAULT_CAPACITY_RETRY_POLICY, ...this.ctx.options.capacityRetry };
  }

  /** True while the turn is waiting for, or starting, a continuation. */
  isPending(turn: TurnAccumulator): boolean {
    return this.pending.has(turn);
  }

  /**
   * app-server failed the turn. Takes it over (`retrying: true`) when it was
   * a capacity refusal with attempts left; otherwise says which error the
   * turn ends with — the provider's, or that error saying retries ran out.
   *
   * Called from the notification path: schedules, never awaits.
   */
  onTurnFailed(
    context: ThreadContext,
    turn: TurnAccumulator,
    error: EngineError | undefined,
  ): CapacityFailureDecision {
    const plan = turn.capacityRetry;
    if (!plan || !turn.requestId || !isModelCapacityError(error)) return { retrying: false };
    const policy = this.policy();
    if (plan.attempt >= policy.maxAttempts) {
      return {
        retrying: false,
        ...(plan.attempt > 1 ? { error: capacityRetriesExhaustedError(error!, plan.attempt) } : {}),
      };
    }
    // A stop the user asked for, a shutdown or a restart in progress owns the
    // turn's ending; a retry would start work nobody wants.
    if (
      this.ctx.stopping ||
      turn.cancelRequested ||
      turn.stoppedByShutdown ||
      context.phase !== "running" ||
      context.bridgeSessionIds.size === 0
    ) {
      return { retrying: false };
    }

    const attempt = plan.attempt + 1;
    const delayMs = capacityRetryDelayMs(policy, attempt, this.ctx.options.capacityRetryRandom);
    const itemId = capacityRetryItemId(turn.requestId, attempt);
    turn.settleEndedAttempt();
    turn.recordRetryCard(
      itemId,
      capacityRetryWaitingText(delayMs, attempt, policy.maxAttempts),
      "pending",
    );
    const entry: PendingCapacityRetry = { attempt, itemId, error: error!, stage: "waiting" };
    entry.timer = setTimeout(() => this.fire(context, turn), delayMs);
    entry.timer.unref?.();
    this.pending.set(turn, entry);
    this.publish(context);
    return { retrying: true };
  }

  /**
   * Stop during a wait. Answers whether the retry owned the turn: if so the
   * wait is over and the turn ends interrupted, exactly as a stopped turn
   * does, and the caller must not interrupt an app-server turn that already
   * ended. A stop while the continuation is starting interrupts it once
   * app-server names it.
   */
  stop(context: ThreadContext, turn: TurnAccumulator): boolean {
    const entry = this.pending.get(turn);
    if (!entry) return false;
    turn.markCancelling();
    this.ctx.registry.setPhase(context, "cancelling");
    this.lifecycle.emitStatus(context);
    if (entry.stage === "starting") {
      entry.stopAfterStart = true;
      return true;
    }
    this.end(context, turn, "interrupted");
    return true;
  }

  /** A last-tab close: end the wait the way Stop does. */
  cancelForClose(context: ThreadContext, turn: TurnAccumulator): boolean {
    return this.stop(context, turn);
  }

  /**
   * The bridge's owner died (`interruptForParentExit`). A waiting turn ends
   * like a turn the restart stopped, so a workflow still continues it once.
   */
  endForParentExit(context: ThreadContext, turn: TurnAccumulator): boolean {
    const entry = this.pending.get(turn);
    if (!entry || entry.stage !== "waiting") return false;
    turn.stoppedByShutdown = true;
    this.clear(turn, entry, CAPACITY_RETRY_CANCELLED_TEXT);
    this.lifecycle.completeRecoveredTurn(turn, "interrupted");
    void this.lifecycle.runFinalization(context, turn);
    return true;
  }

  /**
   * Bridge shutdown: every wait ends now, and its turn fails with the
   * refusal it was retrying. Called before the child stops, so the
   * finalization still has a journal and a renderer.
   */
  dispose(): void {
    for (const [turn, entry] of Array.from(this.pending)) {
      if (entry.stage !== "waiting") continue;
      const context = this.ctx.registry.getThread(turn.threadId);
      if (!context || context.activeTurn !== turn) {
        this.clear(turn, entry, CAPACITY_RETRY_CANCELLED_TEXT);
        continue;
      }
      this.end(context, turn, "failed", entry.error, CAPACITY_RETRY_CANCELLED_TEXT);
    }
  }

  /**
   * Finalization of a turn, however it ended, retires its retry: a recovery
   * pass or a restart may settle a waiting turn without coming through here.
   */
  discard(turn: TurnAccumulator): void {
    const entry = this.pending.get(turn);
    if (entry) this.clear(turn, entry, CAPACITY_RETRY_CANCELLED_TEXT);
  }

  private fire(context: ThreadContext, turn: TurnAccumulator): void {
    const entry = this.pending.get(turn);
    if (!entry || entry.stage !== "waiting") return;
    entry.timer = undefined;
    if (!this.owns(context, turn)) {
      // Whatever settled the turn meanwhile also finalizes it; a turn still
      // registered but no longer continuable fails with its refusal.
      if (context.activeTurn === turn && !turn.isTerminal()) {
        this.end(context, turn, "failed", entry.error, CAPACITY_RETRY_CANCELLED_TEXT);
      } else this.clear(turn, entry, CAPACITY_RETRY_CANCELLED_TEXT);
      return;
    }
    entry.stage = "starting";
    const work = this.startContinuation(context, turn, entry).catch((error) => {
      console.error(
        `[codex-bridge] Capacity retry of turn ${turn.turnId} failed:`,
        error instanceof Error ? error.message : error,
      );
      if (this.pending.get(turn) === entry && context.activeTurn === turn && !turn.isTerminal()) {
        this.end(context, turn, "failed", entry.error, CAPACITY_RETRY_START_FAILED_TEXT);
      }
    });
    this.ctx.pendingFinalizations.add(work);
    void work.finally(() => this.ctx.pendingFinalizations.delete(work));
  }

  private owns(context: ThreadContext, turn: TurnAccumulator): boolean {
    return (
      !this.ctx.stopping &&
      this.ctx.registry.getThread(context.threadId) === context &&
      context.activeTurn === turn &&
      !turn.isTerminal() &&
      !turn.cancelRequested &&
      context.phase === "running" &&
      context.bridgeSessionIds.size > 0 &&
      turn.engineGeneration === this.ctx.options.engine.info().generation
    );
  }

  private async startContinuation(
    context: ThreadContext,
    turn: TurnAccumulator,
    entry: PendingCapacityRetry,
  ): Promise<void> {
    const plan = turn.capacityRetry!;
    const requestId = turn.requestId!;
    const policy = this.policy();
    const clientId = capacityRetryClientId(requestId, entry.attempt);
    const engine = this.ctx.options.engine;
    const previousTurnId = turn.turnId;
    // Park the continuation's notifications until `turn/start` names it:
    // against the ended turn's id they would be dropped as stale.
    turn.turnId = unconfirmedTurnId(clientId);

    // The refused-cell tail reads the continuation from the rollout's end.
    const path = engine.rolloutPath(context.threadId);
    const offset = path
      ? await stat(path).then(
          (stats) => stats.size,
          () => undefined,
        )
      : undefined;
    this.lifecycle.stateFor(context.threadId).refusedCellOffset = offset;

    let started: { turnId: string; engineGeneration: EngineGeneration } | undefined;
    let reconciledStatus: EngineTurnStatus | undefined;
    try {
      started = await engine.startTurn({
        handle: context.engineHandle,
        input: [
          { type: "text", text: capacityRetryContinuationText(entry.attempt, policy.maxAttempts) },
        ],
        config: plan.config,
        requestId: clientId,
        outputSchema: plan.outputSchema,
      });
    } catch (error) {
      const failure = engine.classifyFailure(error);
      // A start cut short by shutdown has nobody left to reconcile it.
      if (!this.ctx.stopping && failure.class !== "rejected" && !failure.retryImmediately) {
        // The write may have landed. Only `thread/read` can say.
        const outcome = await engine
          .reconcileRequest(context.threadId, clientId)
          .catch(() => undefined);
        if (outcome && outcome.result !== "absent" && outcome.turnId) {
          started = { turnId: outcome.turnId, engineGeneration: engine.info().generation };
          if (outcome.result === "terminal") reconciledStatus = outcome.status ?? "completed";
        } else if (!outcome) {
          // Unknown either way: hold the overlap guard like any ambiguous
          // dispatch; the backstop restarts the child if it never settles.
          this.clear(turn, entry, CAPACITY_RETRY_START_FAILED_TEXT);
          turn.error = entry.error;
          this.ctx.registry.setPhase(context, "recovering");
          this.lifecycle.emitStatus(context);
          this.ctx.callbacks.scheduleRecoveryBackstop(context);
          return;
        }
      }
      if (!started) {
        turn.turnId = previousTurnId;
        this.end(
          context,
          turn,
          entry.stopAfterStart ? "interrupted" : "failed",
          entry.error,
          CAPACITY_RETRY_START_FAILED_TEXT,
        );
        return;
      }
    }

    if (this.pending.get(turn) !== entry || context.activeTurn !== turn || turn.isTerminal()) {
      // Settled while `turn/start` was in flight (a restart's recovery): the
      // continuation is nobody's now, so stop it rather than let it run.
      await engine.interruptTurn(context.engineHandle, started.turnId).catch(() => undefined);
      return;
    }

    turn.turnId = started.turnId;
    turn.engineGeneration = started.engineGeneration;
    context.engineGeneration = started.engineGeneration;
    plan.attempt = entry.attempt;
    if (entry.stopAfterStart) this.clear(turn, entry, CAPACITY_RETRY_CANCELLED_TEXT);
    else {
      this.clear(
        turn,
        entry,
        capacityRetryStartedText(entry.attempt, policy.maxAttempts),
        "success",
      );
    }
    await this.ctx.journal
      .markAccepted(requestId, { threadId: context.threadId, turnId: started.turnId })
      .catch((error) =>
        console.warn(
          `[codex-bridge] Could not journal capacity retry of ${requestId}:`,
          error instanceof Error ? error.message : error,
        ),
      );
    if (plan.outputSchema) {
      const ledger = this.ctx.registry.recordStructuredOutputTurn(
        context.threadId,
        started.turnId,
        false,
      );
      await Promise.all(ledger.map((session) => this.ctx.callbacks.persistSession(session)));
    }
    this.publish(context);
    // Whatever app-server reported before its response, a fast continuation's
    // terminal event included.
    this.lifecycle.drainPendingEvents(context, started.turnId);
    if (reconciledStatus && context.activeTurn === turn && !turn.isTerminal()) {
      // It already ended and its terminal event was not among those parked.
      turn.complete(reconciledStatus);
      await this.lifecycle.runFinalization(context, turn);
      return;
    }
    if (entry.stopAfterStart && !turn.isTerminal()) {
      // The ordinary Stop, now that there is a turn to interrupt: it waits for
      // the terminal event and escalates if app-server never sends one.
      const sessionId = context.bridgeSessionIds.values().next().value;
      if (sessionId) await this.ctx.callbacks.abort(sessionId);
      else await engine.interruptTurn(context.engineHandle, started.turnId).catch(() => undefined);
    }
  }

  /** Ends the turn here; the ordinary finalization journals and publishes it. */
  private end(
    context: ThreadContext,
    turn: TurnAccumulator,
    status: EngineTurnStatus,
    error?: EngineError,
    cardText: string = CAPACITY_RETRY_CANCELLED_TEXT,
  ): void {
    const entry = this.pending.get(turn);
    if (entry) this.clear(turn, entry, cardText);
    if (status === "failed" && error) {
      turn.complete("failed", error);
      turn.recordProviderFailure(error);
    } else turn.complete(status);
    void this.lifecycle.runFinalization(context, turn);
  }

  private clear(
    turn: TurnAccumulator,
    entry: PendingCapacityRetry,
    cardText: string,
    state: "success" | "failure" = "failure",
  ): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    this.pending.delete(turn);
    if (turn.retryCardState(entry.itemId) === "pending") {
      turn.recordRetryCard(entry.itemId, cardText, state);
    }
  }

  private publish(context: ThreadContext): void {
    void this.lifecycle.stateFor(context.threadId).coalescer.flushNow();
    this.lifecycle.emitStatus(context);
  }
}
