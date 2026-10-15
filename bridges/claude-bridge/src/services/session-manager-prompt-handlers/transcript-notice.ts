import type {
  NormalizedMessage,
  NormalizedPart,
  SessionState,
  SSEEvent,
} from "../../types/index.js";
import { generateMessageId } from "../session-manager-core.js";
import { markTranscriptChanged } from "../transcript-revision.js";

/**
 * Append a one-part standalone message to the transcript.
 *
 * Used for rows that belong to the conversation but to no assistant turn: a
 * compaction boundary, a status line, a settled retry. Role `system` so the
 * renderer styles them as markers rather than as anything the user or the
 * model said.
 */
export function appendTranscriptNotice(
  session: SessionState,
  sessionId: string,
  emit: (event: SSEEvent) => void,
  part: NormalizedPart,
): NormalizedMessage {
  const message: NormalizedMessage = {
    id: generateMessageId(),
    role: "system",
    content: part.content,
    parts: [part],
    createdAt: new Date().toISOString(),
  };
  session.messages.push(message);
  markTranscriptChanged(session);
  emit({ type: "message.updated", sessionId, data: { message } });
  return message;
}

/**
 * Settle a retry row this turn opened.
 *
 * A retry is only interesting until it resolves; a row left pending reports a
 * request still in flight long after the turn ended, which is the failure mode
 * this part kind exists to fix. Every terminal path calls this — the next
 * assistant message, the turn's own end, and its error branch.
 */
export function settlePendingApiRetry(
  session: SessionState,
  sessionId: string,
  emit: (event: SSEEvent) => void,
  stream: { pendingApiRetryMessageId?: string },
  outcome: { state: "success" | "failure" },
): void {
  const messageId = stream.pendingApiRetryMessageId;
  if (!messageId) return;
  stream.pendingApiRetryMessageId = undefined;
  const message = session.messages.find((candidate) => candidate.id === messageId);
  const part = message?.parts[0];
  if (!message || part?.type !== "retry") return;
  part.toolState = outcome.state;
  markTranscriptChanged(session);
  emit({ type: "message.updated", sessionId, data: { message } });
}
