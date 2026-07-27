import { isClientOnlyNativeMessage } from "@/lib/chat/client-only-messages";
import type { NativeMessage } from "@/lib/chat/native-message-types";

export type MessageForkKind = "prompt" | "response";

function isPersistedConversationMessage(message: NativeMessage): boolean {
  return (
    message.role !== "system"
    && !isClientOnlyNativeMessage(message)
  );
}

/**
 * Places one fork action at the end of every prompt and completed response.
 *
 * A provider may render a response as several adjacent assistant rows. Only
 * the last row receives the action, so "fork response" means the whole
 * exchange rather than an arbitrary streaming update in the middle of it.
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

    let nextIndex = index + 1;
    while (
      nextIndex < messages.length
      && !isPersistedConversationMessage(messages[nextIndex]!)
    ) {
      nextIndex += 1;
    }
    const nextMessage = messages[nextIndex];
    if (nextMessage?.role === "assistant") continue;
    if (!nextMessage && responseInProgress) continue;

    kinds.set(message.id, "response");
  }

  return kinds;
}

export function getForkPromptText(message: NativeMessage): string {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("\n\n");
  return text || message.content;
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
): NativeMessage | undefined {
  const selectedIndex = messages.findIndex((message) => message.id === messageId);
  if (selectedIndex < 0) return undefined;

  for (let index = selectedIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index]!;
    if (isPersistedConversationMessage(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

