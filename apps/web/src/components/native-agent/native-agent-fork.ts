import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  findNextForkMessage,
  findPreviousForkMessage,
  type MessageForkBoundary,
} from "@/components/chat/message-fork";
import { getNativeSourceMessageId } from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";

/**
 * Resolve a prompt-fork boundary to a persisted provider message id.
 *
 * Display rows minted by `splitAssistantTranscriptBlocks` carry a
 * `:text-block:` suffix the bridges do not store. Every platform must strip
 * that suffix (or otherwise map back to the source id) before the fork request
 * leaves the renderer.
 */
export function resolveNativeAgentPromptBoundary(
  platform: AgentPlatform,
  message: NativeMessage,
  allMessages: NativeMessage[],
): MessageForkBoundary | null {
  if (platform === "opencode") {
    return { type: "message", messageId: getNativeSourceMessageId(message.id) };
  }
  if (platform === "codex") {
    const previousTurn = findPreviousForkMessage(
      allMessages,
      message.id,
      (candidate) => Boolean(candidate.turnId)
        && candidate.turnId !== message.turnId,
    );
    if (previousTurn) {
      return {
        type: "message",
        messageId: getNativeSourceMessageId(previousTurn.id),
      };
    }
    return findPreviousForkMessage(allMessages, message.id)
      ? null
      : { type: "session-start" };
  }
  const previous = findPreviousForkMessage(allMessages, message.id);
  if (!previous) return { type: "session-start" };
  return {
    type: "message",
    messageId: previous.parts.find((part) => part.sourceMessageId)?.sourceMessageId
      ?? getNativeSourceMessageId(previous.id),
  };
}

/**
 * Resolve a response-fork boundary to a persisted provider message id.
 *
 * Codex forks at turn granularity, so every split section of the same turn
 * maps back to that turn's persisted message rather than a display-row id the
 * bridge would reject as `unknown-message`.
 */
export function resolveNativeAgentResponseBoundary(
  platform: AgentPlatform,
  message: NativeMessage,
  allMessages: NativeMessage[],
): MessageForkBoundary | null {
  if (platform === "opencode") {
    const sourceId = getNativeSourceMessageId(message.id);
    const next = findNextForkMessage(
      allMessages,
      message.id,
      (candidate) => getNativeSourceMessageId(candidate.id) !== sourceId,
    );
    return next
      ? { type: "message", messageId: getNativeSourceMessageId(next.id) }
      : { type: "whole-session" };
  }
  if (platform === "codex") {
    return message.turnId
      ? { type: "message", messageId: getNativeSourceMessageId(message.id) }
      : null;
  }
  return {
    type: "message",
    messageId: message.parts.find((part) => part.sourceMessageId)?.sourceMessageId
      ?? getNativeSourceMessageId(message.id),
  };
}
