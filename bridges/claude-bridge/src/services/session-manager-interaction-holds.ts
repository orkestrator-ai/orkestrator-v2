import type { InteractionDeadline } from "@orkestrator/protocol/agent-interaction-deadline";
import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_HOLD_CEILING_MS,
} from "@orkestrator/protocol/agent-interactions";
import type {
  ClaudeInteractionRequest,
  PlanApprovalRequest,
  QuestionRequest,
} from "../types/index.js";
import { interactionKey } from "./session-manager-interaction-budget.js";
import {
  getPendingInteractions,
  getPendingPlanApprovals,
  getPendingQuestions,
} from "./session-manager-interactions.js";

// The deadlines of every parked request, beside the stores that hold the
// requests themselves. They live apart so a request object stays plain JSON:
// the routes serialize it as-is, and a timer handle does not survive that.

/** The three parked families, named for the routes that serve them. */
export type ClaudeHoldFamily = "questions" | "plan-approvals" | "interactions";

type HeldRequest = QuestionRequest | PlanApprovalRequest | ClaudeInteractionRequest;

const deadlines = new Map<string, InteractionDeadline>();

function deadlineKey(family: ClaudeHoldFamily, storeKey: string): string {
  return JSON.stringify([family, storeKey]);
}

function storeKeyFor(family: ClaudeHoldFamily, request: HeldRequest): string {
  // Questions and plans are stored by id alone; interactions by session and id.
  return family === "interactions" ? interactionKey(request.sessionId, request.id) : request.id;
}

/**
 * Register the deadline that will settle `request`, and publish its state on
 * the request. Returns the release the parking callback calls once the
 * request settles; a redelivered request that replaced this one keeps its own.
 */
export function registerInteractionDeadline(
  family: ClaudeHoldFamily,
  request: HeldRequest,
  deadline: InteractionDeadline,
): () => void {
  const key = deadlineKey(family, storeKeyFor(family, request));
  // A redelivered request takes over the key; the one it replaced keeps its
  // own timer, so its waiter still settles rather than hanging.
  deadlines.set(key, deadline);
  request.expiresAt = deadline.expiresAt;
  request.hold = deadline.hold();
  return () => {
    deadline.settle();
    if (deadlines.get(key) === deadline) deadlines.delete(key);
  };
}

export type ClaudeHoldResult =
  | { status: "applied" | "unchanged"; expiresAt: number; hold: NonNullable<HeldRequest["hold"]> }
  | { status: "stale" | "unavailable" };

/**
 * Pause or resume one parked request's countdown. Never answers it: a pause
 * only moves the deadline, and the expiry it still ends in denies or cancels.
 */
export function holdPendingRequest(
  family: ClaudeHoldFamily,
  sessionId: string,
  requestId: string,
  held: boolean,
): ClaudeHoldResult {
  const pending: HeldRequest[] =
    family === "questions"
      ? getPendingQuestions(sessionId)
      : family === "plan-approvals"
        ? getPendingPlanApprovals(sessionId)
        : getPendingInteractions(sessionId);
  const request = pending.find((entry) => entry.id === requestId);
  const deadline = request && deadlines.get(deadlineKey(family, storeKeyFor(family, request)));
  if (!request || !deadline) return { status: "stale" };
  const result = deadline.setHeld(held);
  if (result === "settled") return { status: "stale" };
  if (result === "unavailable") return { status: "unavailable" };
  request.expiresAt = deadline.expiresAt;
  request.hold = deadline.hold();
  return { status: result, expiresAt: request.expiresAt, hold: request.hold };
}

/** What Claude is told when a request expires, paused or not. */
export function interactionExpiryMessage(subject: string, deadline: InteractionDeadline): string {
  const window =
    deadline.heldAt === undefined
      ? AGENT_INTERACTION_DEFAULT_TIMEOUT_MS
      : AGENT_INTERACTION_HOLD_CEILING_MS;
  const minutes = Math.round(window / 60_000);
  return deadline.heldAt === undefined
    ? `${subject} timed out after ${minutes} minutes`
    : `${subject} timed out after staying paused for ${Math.round(minutes / 60)} hours`;
}
