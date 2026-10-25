import type { ParkedDeadline, SessionState } from "./acp-context.js";
import { schedulePersist } from "./acp-persist-writer.js";
import { syncPromptTurnClock } from "./acp-prompt-clock.js";

/** The two families of parked request a user can pause. */
export type AcpHoldFamily = "approvals" | "interactions";

export interface AcpHoldAnswer {
  status: 200 | 409 | 422;
  body: Record<string, unknown>;
}

const STALE_ERRORS: Record<AcpHoldFamily, string> = {
  approvals: "Approval is no longer pending",
  interactions: "Interaction is no longer pending",
};

/**
 * Pause (`held: true`) or resume a parked request's countdown.
 *
 * A hold only moves the deadline: it never answers the request, and expiry
 * still cancels it exactly as before. While any request is held the turn's
 * `session/prompt` timeout stops (`acp-prompt-clock.ts`), so the ceiling is
 * the day-long hold ceiling and, for a question, Grok's own question timeout
 * (see `parkGrokInteraction`); a turn without that clock still caps it at its
 * deadline. `expiresAt` in the answer is the honest end.
 */
export function holdParkedRequest(
  state: SessionState,
  family: AcpHoldFamily,
  /** Undefined for an id that could not be decoded, which nothing parks. */
  id: string | undefined,
  held: boolean,
): AcpHoldAnswer {
  const entry: ParkedDeadline | undefined =
    id === undefined
      ? undefined
      : family === "approvals"
        ? state.approvals.get(id)
        : state.interactions.get(id);
  const result = entry ? entry.deadline.setHeld(held) : "settled";
  if (!entry || result === "settled") {
    return { status: 409, body: { error: STALE_ERRORS[family], status: "stale" } };
  }
  if (result === "unavailable") {
    return {
      status: 422,
      body: { error: "This request's deadline cannot be extended", status: "unavailable" },
    };
  }
  if (result === "applied") {
    syncPromptTurnClock(state);
    // The published `expiresAt` and `hold` moved; readers key on revision.
    state.revision += 1;
    schedulePersist();
  }
  return {
    status: 200,
    body: { status: result, expiresAt: entry.deadline.expiresAt, hold: entry.deadline.hold() },
  };
}
