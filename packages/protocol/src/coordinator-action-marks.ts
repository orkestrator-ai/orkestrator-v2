/**
 * Coordinator action cards the user marked done by hand, per coordinator
 * conversation (the Actions panel's "Mark done" / "Mark not done").
 *
 * A mark is an override on top of the state the transcript derives: a card is
 * done when the transcript says so or when its id is marked here. Clearing a
 * mark never reopens a card the transcript itself finished. The backend owns
 * the marks (`get_coordinator_action_marks`, `set_coordinator_action_mark`) so
 * every window and client showing a conversation agrees, and announces each
 * change as a `coordinator-action-marks` resource hint.
 *
 * Browser-safe.
 */

export const COORDINATOR_ACTION_MARK_LIMITS = Object.freeze({
  /** Marks one conversation keeps; a mark beyond it is refused, never evicted. */
  marksPerConversation: 500,
  /** A card id: a tool-use id, an interaction id or a PR key with its URL. */
  cardIdChars: 1024,
  /** A project or conversation id. */
  idChars: 200,
});

/** One conversation's manual marks, with a revision that moves on every change. */
export interface CoordinatorActionMarks {
  projectId: string;
  conversationId: string;
  /** 0 while nothing has been stored for the conversation. */
  revision: number;
  /** Marked card ids, oldest first. */
  cardIds: string[];
}

export function isCoordinatorActionCardId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= COORDINATOR_ACTION_MARK_LIMITS.cardIdChars
  );
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= COORDINATOR_ACTION_MARK_LIMITS.idChars
  );
}

/** De-duplicated, bounded card ids from an untrusted value; order kept. */
export function normalizeCoordinatorActionCardIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(isCoordinatorActionCardId))).slice(
    -COORDINATOR_ACTION_MARK_LIMITS.marksPerConversation,
  );
}

/** A validated answer, or null for anything malformed. */
export function parseCoordinatorActionMarks(value: unknown): CoordinatorActionMarks | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isId(record.projectId) || !isId(record.conversationId)) return null;
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) return null;
  if (!Array.isArray(record.cardIds)) return null;
  return {
    projectId: record.projectId,
    conversationId: record.conversationId,
    revision: record.revision as number,
    cardIds: normalizeCoordinatorActionCardIds(record.cardIds),
  };
}

/** Whether a project and conversation id can name stored marks. */
export function isCoordinatorActionMarkScope(projectId: unknown, conversationId: unknown): boolean {
  return isId(projectId) && isId(conversationId);
}
