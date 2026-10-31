import {
  goalIsRunning,
  goalIsTerminal,
  goalPublicView,
  goalResumeCommand,
  goalSetCommand,
  goalStatusSummary,
  GOAL_TOKEN_BUDGET_PLATFORMS,
  describeGoalStatus,
  sessionGoal,
  type GoalCommand,
  type NativeAgentGoal,
  type NativeAgentGoalVerifier,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { publicActionNestedKeys } from "@orkestrator/protocol/public-api-inputs";
import {
  decodePublicSessionId,
  nativeTabLogicalSessionKey,
  type PublicGoalMutationResult,
  type PublicSessionGoal,
} from "@orkestrator/protocol/public-api-resources";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { GoalCommandError, goalIdForRequest } from "../native-agent-goal-service.js";
import { nativeAgentSessionStorageKey } from "../native-agent-service-shared.js";
import { assertReadyForAgents } from "./actions-sessions.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  onlyActionKeys,
  onlyKeys,
  optionalBoolean,
  optionalInteger,
  sessionTarget,
} from "./input.js";
import { registerReconciler } from "./reconciler.js";
import { resolveSession, sessionActivity, type ResolvedSession } from "./sessions.js";
import type {
  ExecuteOutcome,
  MutationActionHandler,
  OperationHandle,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * A goal through the public API: the same service and rules as `/goal`, from
 * structured fields, so an objective is never re-parsed for flags.
 *
 * Receipts carry the goal's ID, status and counts only. The objective, the check
 * command and the agent's reports are read with `session.goal.get`.
 */

interface SessionTarget {
  sessionId: string;
  environmentId: string;
  tabId: string;
}

function refusal(command: GoalCommand): PublicActionError | undefined {
  return command.kind === "error" ? invalid(command.message) : undefined;
}

function requireGoalsAvailable(session: ResolvedSession): void {
  if (nativeAgentCapabilities(session.agent).actions?.goal !== true) {
    throw new PublicActionError(
      "capability-unavailable",
      `Goals are not available for ${session.agent} yet`,
    );
  }
  // D3: graph, pipeline and coordinator sessions run their own loops.
  const owner = session.record?.owner;
  if (owner && owner.kind !== "environment") {
    throw new PublicActionError("unsupported", "Goals work in an environment's agent tabs only");
  }
}

function requireProviderSession(session: ResolvedSession): void {
  if (!session.record) {
    throw new PublicActionError("not-ready", "The session has no provider conversation yet");
  }
}

function requireTokenBudgetSupport(session: ResolvedSession, tokenBudget: number | undefined) {
  if (
    tokenBudget !== undefined &&
    !(GOAL_TOKEN_BUDGET_PLATFORMS as readonly string[]).includes(session.agent)
  ) {
    throw new PublicActionError(
      "capability-unavailable",
      `${session.agent} does not report usage, so it can't take a budget`,
    );
  }
}

function resources(session: ResolvedSession) {
  return {
    environmentId: session.environment.id,
    projectId: session.environment.projectId,
    sessionId: session.sessionId,
    tabId: session.tab.tabId,
  };
}

function currentGoal(session: ResolvedSession): NativeAgentGoal | undefined {
  return session.record ? sessionGoal(session.record) : undefined;
}

function conflict(message: string, goal?: NativeAgentGoal): PublicActionError {
  return new PublicActionError(
    "conflict",
    message,
    goal ? { details: { goalId: goal.goalId, status: goal.status } } : {},
  );
}

/** Run one goal command; a refusal that raced admission fails the operation. */
async function perform(
  context: PublicActionContext,
  session: ResolvedSession,
  command: GoalCommand,
): Promise<ExecuteOutcome> {
  const native = context.command.nativeAgents;
  if (!native) {
    throw new PublicActionError("capability-unavailable", "Native agents are unavailable");
  }
  try {
    const { goal } = await native.performGoalCommand({
      environmentId: session.environment.id,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
      command,
    });
    return { state: "succeeded", result: mutationResult(session.sessionId, goal) };
  } catch (error) {
    if (!(error instanceof GoalCommandError)) throw error;
    return { state: "failed", error: { code: "conflict", message: error.message } };
  }
}

function mutationResult(
  sessionId: string,
  goal: NativeAgentGoalView | undefined,
): Record<string, unknown> & PublicGoalMutationResult {
  return { sessionId, goal: goal ? goalStatusSummary(goal) : null };
}

function parseVerifierInput(value: unknown): NativeAgentGoalVerifier | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("verifier must be an object");
  }
  const fields = value as Record<string, unknown>;
  onlyKeys(fields, publicActionNestedKeys("session.goal.set", "verifier"));
  // `goalSetCommand` judges the values; this only keeps the shape it takes.
  return fields as unknown as NativeAgentGoalVerifier;
}

interface SetInput extends SessionTarget {
  command: Extract<GoalCommand, { kind: "set" }>;
}

const goalSet: MutationActionHandler<SetInput> = {
  kind: "mutation",
  action: "session.goal.set",
  parse(input) {
    onlyActionKeys(input, "session.goal.set");
    const target = sessionTarget(input);
    if (typeof input.objective !== "string") throw invalid("objective is required");
    if (input.check !== undefined && typeof input.check !== "string") {
      throw invalid("check must be a string");
    }
    const maxIterations = optionalInteger(input, "maxIterations", 1, Number.MAX_SAFE_INTEGER);
    const tokenBudget = optionalInteger(input, "tokenBudget", 1, Number.MAX_SAFE_INTEGER);
    const verifier = parseVerifierInput(input.verifier);
    const command = goalSetCommand({
      objective: input.objective,
      ...(input.check !== undefined ? { check: input.check } : {}),
      ...(verifier ? { verifier } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    });
    const problem = refusal(command);
    if (problem) throw problem;
    const set = command as SetInput["command"];
    return {
      value: { ...target, command: set },
      scope: `session:${target.sessionId}`,
      // The caller's request, not the defaults: a later default keeps replaying.
      intent: {
        objective: set.objective,
        check: set.check ?? null,
        maxIterations: maxIterations ?? null,
        tokenBudget: tokenBudget ?? null,
        // Absent when unset, so earlier fingerprints still match.
        ...(verifier ? { verifier } : {}),
      },
    };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    assertReadyForAgents(session.environment);
    requireGoalsAvailable(session);
    requireProviderSession(session);
    requireTokenBudgetSupport(session, input.command.tokenBudget);
    // The loop waits behind a parked dispatch, and nothing would say why.
    const parked = session.record?.pendingDispatch ?? session.record?.pendingSteer;
    if (parked) {
      throw new PublicActionError(
        "dispatch-parked",
        "An earlier message is awaiting confirmation; `run retry` or `run discard` it first",
        { details: { requestId: parked.requestId } },
      );
    }
    const existing = currentGoal(session);
    if (existing && goalIsRunning(existing.status)) {
      throw conflict("A goal is already running; clear it first to replace it", existing);
    }
    return {
      resolved: { agent: session.agent, maxIterations: input.command.maxIterations },
      resources: resources(session),
      execute: (operation: OperationHandle) =>
        perform(context, session, {
          ...input.command,
          goalId: goalIdForRequest(operation.operationId),
        }),
    };
  },
};

const goalGet: ReadActionHandler<SessionTarget & { includeCheckOutput: boolean }> = {
  kind: "read",
  action: "session.goal.get",
  parse(input) {
    onlyActionKeys(input, "session.goal.get");
    return {
      ...sessionTarget(input),
      includeCheckOutput: optionalBoolean(input, "includeCheckOutput") === true,
    };
  },
  async run(input, context) {
    const session = await resolveSession(context, input);
    const goal = currentGoal(session);
    const activity = sessionActivity(context, {
      environmentId: session.environment.id,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
    });
    const projection = context.command.nativeAgents?.cachedProjectionSnapshot(
      session.environment.id,
      session.agent,
      session.logicalSessionKey,
    );
    const result: PublicSessionGoal = {
      sessionId: session.sessionId,
      agent: session.agent,
      activity,
      pendingInteractionCount: projection
        ? projection.interactions.filter(
            (interaction) => interaction.state === "pending" || interaction.state === "answering",
          ).length
        : null,
      goal: goal ? goalPublicView(goal) : null,
      description: goal ? describeGoalStatus(goal) : null,
      history: (session.record?.goalHistory ?? []).map(goalPublicView),
      ...(input.includeCheckOutput && goal?.lastCheck
        ? { checkOutput: goal.lastCheck.outputTail }
        : {}),
    };
    return { result };
  },
};

const goalPause: MutationActionHandler<SessionTarget> = {
  kind: "mutation",
  action: "session.goal.pause",
  parse(input) {
    onlyActionKeys(input, "session.goal.pause");
    const target = sessionTarget(input);
    return { value: target, scope: `session:${target.sessionId}`, intent: {} };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    requireGoalsAvailable(session);
    const goal = currentGoal(session);
    if (!goal || !goalIsRunning(goal.status)) throw conflict("No running goal to pause", goal);
    return {
      resources: resources(session),
      execute: () => perform(context, session, { kind: "pause" }),
    };
  },
};

interface ResumeInput extends SessionTarget {
  command: Extract<GoalCommand, { kind: "resume" }>;
}

const goalResume: MutationActionHandler<ResumeInput> = {
  kind: "mutation",
  action: "session.goal.resume",
  parse(input) {
    onlyActionKeys(input, "session.goal.resume");
    const target = sessionTarget(input);
    const maxIterations = optionalInteger(input, "maxIterations", 1, Number.MAX_SAFE_INTEGER);
    const tokenBudget = optionalInteger(input, "tokenBudget", 1, Number.MAX_SAFE_INTEGER);
    const command = goalResumeCommand({
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    });
    const problem = refusal(command);
    if (problem) throw problem;
    return {
      value: { ...target, command: command as ResumeInput["command"] },
      scope: `session:${target.sessionId}`,
      intent: { maxIterations: maxIterations ?? null, tokenBudget: tokenBudget ?? null },
    };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    assertReadyForAgents(session.environment);
    requireGoalsAvailable(session);
    requireTokenBudgetSupport(session, input.command.tokenBudget);
    const goal = currentGoal(session);
    if (!goal || goalIsRunning(goal.status)) throw conflict("No stopped goal to resume", goal);
    if (goalIsTerminal(goal.status)) throw conflict("That goal has ended; set a new one", goal);
    return {
      resources: resources(session),
      execute: () => perform(context, session, input.command),
    };
  },
};

const goalClear: MutationActionHandler<SessionTarget> = {
  kind: "mutation",
  action: "session.goal.clear",
  parse(input) {
    onlyActionKeys(input, "session.goal.clear");
    const target = sessionTarget(input);
    return { value: target, scope: `session:${target.sessionId}`, intent: {} };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    requireGoalsAvailable(session);
    const goal = currentGoal(session);
    return {
      resources: resources(session),
      async execute() {
        const outcome = await perform(context, session, { kind: "clear" });
        if (outcome.state !== "succeeded") return outcome;
        return {
          ...outcome,
          result: {
            sessionId: session.sessionId,
            goal: goal ? goalStatusSummary(goal) : null,
            cleared: goal !== undefined,
          },
        };
      },
    };
  },
};

/**
 * A set in flight when the backend stopped. The goal's ID derives from the
 * operation, so its record says exactly whether the set took effect, and a
 * repeat of the request reports that instead of "unknown".
 */
registerReconciler("session.goal.set", async (record, context) => {
  if (record.generation === context.generation) return null;
  const target = record.resources.sessionId
    ? decodePublicSessionId(record.resources.sessionId)
    : null;
  const agent = record.resolved?.agent;
  const stored =
    target && typeof agent === "string"
      ? await context.command.storage.getNativeAgentSession(
          nativeAgentSessionStorageKey(
            target.environmentId,
            agent as AgentPlatform,
            nativeTabLogicalSessionKey(target.environmentId, target.tabId),
          ),
        )
      : null;
  const goalId = goalIdForRequest(record.operationId);
  const goal = stored
    ? sessionGoal(stored)?.goalId === goalId
      ? sessionGoal(stored)
      : stored.goalHistory?.find((past) => past.goalId === goalId)
    : undefined;
  if (goal) {
    return {
      state: "succeeded",
      stage: "completed",
      result: mutationResult(record.resources.sessionId!, goalPublicView(goal)),
    };
  }
  return {
    state: "interrupted",
    error: {
      code: "run-interrupted",
      message: "The backend restarted before the goal was set; retry with a new request ID",
    },
  };
});

export const SESSION_GOAL_HANDLERS: PublicActionHandler[] = [
  goalSet,
  goalGet,
  goalPause,
  goalResume,
  goalClear,
];
