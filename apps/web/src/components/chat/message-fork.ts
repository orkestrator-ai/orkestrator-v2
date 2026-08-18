import { isClientOnlyNativeMessage } from "@/lib/chat/client-only-messages";
import { messageHasVisibleContent } from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";

export type MessageForkKind = "prompt" | "response";

/**
 * What the provider should be asked to branch at.
 *
 * `session-start` and `whole-session` both mean "no boundary message", but they
 * are opposites: the first starts an empty sibling session (the selected prompt
 * begins the transcript, so there is nothing to keep), the second clones the
 * transcript entire (the selected response ends it, so there is nothing to
 * drop). Collapsing them into one "no id" case is how a fork silently keeps
 * everything when it meant to keep nothing.
 */
export type MessageForkBoundary =
  | { type: "message"; messageId: string }
  | { type: "session-start" }
  | { type: "whole-session" };

/**
 * Resolves the boundary for one candidate action.
 *
 * Returning `null` withdraws the action: the provider cannot honour any
 * boundary for this message, so offering the button would only ever produce an
 * error toast.
 */
export type MessageForkBoundaryResolver = (
  message: NativeMessage,
  messages: NativeMessage[],
) => MessageForkBoundary | null;

export interface MessageForkPlanEntry {
  kind: MessageForkKind;
  boundary: MessageForkBoundary;
  /** Prompt forks only: text restored into the fork's composer. Otherwise `""`. */
  draftText: string;
  /**
   * Prompt forks only: file parts the restored draft cannot carry.
   *
   * A prompt fork branches *before* its prompt, so the original message — and
   * its attachments — is in neither the fork's history nor the new composer.
   * Counted here so the tab can say so rather than lose them silently.
   */
  droppedAttachmentCount: number;
}

function isPersistedConversationMessage(message: NativeMessage): boolean {
  return message.role !== "system" && !isClientOnlyNativeMessage(message);
}

/**
 * Places one fork action at the end of every prompt and every completed
 * transcript section.
 *
 * A provider may render a response as several adjacent assistant rows — text,
 * then tools, then more text. Each completed section receives its own action so
 * the reader can copy or fork from that block rather than only from the last
 * row of the whole exchange.
 */
export function buildMessageForkActionKinds(
  messages: NativeMessage[],
  responseInProgress: boolean,
): ReadonlyMap<string, MessageForkKind> {
  const kinds = new Map<string, MessageForkKind>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (!isPersistedConversationMessage(message)) continue;

    if (message.role === "user") {
      kinds.set(message.id, "prompt");
      continue;
    }

    if (message.role !== "assistant" || !messageHasVisibleContent(message)) {
      continue;
    }

    let nextIndex = index + 1;
    while (nextIndex < messages.length && !isPersistedConversationMessage(messages[nextIndex]!)) {
      nextIndex += 1;
    }
    const nextMessage = messages[nextIndex];
    if (!nextMessage && responseInProgress) continue;

    kinds.set(message.id, "response");
  }

  return kinds;
}

/**
 * Placement and boundary resolution as one indexed plan.
 *
 * Both the render gate and the click handler read this same map, so they cannot
 * disagree about whether a message is forkable. Resolving only at click time
 * used to leave a visible, enabled button on history the provider could not
 * branch — it did nothing but raise a toast.
 *
 * Keyed by *display row* id. A provider whose display rows do not match its
 * persisted ids resolves that difference inside its own resolver.
 */
export function buildMessageForkPlan(
  messages: NativeMessage[],
  options: {
    responseInProgress: boolean;
    resolvePromptBoundary: MessageForkBoundaryResolver;
    resolveResponseBoundary: MessageForkBoundaryResolver;
  },
): ReadonlyMap<string, MessageForkPlanEntry> {
  const kinds = buildMessageForkActionKinds(messages, options.responseInProgress);
  const plan = new Map<string, MessageForkPlanEntry>();

  for (const message of messages) {
    const kind = kinds.get(message.id);
    if (!kind) continue;

    const boundary =
      kind === "prompt"
        ? options.resolvePromptBoundary(message, messages)
        : options.resolveResponseBoundary(message, messages);
    if (!boundary) continue;

    plan.set(message.id, {
      kind,
      boundary,
      draftText: kind === "prompt" ? getForkPromptText(message) : "",
      droppedAttachmentCount: kind === "prompt" ? countForkPromptAttachments(message) : 0,
    });
  }

  return plan;
}

export function getForkPromptText(message: NativeMessage): string {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("\n\n");
  return text || message.content;
}

/**
 * File parts a restored prompt draft leaves behind.
 *
 * The three providers spell an attachment's path differently across persisted
 * and optimistic messages, so re-attaching the actual file is not reliable.
 * Counting is, and a count is enough to tell the user what did not come across.
 */
export function countForkPromptAttachments(message: NativeMessage): number {
  return message.parts.filter((part) => part.type === "file").length;
}

/**
 * The warning a prompt fork shows when it could not carry the attachments.
 *
 * `undefined` when there were none, so every tab can call this unconditionally
 * and phrase the loss the same way.
 */
export function forkAttachmentNotice(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count === 1
    ? "1 attachment was not carried into the fork. Re-attach it before sending."
    : `${count} attachments were not carried into the fork. Re-attach them before sending.`;
}

export function findPreviousForkMessage(
  messages: NativeMessage[],
  messageId: string,
  predicate: (message: NativeMessage) => boolean = () => true,
): NativeMessage | undefined {
  const selectedIndex = messages.findIndex((message) => message.id === messageId);
  if (selectedIndex < 0) return undefined;

  for (let index = selectedIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index]!;
    if (isPersistedConversationMessage(candidate) && predicate(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function findNextForkMessage(
  messages: NativeMessage[],
  messageId: string,
  predicate: (message: NativeMessage) => boolean = () => true,
): NativeMessage | undefined {
  const selectedIndex = messages.findIndex((message) => message.id === messageId);
  if (selectedIndex < 0) return undefined;

  for (let index = selectedIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index]!;
    if (isPersistedConversationMessage(candidate) && predicate(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
