import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
} from "@/lib/opencode-client";
import type { NativeMessage, NativeMessagePart } from "./native-message-types";

export const OPTIMISTIC_MESSAGE_PREFIX = "optimistic-";

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

  return `file://${encodeURI(path)}`;
}

function getPartFingerprint(part: NativeMessagePart): string {
  return JSON.stringify({
    type: part.type,
    content: normalizeMessageContent(part.content),
    fileUrl: part.fileUrl,
    toolName: part.toolName,
    toolTitle: part.toolTitle,
    toolState: part.toolState,
    toolOutput: part.toolOutput,
    toolError: part.toolError,
    toolArgs: part.toolArgs,
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

  const existingServerFingerprintCounts = countFingerprints(existingServerMessages);
  const incomingFingerprintCounts = countFingerprints(incomingMessages);
  const acknowledgedOptimisticBudgets = new Map<string, number>();

  for (const [fingerprint, incomingCount] of incomingFingerprintCounts) {
    const existingCount = existingServerFingerprintCounts.get(fingerprint) ?? 0;
    if (incomingCount > existingCount) {
      acknowledgedOptimisticBudgets.set(fingerprint, incomingCount - existingCount);
    }
  }

  const clientMessagesToPreserve = existingClientMessages.filter((message) => {
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

  if (clientMessagesToPreserve.length === 0) {
    return incomingMessages;
  }

  return mergeMessagesByTimestamp(incomingMessages, clientMessagesToPreserve);
}
