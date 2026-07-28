import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
} from "@/lib/opencode-client";
import type { NativeMessage, NativeMessagePart } from "./native-message-types";

export const OPTIMISTIC_MESSAGE_PREFIX = "optimistic-";

/**
 * Transcript marker written when the user interrupts a turn.
 *
 * Shared so every agent says the same thing — OpenCode used to leave no trace
 * at all, which made an interrupted turn look like one that simply produced
 * nothing.
 */
export const TURN_STOPPED_BY_USER = "Query stopped by user.";

interface OptimisticNativeAttachment {
  path: string;
  previewUrl?: string;
  name: string;
}

function normalizeMessageContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function toOptimisticFileUrl(path: string, previewUrl?: string): string | undefined {
  if (previewUrl) {
    return previewUrl;
  }

  if (!path.startsWith("/")) {
    return undefined;
  }

  /**
   * `encodeURI` leaves `#` and `?` intact because they are legal URI
   * delimiters, so a real filename containing either — `error #1.png` — parses
   * as a fragment or query and the image resolves to the wrong (or no) file.
   * Every other character `encodeURI` escapes stays escaped.
   */
  const encodedPath = encodeURI(path)
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
  return `file://${encodedPath}`;
}

/**
 * Fingerprints exist solely to match an optimistic user message against its
 * server echo. Optimistic messages contain only text and file parts, so tool
 * payloads (`toolOutput`, `toolArgs`) can never influence a match — a tool
 * part already fails on `type` — and serializing them made every fingerprint
 * pay for the largest fields in the transcript.
 */
function getPartFingerprint(part: NativeMessagePart): string {
  return JSON.stringify({
    type: part.type,
    content: normalizeMessageContent(part.content),
    fileUrl: part.fileUrl,
    toolName: part.toolName,
    toolTitle: part.toolTitle,
    toolState: part.toolState,
    toolError: part.toolError,
  });
}

function getMessageFingerprint(message: Pick<NativeMessage, "role" | "content" | "parts">): string {
  return JSON.stringify({
    role: message.role,
    content: normalizeMessageContent(message.content),
    parts: message.parts.map(getPartFingerprint),
  });
}

function countFingerprints(messages: NativeMessage[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const message of messages) {
    const fingerprint = getMessageFingerprint(message);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }

  return counts;
}

function mergeMessagesByTimestamp(
  incomingMessages: NativeMessage[],
  clientMessages: NativeMessage[],
): NativeMessage[] {
  const mergedMessages = [...incomingMessages];

  for (const clientMessage of clientMessages) {
    const clientTime = new Date(clientMessage.createdAt || 0).getTime();
    let insertIndex = mergedMessages.length;

    for (let i = mergedMessages.length - 1; i >= 0; i--) {
      const incomingMessage = mergedMessages[i];
      if (!incomingMessage) continue;

      const incomingTime = new Date(incomingMessage.createdAt || 0).getTime();
      if (incomingTime <= clientTime) {
        insertIndex = i + 1;
        break;
      }

      if (i === 0 && incomingTime > clientTime) {
        insertIndex = 0;
      }
    }

    mergedMessages.splice(insertIndex, 0, clientMessage);
  }

  return mergedMessages;
}

export function isOptimisticNativeMessage(message: Pick<NativeMessage, "id">): boolean {
  return message.id.startsWith(OPTIMISTIC_MESSAGE_PREFIX);
}

export function createOptimisticNativeMessage(
  messageId: string,
  text: string,
  attachments: OptimisticNativeAttachment[] = [],
  createdAt: string = new Date().toISOString(),
): NativeMessage {
  const parts: NativeMessagePart[] = [
    { type: "text", content: text },
    ...attachments.map((attachment) => ({
      type: "file" as const,
      content: attachment.name || attachment.path,
      fileUrl: toOptimisticFileUrl(attachment.path, attachment.previewUrl),
    })),
  ];

  return {
    id: messageId,
    role: "user",
    content: text,
    parts,
    createdAt,
  };
}

export function isClientOnlyNativeMessage(message: Pick<NativeMessage, "id">): boolean {
  return (
    message.id.startsWith(ERROR_MESSAGE_PREFIX)
    || message.id.startsWith(SYSTEM_MESSAGE_PREFIX)
    || isOptimisticNativeMessage(message)
  );
}

export function mergeNativeMessagesPreservingClientOnly(
  existingMessages: NativeMessage[],
  incomingMessages: NativeMessage[],
): NativeMessage[] {
  const incomingMessageIds = new Set(incomingMessages.map((message) => message.id));
  const existingServerMessages = existingMessages.filter(
    (message) => !isClientOnlyNativeMessage(message),
  );
  const existingClientMessages = existingMessages.filter((message) => {
    return isClientOnlyNativeMessage(message) && !incomingMessageIds.has(message.id);
  });

  if (existingClientMessages.length === 0) {
    return incomingMessages;
  }

  const optimisticMessages = existingClientMessages.filter(isOptimisticNativeMessage);

  let clientMessagesToPreserve: NativeMessage[];
  if (optimisticMessages.length === 0) {
    // Only optimistic messages can be superseded by a server echo; error and
    // system messages are always preserved, so nothing needs fingerprinting.
    clientMessagesToPreserve = existingClientMessages;
  } else {
    // A message can only fingerprint-match an optimistic send if it shares its
    // role and normalized text, so restrict the (relatively expensive)
    // fingerprinting to that handful of candidates instead of serializing
    // every message in both lists on every snapshot.
    const optimisticContentKeys = new Set(
      optimisticMessages.map(
        (message) => `${message.role}\0${normalizeMessageContent(message.content)}`,
      ),
    );
    const couldMatchOptimistic = (message: NativeMessage): boolean =>
      optimisticContentKeys.has(
        `${message.role}\0${normalizeMessageContent(message.content)}`,
      );

    const existingServerFingerprintCounts = countFingerprints(
      existingServerMessages.filter(couldMatchOptimistic),
    );
    const incomingFingerprintCounts = countFingerprints(
      incomingMessages.filter(couldMatchOptimistic),
    );
    const acknowledgedOptimisticBudgets = new Map<string, number>();

    for (const [fingerprint, incomingCount] of incomingFingerprintCounts) {
      const existingCount = existingServerFingerprintCounts.get(fingerprint) ?? 0;
      if (incomingCount > existingCount) {
        acknowledgedOptimisticBudgets.set(fingerprint, incomingCount - existingCount);
      }
    }

    clientMessagesToPreserve = existingClientMessages.filter((message) => {
      if (!isOptimisticNativeMessage(message)) {
        return true;
      }

      const fingerprint = getMessageFingerprint(message);
      const remainingBudget = acknowledgedOptimisticBudgets.get(fingerprint) ?? 0;
      if (remainingBudget <= 0) {
        return true;
      }

      acknowledgedOptimisticBudgets.set(fingerprint, remainingBudget - 1);
      return false;
    });
  }

  if (clientMessagesToPreserve.length === 0) {
    return incomingMessages;
  }

  return mergeMessagesByTimestamp(incomingMessages, clientMessagesToPreserve);
}
