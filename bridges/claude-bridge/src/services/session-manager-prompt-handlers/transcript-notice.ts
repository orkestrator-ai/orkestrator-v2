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
