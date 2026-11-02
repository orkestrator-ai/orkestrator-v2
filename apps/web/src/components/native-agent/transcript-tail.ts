import { isClaudeAuthenticationFailureMessage } from "@/lib/claude-auth";
import type { NativeMessage } from "@/lib/chat/native-message-types";

/** What the native tab reads from the end of its transcript on every render. */
export interface TranscriptTail {
  /** The newest assistant row, if any. */
  latestAssistantMessage: NativeMessage | undefined;
  /** Its index in `messages`, or -1. */
  latestAssistantIndex: number;
  /** The newest user row in `turnRows` (goal turns count as prompts), or -1. */
  lastUserTurnIndex: number;
  /** Whether a row after that prompt is a Claude authentication failure. */
  authFailureSinceLastUserTurn: boolean;
}

/**
 * One backward pass over the transcript for the tab's tail-dependent state.
 *
 * `turnRows` is `withGoalTurnsAsPrompts(messages)`, which maps row for row, so
 * an index in one names the same row in the other. Callers memoise this on the
 * two arrays; it used to run as a copy, reverse and scans on every render.
 */
export function readTranscriptTail(
  messages: readonly NativeMessage[],
  turnRows: readonly Pick<NativeMessage, "role">[],
): TranscriptTail {
  let latestAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      latestAssistantIndex = index;
      break;
    }
  }
  let lastUserTurnIndex = -1;
  for (let index = turnRows.length - 1; index >= 0; index -= 1) {
    if (turnRows[index]?.role === "user") {
      lastUserTurnIndex = index;
      break;
    }
  }
  let authFailureSinceLastUserTurn = false;
  for (let index = lastUserTurnIndex + 1; index < messages.length; index += 1) {
    if (isClaudeAuthenticationFailureMessage(messages[index]!)) {
      authFailureSinceLastUserTurn = true;
      break;
    }
  }
  return {
    latestAssistantMessage: latestAssistantIndex >= 0 ? messages[latestAssistantIndex] : undefined,
    latestAssistantIndex,
    lastUserTurnIndex,
    authFailureSinceLastUserTurn,
  };
}
