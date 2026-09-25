/**
 * Wording for a request's execution details: turn outcome, cancel refusals,
 * late cancels, cancel source and dispatch mode. Pure, so every branch is
 * testable without rendering a card.
 */
import type {
  WebAnnotationCancelRefusal,
  WebAnnotationDispatchMode,
  WebAnnotationRequest,
} from "@orkestrator/protocol/web-annotations";

const CANCEL_REFUSALS: Record<WebAnnotationCancelRefusal, string> = {
  claimed:
    "The agent already picked this request up, so it could not be withdrawn from the queue. It may still run.",
  unconfirmed:
    "Delivery is unconfirmed, so there is nothing to stop yet. Retry delivery or discard it.",
  "not-active": "This request is no longer running, so there was nothing to stop.",
  "newer-turn":
    "A newer turn is running in that session. Stopping it would interrupt other work, so nothing was stopped.",
  "already-finished": "The turn had already finished, so there was nothing to stop.",
  "stop-failed":
    "Orkestrator asked the agent to stop, but the stop did not take effect. The turn may still be running.",
};

export function cancelRefusalText(code: WebAnnotationCancelRefusal | undefined | null): string {
  return code ? CANCEL_REFUSALS[code] : "This request can no longer be stopped.";
}

const DISPATCH_MODES: Record<WebAnnotationDispatchMode, string> = {
  plan: "Sent in plan mode",
  build: "Sent in build mode",
  session: "Sent with the session's own mode",
};

export function dispatchModeLabel(mode: WebAnnotationDispatchMode | undefined): string | null {
  return mode ? DISPATCH_MODES[mode] : null;
}

const CANCEL_SOURCES: Record<NonNullable<WebAnnotationRequest["cancelSource"]>, string> = {
  user: "Cancelled from the note",
  "chat-queue": "Removed from the chat queue before it was sent",
  retarget: "Moved to another session",
};

export function cancelSourceLabel(request: WebAnnotationRequest): string | null {
  if (request.state !== "cancelled" || !request.cancelSource) return null;
  return CANCEL_SOURCES[request.cancelSource];
}

/** Content-free notes about how the turn ended and how a cancel landed. */
export function requestOutcomeNotes(
  request: WebAnnotationRequest,
): Array<{ tone: "error" | "warning" | "muted"; text: string; key: string }> {
  const notes: Array<{ tone: "error" | "warning" | "muted"; text: string; key: string }> = [];
  if (request.turnOutcome === "failed") {
    notes.push({
      key: "turn-failed",
      tone: "error",
      text: request.turnError
        ? `The agent's turn failed: ${request.turnError}`
        : "The agent's turn failed.",
    });
  } else if (
    request.turnOutcome === "unknown" &&
    (request.state === "completed" || request.state === "awaiting-review")
  ) {
    notes.push({
      key: "turn-unknown",
      tone: "muted",
      text: "Orkestrator could not tell how the turn ended. Check the conversation.",
    });
  }
  if (request.cancelArrivedLate) {
    notes.push({
      key: "cancel-late",
      tone: "warning",
      text: "Stop arrived after the agent had already finished this turn, so it completed normally.",
    });
  }
  const refusal = request.cancelRefusal;
  if (refusal && !request.cancelArrivedLate) {
    notes.push({
      key: `refusal-${refusal.code}`,
      tone: refusal.code === "stop-failed" ? "error" : "warning",
      text: cancelRefusalText(refusal.code),
    });
  }
  const source = cancelSourceLabel(request);
  if (source) notes.push({ key: "cancel-source", tone: "muted", text: source });
  return notes;
}

/** Stop was attempted and failed: the turn may still be running. */
export function stopFailed(request: WebAnnotationRequest): boolean {
  return request.cancelRefusal?.code === "stop-failed";
}

/** The destination session is gone while the request was never run: retarget or cancel. */
export function destinationMissing(request: WebAnnotationRequest): boolean {
  return (
    Boolean(request.destinationMissingAt) || request.blockedReason === "destination-unavailable"
  );
}
