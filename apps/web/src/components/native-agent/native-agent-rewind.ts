import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  buildMessageForkActionKinds,
  countForkPromptAttachments,
  getForkPromptDraft,
} from "@/components/chat/message-fork";
import { isClientOnlyNativeMessage } from "@/lib/chat/client-only-messages";
import { getNativeSourceMessageId } from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { TranscriptAnnotation } from "@/lib/chat/transcript-annotations";

/**
 * "Rewind to before this prompt": the in-place counterpart of a prompt fork.
 *
 * Offered on prompts only, for every platform that reports
 * `actions.rewindMessages` (Codex, Pi, Cursor). Each bridge resolves a prompt
 * id to "cut before this prompt": Codex reverts the turn holding it and every
 * later turn, Pi moves its leaf to the prompt's parent, Cursor reverts to the
 * run's start checkpoint. A response action would mean three different things
 * (Codex can only drop whole turns), so there is none.
 */
export interface MessageRewindPlanEntry {
  /** The provider message id the bridge cuts before. */
  messageId: string;
  /** Prompts removed, this one included: each is one turn and its response. */
  droppedTurns: number;
  /** The prompt's text, restored into the composer after the rewind. */
  draftText: string;
  draftAnnotations: TranscriptAnnotation[];
  /** File parts the restored draft cannot carry. */
  droppedAttachmentCount: number;
}

function isPersistedPrompt(message: NativeMessage): boolean {
  return message.role === "user" && !isClientOnlyNativeMessage(message);
}

/**
 * The id a platform's bridge accepts for "rewind to before this prompt", or
 * `null` to withdraw the action. Codex refuses a message without a `turnId`
 * (409), so offering it there would only ever raise an error.
 */
export function resolveNativeAgentRewindTarget(
  platform: AgentPlatform,
  message: NativeMessage,
): string | null {
  if (!isPersistedPrompt(message)) return null;
  if (platform === "codex" && !message.turnId) return null;
  if (platform !== "codex" && platform !== "pi" && platform !== "cursor") return null;
  return getNativeSourceMessageId(message.id);
}

/**
 * One rewind action per persisted prompt, keyed by display row id. Built from
 * the same placement as the fork plan, so both actions sit on the same rows.
 */
export function buildMessageRewindPlan(
  messages: NativeMessage[],
  options: { platform: AgentPlatform; responseInProgress: boolean },
): ReadonlyMap<string, MessageRewindPlanEntry> {
  const kinds = buildMessageForkActionKinds(messages, options.responseInProgress);
  const plan = new Map<string, MessageRewindPlanEntry>();
  // Prompts at or after each index, so a turn count is O(1) per row.
  const promptsFrom = Array.from({ length: messages.length + 1 }, () => 0);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    promptsFrom[index] = promptsFrom[index + 1]! + (isPersistedPrompt(messages[index]!) ? 1 : 0);
  }
  messages.forEach((message, index) => {
    if (kinds.get(message.id) !== "prompt") return;
    const messageId = resolveNativeAgentRewindTarget(options.platform, message);
    if (!messageId) return;
    const draft = getForkPromptDraft(message);
    plan.set(message.id, {
      messageId,
      droppedTurns: promptsFrom[index]!,
      draftText: draft.text,
      draftAnnotations: draft.annotations,
      droppedAttachmentCount: countForkPromptAttachments(message),
    });
  });
  return plan;
}

/** What the confirmation says the rewind does on this platform. */
export function describeNativeAgentRewind(
  platform: AgentPlatform,
  agentLabel: string,
  entry: Pick<MessageRewindPlanEntry, "droppedTurns">,
): { title: string; description: string[] } {
  const turns = entry.droppedTurns === 1 ? "1 turn" : `${entry.droppedTurns} turns`;
  const lead =
    entry.droppedTurns === 1
      ? `This removes this prompt and ${agentLabel}'s response from the conversation.`
      : `This removes ${turns} from the conversation: this prompt, its response and everything after it.`;
  const recovery =
    platform === "pi"
      ? "Pi keeps the removed turns as another branch of this conversation. You can switch back to it from Branches in the session panel."
      : `${agentLabel} cannot bring the removed turns back, and Orkestrator cannot undo this.`;
  return {
    title: `Rewind ${agentLabel} to before this prompt?`,
    description: [
      lead,
      recovery,
      "Files those turns changed are not reverted. The prompt's text returns to the composer.",
    ],
  };
}
