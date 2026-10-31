import { randomUUID } from "node:crypto";
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
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
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
  | { kind: "unavailable"; detail: string };

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
      fingerprint?: string,
    ): Promise<{ status: "queued" | "present" | "consumed" }>;
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
  }): Promise<GoalCheckRun>;
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
 * check, or stops.
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
  private readonly checks = new Set<string>();
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
      }
    }
  }

  /** Whether a turn-end edge belongs to the loop rather than to the person. */
  holdsTurnEnd(sessionKey: string): boolean {
    return this.running.has(sessionKey);
  }

  noteTurnEnded(sessionKey: string): void {
    if (this.running.has(sessionKey)) this.wake(sessionKey);
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
    while (this.advancing.size > 0) await Promise.allSettled([...this.advancing.values()]);
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
        ? { tokensUsed: Math.max(0, tokens - goal.tokensAtStart) }
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
    const change: { action: GoalAction; previous?: NativeAgentGoal } = { action: "none" };
    const session = await this.host.storage.updateNativeAgentGoal(key, (current) => {
      if (!current || current.goalId !== goalId) return undefined;
      const transition = nextGoalState(current, event, this.host.now());
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
    if (change.action === "run-check") this.wake(key);
  }

  private async afterChange(
    key: string,
    session: PersistedNativeAgentSession,
    goal: NativeAgentGoal,
    previous: NativeAgentGoal | undefined,
  ): Promise<void> {
    this.host.announce(session);
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
    // `iterations` already counts this send.
    const iteration = goal.iterations - 1;
    const requestId = goalContinuationRequestId(goal.goalId, iteration);
    const queueKey = queueKeyOf(session);
    const { status } = await this.host.storage.enqueuePromptQueueMessageIfAbsent(
      queueKey,
      session.environmentId,
      {
        id: requestId,
        requestId,
        text: renderGoalCarrier({ ...goal, iterations: iteration }),
        // A carrier is literal text: never a provider slash command.
        command: { kind: "literal" },
        origin: { kind: "goal", goalId: goal.goalId, iteration },
      },
      // The id is the identity. A resend after a crash may render other text.
      requestId,
    );
    if (status === "consumed") {
      const dispatched =
        session.dispatchedRequestIds?.includes(requestId) ||
        session.pendingDispatch?.requestId === requestId;
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
    if (this.checks.has(key)) return;
    if (!goal.check) {
      await this.apply(key, goal.goalId, {
        kind: "check-unavailable",
        detail: "The goal has no check command.",
      });
      return;
    }
    this.checks.add(key);
    try {
      const run = await this.host.runCheck({
        environmentId: session.environmentId,
        goalId: goal.goalId,
        command: goal.check,
        timeoutMs: NATIVE_AGENT_GOAL_LIMITS.checkTimeoutDefaultMs,
      });
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
      await this.apply(key, goal.goalId, {
        kind: "check-unavailable",
        detail: errorMessage(error),
      });
    } finally {
      this.checks.delete(key);
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
          await this.removeQueuedContinuation(session, goal);
          this.host.announce(updated);
          if (goalIsRunning(goal.status)) await this.host.releaseTurnEnd(updated).catch(() => {});
        }
        return { message: "Goal cleared." };
      }
      case "set": {
        const existing = sessionGoal(session);
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
        const tokens = await this.host.sessionTokens(address(session)).catch(() => undefined);
        const now = new Date(this.host.now()).toISOString();
        const last = session.dispatchedRequestIds?.at(-1);
        const goal: NativeAgentGoal = {
          goalId: randomUUID(),
          objective: command.objective,
          ...(command.check ? { check: command.check } : {}),
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
          current && goalIsRunning(current.status) ? undefined : goal,
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
