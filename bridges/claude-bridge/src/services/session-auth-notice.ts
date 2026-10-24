/**
 * The turn-time sign-in notice a session carries (`SessionState.authNotice`).
 *
 * Readiness (`claude-sign-in.ts`) answers "can a prompt be sent at all" for the
 * whole bridge, and only for a login that is confirmed missing. This is the
 * other half: a login that stopped working while a turn ran. The backend shows
 * it as the tab's `auth` notice beside the transcript's sign-in card, so an
 * expired login reads as a sign-in problem rather than a failed spawn.
 */
import type { SessionAuthNotice, SessionState } from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";

export const CLAUDE_LOGIN_REFUSED_MESSAGE =
  "Claude's login was refused. Sign in to Claude again to keep working.";

const MAX_NOTICE_LENGTH = 500;

/**
 * Set, replace or clear (`undefined`) the session's notice, and tell live
 * clients. A no-op when nothing changes, so a repeated failure does not churn
 * the projection; a new occurrence id still counts as a change.
 */
export function setSessionAuthNotice(
  session: SessionState,
  sessionId: string,
  notice: SessionAuthNotice | undefined,
): void {
  const previous = session.authNotice;
  if (!previous && !notice) return;
  if (
    previous &&
    notice &&
    previous.state === notice.state &&
    previous.message === notice.message &&
    previous.occurrenceId === notice.occurrenceId
  ) {
    return;
  }
  session.authNotice = notice
    ? { ...notice, message: notice.message.slice(0, MAX_NOTICE_LENGTH) }
    : undefined;
  eventEmitter.emit({
    type: "session.updated",
    sessionId,
    data: { authNotice: session.authNotice ?? null },
  });
}

/**
 * A turn refused for want of a usable login. Keeps the occurrence of a notice
 * already showing, so every retried request inside one failure does not
 * re-raise a notice the user dismissed.
 */
export function noteSessionLoginRefused(
  session: SessionState,
  sessionId: string,
  occurrenceId: string,
): void {
  const current = session.authNotice;
  if (current?.state === "expired" && current.message === CLAUDE_LOGIN_REFUSED_MESSAGE) return;
  setSessionAuthNotice(session, sessionId, {
    state: "expired",
    message: CLAUDE_LOGIN_REFUSED_MESSAGE,
    occurrenceId,
  });
}
