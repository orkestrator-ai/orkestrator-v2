/**
 * A main coordinator's message to the project home, the user's own writable
 * checkout, held for the user's approval (node action request kind
 * `message-project-home`; see `docs/architecture/coordinator.md`, "Messaging
 * the project home").
 *
 * The request record carries the message as the coordinator wrote it, which
 * the user reads in the approval dialog, and the mail `requestId` it is sent
 * under once approved, so a retry of the same `send_message` replays the same
 * mail instead of sending a second one.
 */

export const PROJECT_HOME_MESSAGE_LIMITS = Object.freeze({
  bodyBytes: 32 * 1024,
  subjectChars: 200,
  reasonChars: 500,
  idChars: 256,
} as const);

export interface ProjectHomeMessage {
  /** The coordinator's `send_message` requestId; the mail is sent under it. */
  mailRequestId: string;
  toTabId?: string;
  subject?: string;
  body: string;
  replyToMessageId?: string;
  /** The coordinator asked for deliverNow; it steers only once approved. */
  deliverNow?: boolean;
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
}

/** A stored or proposed project-home message, or null when it is malformed. */
export function parseProjectHomeMessage(value: unknown): ProjectHomeMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const mailRequestId = boundedText(raw.mailRequestId, PROJECT_HOME_MESSAGE_LIMITS.idChars);
  const body = typeof raw.body === "string" && raw.body.trim() ? raw.body : undefined;
  if (
    !mailRequestId ||
    !body ||
    new TextEncoder().encode(body).byteLength > PROJECT_HOME_MESSAGE_LIMITS.bodyBytes
  )
    return null;
  // Refuse malformed optional fields rather than silently changing an approved
  // message (especially its recipient tab). Empty subjects are valid mail.
  for (const [key, max, allowEmpty] of [
    ["toTabId", PROJECT_HOME_MESSAGE_LIMITS.idChars, false],
    ["subject", PROJECT_HOME_MESSAGE_LIMITS.subjectChars, true],
    ["replyToMessageId", 300, false],
  ] as const) {
    const field = raw[key];
    if (
      field !== undefined &&
      (typeof field !== "string" || field.length > max || (!allowEmpty && !field.trim()))
    )
      return null;
  }
  if (raw.deliverNow !== undefined && typeof raw.deliverNow !== "boolean") return null;
  const toTabId = boundedText(raw.toTabId, PROJECT_HOME_MESSAGE_LIMITS.idChars);
  const subject = boundedText(raw.subject, PROJECT_HOME_MESSAGE_LIMITS.subjectChars);
  const replyToMessageId = boundedText(raw.replyToMessageId, 300);
  return {
    mailRequestId,
    ...(toTabId ? { toTabId } : {}),
    ...(subject ? { subject } : {}),
    body,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(raw.deliverNow === true ? { deliverNow: true } : {}),
  };
}
