/**
 * How the goal loop reads in a transcript.
 *
 * A goal turn is a provider row with role `user` that is really a carrier the
 * backend wrote, so it becomes a tile rather than a bubble, as peer mail does.
 * Status rows have no durable transcript row at all: they are derived from the
 * session snapshot's goal, so a reload shows the same rows.
 */
import {
  describeGoalStatus,
  goalIsTerminal,
  isGoalCarrierContent,
  isGoalContinuationRequestId,
  parseGoalCarrier,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import {
  GOAL_STATUS_MESSAGE_PREFIX,
  GOAL_TURN_MESSAGE_PREFIX,
  isClientOnlyNativeMessage,
} from "./client-only-messages";
import type {
  GoalStatusPresentation,
  GoalTurnPresentation,
  NativeMessage,
} from "./native-message-types";

/** The carrier a provider row holds, when the row is a goal turn. */
function goalCarrierText(
  message: Pick<NativeMessage, "role" | "content" | "parts">,
): string | undefined {
  if (message.role !== "user") return undefined;
  if (isGoalCarrierContent(message.content)) return message.content;
  const firstText = message.parts.find((part) => part.type === "text");
  return firstText && isGoalCarrierContent(firstText.content) ? firstText.content : undefined;
}

/**
 * The payload's optional fields come from transcript JSON, so nothing but the
 * declared shapes may reach a renderer.
 */
function failedCheckOf(value: unknown): GoalTurnPresentation["failedCheck"] {
  if (typeof value !== "object" || value === null) return undefined;
  const check = value as { exitCode?: unknown; timedOut?: unknown; outputTail?: unknown };
  if (typeof check.outputTail !== "string") return undefined;
  return {
    exitCode: typeof check.exitCode === "number" ? check.exitCode : null,
    ...(check.timedOut === true ? { timedOut: true } : {}),
    outputTail: check.outputTail,
  };
}

/**
 * The tile for a provider row that is a goal turn, or null when it is not one.
 * A carrier that does not parse is still a goal turn: it never falls back to a
 * user bubble of raw transport text.
 */
export function createGoalTurnNativeMessage(
  message: Pick<NativeMessage, "id" | "role" | "content" | "parts" | "createdAt">,
): NativeMessage | null {
  const carrier = goalCarrierText(message);
  if (carrier === undefined) return null;
  const payload = parseGoalCarrier(carrier);
  const objective = payload?.objective ?? "";
  const failedCheck = failedCheckOf(payload?.failedCheck);
  return {
    id: `${GOAL_TURN_MESSAGE_PREFIX}${message.id}`,
    role: "system",
    content: objective,
    parts: objective ? [{ type: "text", content: objective }] : [],
    createdAt: message.createdAt,
    goalTurn: payload
      ? {
          iteration: payload.iteration,
          maxIterations: payload.maxIterations,
          objective: payload.objective,
          ...(typeof payload.check === "string" ? { check: payload.check } : {}),
          ...(failedCheck ? { failedCheck } : {}),
          ...(typeof payload.failedVerdict?.summary === "string"
            ? { failedVerdict: payload.failedVerdict.summary }
            : {}),
        }
      : {},
  };
}

/**
 * A goal turn starts a turn even though it is not the user's prompt. Clocks and
 * "after the last prompt" checks read this list, so a 20-turn goal reports its
 * last turn rather than everything since the user last typed. Positions match
 * the input's.
 */
export function withGoalTurnsAsPrompts(messages: NativeMessage[]): NativeMessage[] {
  if (!messages.some((message) => message.goalTurn)) return messages;
  return messages.map((message) => (message.goalTurn ? { ...message, role: "user" } : message));
}

/** Whether a row's clock came from the backend, for the turn timers. */
export function hasBackendTurnClock(message: NativeMessage): boolean {
  return !isClientOnlyNativeMessage(message) || message.goalTurn !== undefined;
}

/** A queued goal turn belongs to the loop: nobody can edit, steer or recall it. */
export function isGoalQueueItem(item: { id: string; text: string }): boolean {
  return isGoalContinuationRequestId(item.id) || isGoalCarrierContent(item.text);
}

function statusRow(
  id: string,
  createdAt: string,
  content: string,
  goalStatus: GoalStatusPresentation,
): NativeMessage {
  return {
    id: `${GOAL_STATUS_MESSAGE_PREFIX}${id}`,
    role: "system",
    content,
    parts: [{ type: "text", content }],
    createdAt,
    goalStatus,
  };
}

function checkRowText(check: NonNullable<NativeAgentGoalView["lastCheck"]>): string {
  if (check.passed) return "Check passed";
  if (check.timedOut) return "Check timed out";
  return check.exitCode === null ? "Check failed" : `Check failed with exit code ${check.exitCode}`;
}

/**
 * The status rows a snapshot's goal can vouch for, oldest first.
 *
 * Only the current state is on the snapshot, so a pause that was resumed leaves
 * no row, and only the latest check has one. Earlier failed checks stay visible
 * in the goal turn that answered them.
 */
export function goalStatusRows(goal: NativeAgentGoalView): NativeMessage[] {
  const rows: NativeMessage[] = [
    statusRow(
      `${goal.goalId}:set`,
      goal.setAt,
      goal.check
        ? `Goal set. It finishes when this check passes: ${goal.check}`
        : goal.verifier
          ? "Goal set. A verifier session judges it when the agent says it is done."
          : "Goal set with no check. It will end as unverified.",
      { kind: "set", tone: "neutral" },
    ),
  ];
  if (goal.lastCheck) {
    rows.push(
      statusRow(
        `${goal.goalId}:check:${goal.lastCheck.at}`,
        goal.lastCheck.at,
        checkRowText(goal.lastCheck),
        {
          kind: "check",
          tone: goal.lastCheck.passed ? "success" : "failure",
          checkAt: goal.lastCheck.at,
        },
      ),
    );
  }
  if (goal.lastVerdict) {
    rows.push(
      statusRow(
        `${goal.goalId}:verdict:${goal.lastVerdict.at}`,
        goal.lastVerdict.at,
        `${goal.lastVerdict.passed ? "Verifier passed" : "Verifier failed"}: ${goal.lastVerdict.summary}`,
        { kind: "verdict", tone: goal.lastVerdict.passed ? "success" : "failure" },
      ),
    );
  }
  if (goalIsTerminal(goal.status)) {
    rows.push(
      statusRow(`${goal.goalId}:ended`, goal.endedAt ?? goal.updatedAt, describeGoalStatus(goal), {
        kind: "ended",
        tone: goal.status === "complete" ? "success" : "attention",
      }),
    );
  } else if (goal.status === "paused" || goal.status === "blocked" || goal.status === "limited") {
    const ownAct = goal.statusReason === "user-paused" || goal.statusReason === "user-stopped";
    rows.push(
      statusRow(
        `${goal.goalId}:stopped:${goal.updatedAt}`,
        goal.updatedAt,
        describeGoalStatus(goal),
        {
          kind: "stopped",
          tone: ownAct ? "neutral" : "attention",
        },
      ),
    );
  }
  return rows;
}

/**
 * The transcript with the goal's status rows, each placed by its clock among
 * the rows already there, as `withUserCommandRows` places a command.
 *
 * With earlier history still to load, a row older than the window is left out:
 * at the top of the window it would claim a place in the conversation it does
 * not have. Loading that history brings it back.
 */
export function withGoalStatusRows(
  messages: readonly NativeMessage[],
  goal: NativeAgentGoalView,
  options: { canLoadEarlier?: boolean } = {},
): NativeMessage[] {
  const firstAt = Date.parse(messages[0]?.createdAt ?? "");
  const rows = goalStatusRows(goal)
    .filter(
      (row) =>
        !options.canLoadEarlier ||
        !Number.isFinite(firstAt) ||
        Date.parse(row.createdAt) >= firstAt,
    )
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  if (rows.length === 0) return [...messages];
  const result: NativeMessage[] = [];
  let next = 0;
  for (const message of messages) {
    const at = Date.parse(message.createdAt);
    while (next < rows.length && Number.isFinite(at) && Date.parse(rows[next]!.createdAt) < at) {
      result.push(rows[next]!);
      next += 1;
    }
    result.push(message);
  }
  for (; next < rows.length; next += 1) result.push(rows[next]!);
  return result;
}
