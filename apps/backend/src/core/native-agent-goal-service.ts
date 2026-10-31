import { createHash, randomUUID } from "node:crypto";
import {
  boundedUtf8Head,
  goalContinuationRequestId,
  goalIsRunning,
  goalNeedsAttention,
  goalPublicView,
  isGoalContinuationRequestId,
  nextGoalState,
  NATIVE_AGENT_GOAL_LIMITS,
  parseGoalCommandArguments,
  renderGoalCarrier,
  sessionGoal,
  type GoalAction,
  type GoalCommand,
  type GoalEvent,
  type GoalReportStatus,
  type NativeAgentGoal,
  type NativeAgentGoalVerifier,
  type NativeAgentGoalVerifierRun,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import { PROMPT_QUEUE_MESSAGE_CONFLICT } from "./storage-prompts.js";
import type {
  AgentActivityState,
  PersistedNativeAgentSession,
} from "./native-agent-service-shared.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How often running goals are re-read when no edge wakes them. */
const GOAL_SWEEP_INTERVAL_MS = 5_000;

export interface GoalSessionAddress {
  environmentId: string;
  agent: BuildPipelineAgent;
  logicalSessionKey: string;
}

export type GoalCheckRun =
  | {
      kind: "finished";
      exitCode: number | null;
      timedOut: boolean;
      durationMs: number;
      outputTail: string;
    }
  | { kind: "unavailable"; detail: string }
  | { kind: "stopped" };

/** How a verifier session ended. `tokens` is what it spent, when its provider says. */
export type GoalVerifierRun =
  | { kind: "verdict"; passed: boolean; summary: string; reasons: string[]; tokens?: number }
  | { kind: "unavailable"; detail: string; tokens?: number }
  /** Its signal fired: the goal moved on, or the backend is stopping. */
  | { kind: "stopped"; tokens?: number };

export interface GoalVerifierRequest {
  environmentId: string;
  goalId: string;
  objective: string;
  check?: string;
  /** The agent's `done` message, as an unverified claim. */
  report?: string;
  verifier: NativeAgentGoalVerifier;
  signal: AbortSignal;
  /**
   * Makes the session's identity durable. Throws a {@link GoalVerifierFenceError}
   * when the goal is no longer waiting for this run.
   */
  saveRun(run: NativeAgentGoalVerifierRun): Promise<void>;
}

/** The environment-side work of a verifier (`native-agent-goal-verifier.ts`). */
export interface GoalVerifierHost {
  run(request: GoalVerifierRequest): Promise<GoalVerifierRun>;
  /** Stop a session an earlier process left running. Best-effort. */
  stopRun(input: {
    environmentId: string;
    goalId: string;
    run: NativeAgentGoalVerifierRun;
  }): Promise<void>;
  /** Why this agent cannot verify a goal; asked when one is set. */
  problem(agent: AgentPlatform): Promise<string | undefined>;
}

/** This process no longer owns the run. The name is what the branch runner reads. */
export class GoalVerifierFenceError extends Error {
  constructor(message = "The goal is no longer waiting for this verifier") {
    super(message);
    this.name = "GoalVerifierFenceError";
  }
}

/** The abort reason of a stopping backend: the next process deals with the session. */
export const GOAL_VERIFIER_BACKEND_STOPPING = "backend-stopping";

export interface NativeAgentGoalHost {
  storage: {
    getNativeAgentSession(key: string): Promise<PersistedNativeAgentSession | null | undefined>;
    listNativeAgentSessions(): Promise<PersistedNativeAgentSession[]>;
    updateNativeAgentGoal(
      key: string,
      update: (
        goal: NativeAgentGoal | undefined,
        session: PersistedNativeAgentSession,
      ) => NativeAgentGoal | null | undefined,
    ): Promise<PersistedNativeAgentSession | undefined>;
    enqueuePromptQueueMessageIfAbsent(
      queueKey: string,
      environmentId: string,
      message: unknown,
    ): Promise<{ status: "queued" | "present" | "consumed" }>;
    getPromptQueue?(queueKey: string): Promise<{
      dispatchError?: { messageId: string; requestId: string; message: string };
    } | null>;
    removePromptQueueMessage(queueKey: string, environmentId: string, id: string): Promise<unknown>;
  };
  now(): number;
  isStopped(): boolean;
  trackScan(task: Promise<void>): Promise<void>;
  requestOutcome(
    input: GoalSessionAddress & { requestId: string; expectedProviderSessionId: string },
  ): Promise<{
    outcome: "completed" | "failed" | "interrupted" | "superseded" | "pending" | "unknown";
    error?: string;
  }>;
  turnActivity(input: GoalSessionAddress): AgentActivityState | "unknown";
  stoppedMidTurn(input: GoalSessionAddress): boolean;
  environmentRunning(environmentId: string): Promise<boolean>;
  notifyQueue(queueKey: string): void;
  sessionTokens(input: GoalSessionAddress): Promise<number | undefined>;
  workspaceFingerprint(environmentId: string): Promise<string | undefined>;
  runCheck(input: {
    environmentId: string;
    goalId: string;
    command: string;
    timeoutMs: number;
    iteration: number;
    signal: AbortSignal;
  }): Promise<GoalCheckRun>;
  /** Absent: this backend cannot run verifiers, so a goal cannot ask for one. */
  verifier?: GoalVerifierHost;
  /** The goal changed: a view should read it again. */
  announce(session: PersistedNativeAgentSession): void;
  /** The loop stopped for a reason a person should see. */
  ringAttention(session: PersistedNativeAgentSession, goal: NativeAgentGoal): Promise<void>;
  /** The loop stopped: the turn-end work it was holding back can run. */
  releaseTurnEnd(session: PersistedNativeAgentSession): Promise<void>;
  /** Only an agent platform with this capability may hold a goal. */
  supportsGoals(agent: BuildPipelineAgent): boolean;
  /** Providers whose usage counters can back a token budget. */
  supportsTokenBudget(agent: BuildPipelineAgent): boolean;
}

export type GoalCommandResult = { message: string; goal?: NativeAgentGoalView };

export class GoalCommandError extends Error {}

/**
 * The goal id a durable request owns. Deriving it from the request lets a repeat
 * after a crash tell whether the first attempt got as far as setting the goal.
 */
export function goalIdForRequest(requestKey: string): string {
  return createHash("sha256").update("goal\0").update(requestKey).digest("hex").slice(0, 32);
}

function queueKeyOf(session: Pick<PersistedNativeAgentSession, "agent" | "logicalSessionKey">) {
  return `${session.agent}\0${session.logicalSessionKey}`;
}

function address(session: PersistedNativeAgentSession): GoalSessionAddress {
  return {
    environmentId: session.environmentId,
    agent: session.agent as BuildPipelineAgent,
    logicalSessionKey: session.logicalSessionKey,
  };
}

/**
 * Owns the goal loop (`plans/goals.md`): after each turn of a session with a
 * running goal it reads how the turn ended and sends the next one, runs the
 * check or the verifier, or stops.
 *
 * All durable state is on the session record. The maps here are an index, so a
 * session with no goal costs nothing on a turn edge, and they are rebuilt from
 * storage on `init`.
 */
export class NativeAgentGoalService {
  /** Sessions with a running goal. */
  private readonly running = new Map<string, string>();
  private readonly advancing = new Map<string, Promise<void>>();
  private readonly wakeAgain = new Set<string>();
  /** A running check stays in memory; after a restart it runs again. */
  private readonly checks = new Map<string, AbortController>();
  /**
   * Verifier work in flight. Unlike a check it does not hold `advance`, so the
   * sweep keeps watching the session and environment while a session runs.
   */
  private readonly verifiers = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private lastSweepAt = 0;

  constructor(private readonly host: NativeAgentGoalHost) {}

  /** Rebuild the index and pick up every goal a previous process left running. */
  async init(): Promise<void> {
    const sessions = await this.host.storage.listNativeAgentSessions();
    for (const session of sessions) {
      const goal = sessionGoal(session);
      if (goal && goalIsRunning(goal.status)) {
        this.running.set(session.key, goal.goalId);
        this.wake(session.key);
      } else if (goal?.verifierRun) {
        // A crash between leaving `verifying` and stopping the session.
        const { environmentId } = session;
        this.trackVerifier(session.key, () => this.endEarlierRun(session.key, environmentId, goal));
      }
    }
  }

  /** The backend is stopping: let go of verifiers without ending their goals. */
  stop(): void {
    for (const controller of this.checks.values()) controller.abort();
    for (const { controller } of this.verifiers.values()) {
      controller.abort(GOAL_VERIFIER_BACKEND_STOPPING);
    }
  }

  /** Whether a turn-end edge belongs to the loop rather than to the person. */
  holdsTurnEnd(sessionKey: string): boolean {
    return this.running.has(sessionKey);
  }

  noteTurnEnded(sessionKey: string): void {
    if (this.running.has(sessionKey)) this.wake(sessionKey);
  }

  /** Stop fences queued/startup carriers even before a provider reports work. */
  async userStop(sessionKey: string): Promise<void> {
    const session = await this.host.storage.getNativeAgentSession(sessionKey);
    const goal = session ? sessionGoal(session) : undefined;
    if (goal && goalIsRunning(goal.status))
      await this.apply(sessionKey, goal.goalId, { kind: "user-stop" });
  }

  /** Called from the activity sweep. Costs nothing with no running goal. */
  sweep(): void {
    if (this.running.size === 0) return;
    const now = this.host.now();
    if (now - this.lastSweepAt < GOAL_SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    for (const key of this.running.keys()) this.wake(key);
  }

  async settled(): Promise<void> {
    while (this.advancing.size > 0 || this.verifiers.size > 0) {
      await Promise.allSettled([
        ...this.advancing.values(),
        ...[...this.verifiers.values()].map((entry) => entry.task),
      ]);
    }
  }

  private wake(key: string): void {
    if (this.host.isStopped()) return;
    if (this.advancing.has(key)) {
      this.wakeAgain.add(key);
      return;
    }
    const task = this.advance(key)
      .catch((error: unknown) => {
        // The next sweep retries; a failure here must not stop other goals.
        console.warn("[goals] Failed to advance a goal:", errorMessage(error));
      })
      .finally(() => {
        this.advancing.delete(key);
        if (this.wakeAgain.delete(key)) this.wake(key);
      });
    this.advancing.set(key, task);
    void this.host.trackScan(task);
  }

  private async advance(key: string): Promise<void> {
    const session = await this.host.storage.getNativeAgentSession(key);
    const goal = session ? sessionGoal(session) : undefined;
    if (!session || !goal || !goalIsRunning(goal.status)) {
      this.running.delete(key);
      return;
    }
    this.running.set(key, goal.goalId);
    if (goal.providerSessionId !== session.providerSessionId) {
      await this.apply(key, goal.goalId, { kind: "session-replaced" });
      return;
    }
    if (!(await this.host.environmentRunning(session.environmentId))) {
      await this.apply(key, goal.goalId, { kind: "environment-stopped" });
      return;
    }
    if (goal.status === "checking") {
      await this.runCheck(key, session, goal);
      return;
    }
    if (goal.status === "verifying") {
      this.startVerifier(key, session, goal);
      return;
    }
    const queue = await this.host.storage.getPromptQueue?.(queueKeyOf(session));
    const requestId =
      goal.iterations > 0 ? goalContinuationRequestId(goal.goalId, goal.iterations - 1) : undefined;
    if (
      requestId &&
      (queue?.dispatchError?.messageId === requestId ||
        queue?.dispatchError?.requestId === requestId)
    ) {
      await this.apply(key, goal.goalId, {
        kind: "continuation-failed",
        detail: queue.dispatchError.message,
      });
      return;
    }
    const where = address(session);
    const activity = this.host.turnActivity(where);
    if (activity === "working" || activity === "waiting") return;
    if (this.host.stoppedMidTurn(where)) {
      await this.apply(key, goal.goalId, { kind: "runtime-stopped" });
      return;
    }
    const last = session.dispatchedRequestIds?.at(-1);
    if (last && last !== goal.evaluatedRequestId) {
      await this.evaluateTurn(key, session, goal, last);
      return;
    }
    await this.ensureContinuation(key, session, goal);
  }

  private async evaluateTurn(
    key: string,
    session: PersistedNativeAgentSession,
    goal: NativeAgentGoal,
    requestId: string,
  ): Promise<void> {
    const where = address(session);
    const answer = await this.host.requestOutcome({
      ...where,
      requestId,
      expectedProviderSessionId: session.providerSessionId,
    });
    // `pending`: a user's queued prompt or a late status read. The sweep looks
    // again, and a user's prompt runs first because the queue is FIFO.
    if (answer.outcome === "pending" || answer.outcome === "superseded") return;
    const continuation = isGoalContinuationRequestId(requestId);
    const completed = answer.outcome === "completed";
    const [tokens, fingerprint] = await Promise.all([
      completed ? this.host.sessionTokens(where).catch(() => undefined) : undefined,
      completed && continuation
        ? this.host.workspaceFingerprint(session.environmentId).catch(() => undefined)
        : undefined,
    ]);
    await this.apply(key, goal.goalId, {
      kind: "turn-ended",
      requestId,
      outcome: answer.outcome,
      ...(answer.error ? { error: answer.error } : {}),
      continuation,
      ...(tokens !== undefined && goal.tokensAtStart !== undefined
        ? { tokensUsed: Math.max(0, tokens - goal.tokensAtStart) + (goal.verifierTokens ?? 0) }
        : {}),
      ...(fingerprint !== undefined ? { workspaceFingerprint: fingerprint } : {}),
    });
  }

  /**
   * Apply an event, then do what it asks. The next continuation's iteration is
   * written first and its id derives from that number, so a crash on either
   * side of the enqueue re-sends the same id, which the queue deduplicates.
   */
  private async apply(key: string, goalId: string, event: GoalEvent): Promise<void> {
    if (this.host.isStopped()) return;
    const change: { action: GoalAction; previous?: NativeAgentGoal } = { action: "none" };
    const session = await this.host.storage.updateNativeAgentGoal(key, (current, durable) => {
      if (this.host.isStopped() || !current || current.goalId !== goalId) return undefined;
      const continuationPending =
        event.kind === "turn-ended" &&
        !event.continuation &&
        current.iterations > 0 &&
        !durable.dispatchedRequestIds?.includes(
          goalContinuationRequestId(current.goalId, current.iterations - 1),
        );
      const transition = nextGoalState(
        current,
        event.kind === "turn-ended" ? { ...event, continuationPending } : event,
        this.host.now(),
      );
      if (transition.goal === current) return undefined;
      change.previous = current;
      change.action = transition.action;
      if (transition.action !== "send-continuation") return transition.goal;
      return nextGoalState(transition.goal, { kind: "continuation-sent" }, this.host.now()).goal;
    });
    const goal = session ? sessionGoal(session) : undefined;
    if (!session || !goal || goal.goalId !== goalId || !change.previous) return;
    await this.afterChange(key, session, goal, change.previous);
    if (change.action === "send-continuation") await this.sendContinuation(key, session, goal);
    if (change.action === "run-check" || change.action === "run-verifier") this.wake(key);
  }

  private async afterChange(
    key: string,
    session: PersistedNativeAgentSession,
    goal: NativeAgentGoal,
    previous: NativeAgentGoal | undefined,
  ): Promise<void> {
    this.host.announce(session);
    if (previous?.status === "checking" && goal.status !== "checking")
      this.checks.get(key)?.abort();
    // Whatever moved the goal on, nobody is waiting for its verifier now.
    if (previous?.status === "verifying" && goal.status !== "verifying") {
      this.verifiers.get(key)?.controller.abort();
    }
    if (goalIsRunning(goal.status)) {
      this.running.set(key, goal.goalId);
      return;
    }
    this.running.delete(key);
    await this.removeQueuedContinuation(session, goal);
    if (previous && !goalIsRunning(previous.status)) return;
    if (goalNeedsAttention(goal)) {
      await this.host.ringAttention(session, goal).catch((error: unknown) => {
        console.warn("[goals] Failed to record attention:", errorMessage(error));
      });
    }
    await this.host.releaseTurnEnd(session).catch((error: unknown) => {
      console.warn("[goals] Failed to settle turn-end work:", errorMessage(error));
    });
  }

  private async sendContinuation(
    key: string,
    session: PersistedNativeAgentSession,
    goal: NativeAgentGoal,
  ): Promise<void> {
    if (this.host.isStopped()) return;
    // `iterations` already counts this send.
    const iteration = goal.iterations - 1;
    const requestId = goalContinuationRequestId(goal.goalId, iteration);
    const queueKey = queueKeyOf(session);
    let status: "queued" | "present" | "consumed";
    try {
      ({ status } = await this.host.storage.enqueuePromptQueueMessageIfAbsent(
        queueKey,
        session.environmentId,
        {
          id: requestId,
          requestId,
          text: renderGoalCarrier({ ...goal, iterations: iteration }),
          // A carrier is literal text: never a provider slash command.
          command: { kind: "literal" },
          preserveSessionMode: true,
          origin: { kind: "goal", goalId: goal.goalId, iteration },
        },
      ));
    } catch (error) {
      // The id is the identity: a resend whose text differs is still this turn.
      if (!errorMessage(error).startsWith(PROMPT_QUEUE_MESSAGE_CONFLICT)) throw error;
      status = "present";
    }
    if (status === "consumed") {
      const current = await this.host.storage.getNativeAgentSession(key);
      const currentGoal = current ? sessionGoal(current) : undefined;
      if (
        currentGoal?.goalId !== goal.goalId ||
        currentGoal.status !== "active" ||
        currentGoal.iterations !== goal.iterations
      )
        return;
      const dispatched =
        current?.dispatchedRequestIds?.includes(requestId) ||
        current?.pendingDispatch?.requestId === requestId;
      // Consumed without a dispatch means a person took it out of the queue.
      if (!dispatched) {
        await this.apply(key, goal.goalId, { kind: "user-pause" });
      }
      return;
    }
    this.host.notifyQueue(queueKey);
  }

  /** Nothing new ran since the last evaluation: make sure the next turn is on its way. */
  private async ensureContinuation(
    key: string,
    session: PersistedNativeAgentSession,
    goal: NativeAgentGoal,
  ): Promise<void> {
    if (session.pendingDispatch || session.pendingSteer) return;
    if (goal.iterations === 0) {
      const updated = await this.host.storage.updateNativeAgentGoal(key, (current) =>
        current?.goalId === goal.goalId && current.iterations === 0
          ? nextGoalState(current, { kind: "continuation-sent" }, this.host.now()).goal
          : undefined,
      );
      const started = updated ? sessionGoal(updated) : undefined;
      if (updated && started?.goalId === goal.goalId) {
        this.host.announce(updated);
        await this.sendContinuation(key, updated, started);
      }
      return;
    }
    const requestId = goalContinuationRequestId(goal.goalId, goal.iterations - 1);
    if (session.dispatchedRequestIds?.includes(requestId)) return;
    await this.sendContinuation(key, session, goal);
  }

  private async runCheck(
    key: string,
    session: PersistedNativeAgentSession,
    goal: NativeAgentGoal,
  ): Promise<void> {
    if (this.host.isStopped() || this.checks.has(key)) return;
    if (!goal.check) {
      await this.apply(key, goal.goalId, {
        kind: "check-unavailable",
        detail: "The goal has no check command.",
      });
      return;
    }
    const controller = new AbortController();
    this.checks.set(key, controller);
    try {
      const run = await this.host.runCheck({
        environmentId: session.environmentId,
        goalId: goal.goalId,
        command: goal.check,
        timeoutMs: NATIVE_AGENT_GOAL_LIMITS.checkTimeoutDefaultMs,
        iteration: goal.iterations,
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.host.isStopped() || run.kind === "stopped") return;
      if (run.kind === "unavailable") {
        await this.apply(key, goal.goalId, { kind: "check-unavailable", detail: run.detail });
        return;
      }
      if (run.timedOut) {
        await this.apply(key, goal.goalId, {
          kind: "check-unavailable",
          detail: `The check timed out after ${Math.round(run.durationMs / 1000)} seconds.`,
        });
        return;
      }
      await this.apply(key, goal.goalId, {
        kind: "check-finished",
        result: {
          passed: run.exitCode === 0,
          exitCode: run.exitCode,
          durationMs: run.durationMs,
          outputTail: run.outputTail,
          at: new Date(this.host.now()).toISOString(),
        },
      });
    } catch (error) {
      if (controller.signal.aborted || this.host.isStopped()) return;
      await this.apply(key, goal.goalId, {
        kind: "check-unavailable",
        detail: errorMessage(error),
      });
    } finally {
      this.checks.delete(key);
    }
  }

  private trackVerifier(key: string, work: (signal: AbortSignal) => Promise<void>): void {
    if (this.verifiers.has(key)) return;
    const controller = new AbortController();
    const task = work(controller.signal)
      .catch((error: unknown) => {
        // The goal is still `verifying`, so the next sweep runs it again.
        console.warn("[goals] A verifier failed to finish:", errorMessage(error));
      })
      .finally(() => {
        this.verifiers.delete(key);
        // A goal that came back to `verifying` while this one stopped starts now.
        if (this.running.has(key)) this.wake(key);
      });
    this.verifiers.set(key, { controller, task });
    void this.host.trackScan(task);
  }

  private startVerifier(
    key: string,
    session: PersistedNativeAgentSession,
    goal: NativeAgentGoal,
  ): void {
    this.trackVerifier(key, (signal) => this.runVerifier(key, session, goal, signal));
  }

  /** Stop the session a `verifierRun` names and count what it spent. */
  private async endEarlierRun(
    key: string,
    environmentId: string,
    goal: NativeAgentGoal,
  ): Promise<void> {
    if (!goal.verifierRun) return;
    await this.host.verifier?.stopRun({
      environmentId,
      goalId: goal.goalId,
      run: goal.verifierRun,
    });
    await this.apply(key, goal.goalId, { kind: "verifier-run-ended" });
  }

  private async runVerifier(
    key: string,
    session: PersistedNativeAgentSession,
    goal: NativeAgentGoal,
    signal: AbortSignal,
  ): Promise<void> {
    const { goalId } = goal;
    const host = this.host.verifier;
    if (!host || !goal.verifier) {
      await this.apply(key, goalId, {
        kind: "verifier-unavailable",
        detail: host ? "The goal has no verifier." : "This backend cannot run verifiers.",
      });
      return;
    }
    await this.endEarlierRun(key, session.environmentId, goal);
    if (signal.aborted) return;
    let run: GoalVerifierRun;
    try {
      run = await host.run({
        environmentId: session.environmentId,
        goalId,
        objective: goal.objective,
        ...(goal.check ? { check: goal.check } : {}),
        ...(goal.lastReport ? { report: goal.lastReport.message } : {}),
        verifier: goal.verifier,
        signal,
        saveRun: (verifierRun) => this.saveVerifierRun(key, goalId, verifierRun),
      });
    } catch (error) {
      run = { kind: "unavailable", detail: errorMessage(error) };
    }
    // A stopping backend keeps the durable run: the next process counts it.
    if (signal.reason === GOAL_VERIFIER_BACKEND_STOPPING) return;
    const tokens = run.tokens !== undefined ? { tokens: run.tokens } : {};
    if (signal.aborted || run.kind === "stopped") {
      await this.apply(key, goalId, { kind: "verifier-run-ended", ...tokens });
      return;
    }
    if (run.kind === "unavailable") {
      await this.apply(key, goalId, {
        kind: "verifier-unavailable",
        detail: run.detail,
        ...tokens,
      });
      return;
    }
    await this.apply(key, goalId, {
      kind: "verifier-finished",
      verdict: {
        passed: run.passed,
        summary: run.summary,
        ...(run.reasons.length > 0 ? { reasons: run.reasons } : {}),
        agent: goal.verifier.agent,
        ...(goal.verifier.model ? { model: goal.verifier.model } : {}),
        ...tokens,
        at: new Date(this.host.now()).toISOString(),
      },
    });
  }

  private async saveVerifierRun(
    key: string,
    goalId: string,
    verifierRun: NativeAgentGoalVerifierRun,
  ): Promise<void> {
    const updated = await this.host.storage.updateNativeAgentGoal(key, (current) =>
      current?.goalId === goalId && current.status === "verifying"
        ? { ...current, verifierRun }
        : undefined,
    );
    const saved = updated ? sessionGoal(updated) : undefined;
    if (saved?.goalId !== goalId || saved.status !== "verifying") {
      throw new GoalVerifierFenceError();
    }
  }

  private async removeQueuedContinuation(
    session: PersistedNativeAgentSession,
    goal: NativeAgentGoal,
  ): Promise<void> {
    if (goal.iterations === 0) return;
    await this.host.storage
      .removePromptQueueMessage(
        queueKeyOf(session),
        session.environmentId,
        goalContinuationRequestId(goal.goalId, goal.iterations - 1),
      )
      .catch(() => {
        // Already dispatched or gone. A turn that still runs is not evaluated,
        // because the goal is no longer running.
      });
  }

  /** `report_goal`: record what the agent says; the loop acts at the turn's end. */
  async report(
    scope: { environmentId: string; tabId?: string },
    input: { goalId: string; status: GoalReportStatus; message: string },
  ): Promise<{ ok: boolean; message: string }> {
    const key = this.sessionKeyForGoal(input.goalId);
    const session = key ? await this.host.storage.getNativeAgentSession(key) : undefined;
    const goal = session ? sessionGoal(session) : undefined;
    const owned =
      session &&
      session.environmentId === scope.environmentId &&
      (!scope.tabId || session.logicalSessionKey === `env-${scope.environmentId}:${scope.tabId}`);
    if (!key || !session || !goal || goal.goalId !== input.goalId || !owned) {
      return { ok: false, message: "No active goal has that goalId in this session." };
    }
    const report = {
      status: input.status,
      message: boundedUtf8Head(input.message, NATIVE_AGENT_GOAL_LIMITS.reportMessageMaxBytes),
      at: new Date(this.host.now()).toISOString(),
    };
    const updated = await this.host.storage.updateNativeAgentGoal(key, (current) => {
      if (!current || current.goalId !== input.goalId) return undefined;
      const next = nextGoalState(current, { kind: "report", report }, this.host.now()).goal;
      return next === current ? undefined : next;
    });
    if (updated) this.host.announce(updated);
    const guidance =
      input.status === "done"
        ? goal.check
          ? "Recorded. End your turn now; Orkestrator will run the check."
          : goal.verifier
            ? "Recorded. End your turn now; a separate verifier will judge the work."
            : "Recorded. End your turn now; the goal will end as unverified."
        : input.status === "blocked"
          ? "Recorded. End your turn now; the goal will wait for a person."
          : "Recorded. Keep working.";
    return { ok: true, message: guidance };
  }

  private sessionKeyForGoal(goalId: string): string | undefined {
    for (const [key, id] of this.running) if (id === goalId) return key;
    return undefined;
  }

  /** The goal a client may read in full, including the check's output. */
  async detail(key: string): Promise<{
    goal?: NativeAgentGoal;
    history: NativeAgentGoal[];
  }> {
    const session = await this.host.storage.getNativeAgentSession(key);
    const goal = session ? sessionGoal(session) : undefined;
    return {
      ...(goal ? { goal } : {}),
      history: session?.goalHistory ?? [],
    };
  }

  /** Run `/goal` for one session. Throws {@link GoalCommandError} on a refusal. */
  async command(
    session: PersistedNativeAgentSession,
    text: string,
    options: { busy: boolean },
  ): Promise<GoalCommandResult> {
    return this.perform(session, parseGoalCommandArguments(text), options);
  }

  async perform(
    session: PersistedNativeAgentSession,
    command: GoalCommand,
    options: { busy: boolean },
  ): Promise<GoalCommandResult> {
    const agent = session.agent as BuildPipelineAgent;
    if (!this.host.supportsGoals(agent)) {
      throw new GoalCommandError("Goals are not available for this agent yet.");
    }
    if (!session.logicalSessionKey.startsWith(`env-${session.environmentId}:`)) {
      throw new GoalCommandError("Goals work in an environment's agent tabs only.");
    }
    if (session.owner?.kind === "coordinator") {
      throw new GoalCommandError("Goals work in an environment's agent tabs only.");
    }
    const key = session.key;
    switch (command.kind) {
      case "error":
        throw new GoalCommandError(command.message);
      case "status": {
        const goal = sessionGoal(session);
        if (!goal) return { message: "No goal is set." };
        return { message: goal.objective, goal: goalPublicView(goal) };
      }
      case "pause": {
        const goal = sessionGoal(session);
        if (!goal || !goalIsRunning(goal.status)) {
          throw new GoalCommandError("No running goal to pause.");
        }
        await this.apply(key, goal.goalId, { kind: "user-pause" });
        return { message: "Goal paused.", ...(await this.viewOf(key)) };
      }
      case "resume": {
        const goal = sessionGoal(session);
        if (!goal || goalIsRunning(goal.status)) {
          throw new GoalCommandError("No paused goal to resume.");
        }
        if (goal.status === "claimed" || goal.status === "complete") {
          throw new GoalCommandError("That goal has ended. Set a new one.");
        }
        if (command.tokenBudget !== undefined && !this.host.supportsTokenBudget(agent)) {
          throw new GoalCommandError(
            "This agent does not report usage, so it can't take a budget.",
          );
        }
        if (
          command.tokenBudget !== undefined &&
          goal.verifier &&
          !this.host.supportsTokenBudget(goal.verifier.agent)
        ) {
          throw new GoalCommandError(
            "This goal's verifier does not report usage, so it can't take a budget.",
          );
        }
        // A goal that moved to a different conversation binds to the current one.
        if (goal.providerSessionId !== session.providerSessionId) {
          await this.host.storage.updateNativeAgentGoal(key, (current) =>
            current?.goalId === goal.goalId
              ? { ...current, providerSessionId: session.providerSessionId }
              : undefined,
          );
        }
        await this.apply(key, goal.goalId, {
          kind: "user-resume",
          ...(command.maxIterations !== undefined ? { maxIterations: command.maxIterations } : {}),
          ...(command.tokenBudget !== undefined ? { tokenBudget: command.tokenBudget } : {}),
        });
        const after = await this.viewOf(key);
        if (after.goal && !goalIsRunning(after.goal.status)) {
          throw new GoalCommandError(
            after.goal.status === "limited"
              ? "That goal is still at its limit. Resume it with a higher --max-iterations or --budget."
              : "The goal could not resume.",
          );
        }
        return { message: "Goal resumed.", ...after };
      }
      case "clear": {
        const goal = sessionGoal(session);
        if (!goal) return { message: "No goal is set." };
        const updated = await this.host.storage.updateNativeAgentGoal(key, (current) =>
          current?.goalId === goal.goalId ? null : undefined,
        );
        if (updated) {
          this.running.delete(key);
          this.verifiers.get(key)?.controller.abort();
          this.checks.get(key)?.abort();
          await this.removeQueuedContinuation(session, goal);
          this.host.announce(updated);
          if (goalIsRunning(goal.status)) await this.host.releaseTurnEnd(updated).catch(() => {});
        }
        return { message: "Goal cleared." };
      }
      case "set": {
        const existing = sessionGoal(session);
        // The same durable request again: it already set this goal, whatever
        // has happened to the goal since.
        const repeated =
          command.goalId === undefined
            ? undefined
            : existing?.goalId === command.goalId
              ? existing
              : session.goalHistory?.find((past) => past.goalId === command.goalId);
        if (repeated) return { message: "Goal set.", goal: goalPublicView(repeated) };
        if (existing && goalIsRunning(existing.status)) {
          throw new GoalCommandError(
            "A goal is already running. Run /goal clear first to replace it.",
          );
        }
        if (command.tokenBudget !== undefined && !this.host.supportsTokenBudget(agent)) {
          throw new GoalCommandError(
            "This agent does not report usage, so it can't take a budget.",
          );
        }
        if (command.verifier) {
          if (!this.host.verifier) {
            throw new GoalCommandError("This backend cannot run verifiers.");
          }
          const problem = await this.host.verifier.problem(command.verifier.agent);
          if (problem) throw new GoalCommandError(problem);
          if (
            command.tokenBudget !== undefined &&
            !this.host.supportsTokenBudget(command.verifier.agent)
          ) {
            throw new GoalCommandError(
              "That verifier does not report usage, so the goal can't take a budget.",
            );
          }
        }
        const tokens = await this.host.sessionTokens(address(session)).catch(() => undefined);
        const now = new Date(this.host.now()).toISOString();
        const last = session.dispatchedRequestIds?.at(-1);
        const goal: NativeAgentGoal = {
          goalId: command.goalId ?? randomUUID(),
          objective: command.objective,
          ...(command.check ? { check: command.check } : {}),
          ...(command.verifier ? { verifier: command.verifier } : {}),
          status: "active",
          providerSessionId: session.providerSessionId,
          iterations: 0,
          maxIterations: command.maxIterations,
          ...(command.tokenBudget !== undefined ? { tokenBudget: command.tokenBudget } : {}),
          tokensAtStart: tokens ?? 0,
          noProgressStreak: 0,
          // While idle, everything already dispatched predates the goal. While
          // a turn runs, the first evaluation happens at that turn's end.
          ...(!options.busy && last ? { evaluatedRequestId: last } : {}),
          setAt: now,
          updatedAt: now,
        };
        const updated = await this.host.storage.updateNativeAgentGoal(key, (current) =>
          current && (goalIsRunning(current.status) || current.goalId === goal.goalId)
            ? undefined
            : goal,
        );
        const saved = updated ? sessionGoal(updated) : undefined;
        if (!updated || saved?.goalId !== goal.goalId) {
          throw new GoalCommandError(
            "A goal is already running. Run /goal clear first to replace it.",
          );
        }
        this.running.set(key, goal.goalId);
        this.host.announce(updated);
        this.wake(key);
        return { message: "Goal set.", goal: goalPublicView(saved) };
      }
    }
  }

  private async viewOf(key: string): Promise<{ goal?: NativeAgentGoalView }> {
    const session = await this.host.storage.getNativeAgentSession(key);
    const goal = session ? sessionGoal(session) : undefined;
    return goal ? { goal: goalPublicView(goal) } : {};
  }
}
