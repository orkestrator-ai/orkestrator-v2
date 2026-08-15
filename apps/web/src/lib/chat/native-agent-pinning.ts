import type {
  NativeAgentActivityPart,
  NativeAgentGroupPart,
  NativeMessage,
  NativeMessagePart,
  NativeToolGroupPart,
} from "./native-message-types";
import { isNativeAgentActive } from "./native-agent-status";

function isAgentPart(
  part: NativeMessagePart,
): part is NativeAgentActivityPart {
  return part.type === "subagent" || part.type === "task-group";
}

function isActiveAgentPart(
  part: NativeMessagePart,
): part is NativeAgentActivityPart {
  return isAgentPart(part) && isNativeAgentActive(part);
}

function hasRenderableContent(message: NativeMessage): boolean {
  return message.parts.length > 0 || message.content.trim().length > 0;
}

function extractActiveAgentParts(parts: NativeMessagePart[]): {
  retainedParts: NativeMessagePart[];
  pinnedParts: NativeAgentActivityPart[];
} {
  const retainedParts: NativeMessagePart[] = [];
  const pinnedParts: NativeAgentActivityPart[] = [];

  for (const part of parts) {
    if (isActiveAgentPart(part)) {
      pinnedParts.push(part);
      continue;
    }

    if (part.type === "tool-group") {
      const extracted = extractActiveAgentParts(part.parts);
      pinnedParts.push(...extracted.pinnedParts);

      if (extracted.retainedParts.length > 0) {
        retainedParts.push({
          ...part,
          parts: extracted.retainedParts,
        } satisfies NativeToolGroupPart);
      }
      continue;
    }

    if (part.type === "agent-group") {
      const extracted = extractActiveAgentParts(part.parts);
      pinnedParts.push(...extracted.pinnedParts);
      const retainedAgentParts = extracted.retainedParts.filter(isAgentPart);

      if (retainedAgentParts.length > 0) {
        retainedParts.push({
          ...part,
          parts: retainedAgentParts,
        } satisfies NativeAgentGroupPart);
      }
      continue;
    }

    retainedParts.push(part);
  }

  return { retainedParts, pinnedParts };
}

function createPinnedAgentMessage(
  source: NativeMessage,
  parts: NativeAgentActivityPart[],
): NativeMessage {
  const isGroup = parts.length > 1;

  return {
    ...source,
    // Keep the virtualized row mounted as the active membership changes. Agent
    // expansion state lives inside NativeMessage, so a singleton-specific id
    // would collapse an expanded row as soon as a second agent starts.
    id: `${source.id}:active-agents`,
    content: "",
    parts: isGroup
      ? [{
          type: "agent-group",
          content: "",
          parts,
        }]
      : [parts[0]!],
  };
}

export function pinActiveNativeAgentParts(
  messages: NativeMessage[],
): NativeMessage[] {
  const renderedMessages: NativeMessage[] = [];
  const pinnedMessages: NativeMessage[] = [];

  for (const message of messages) {
    const { retainedParts, pinnedParts } = extractActiveAgentParts(message.parts);

    if (pinnedParts.length === 0) {
      renderedMessages.push(message);
      continue;
    }

    const retainedMessage = {
      ...message,
      parts: retainedParts,
    };

    if (hasRenderableContent(retainedMessage)) {
      renderedMessages.push(retainedMessage);
    }

    pinnedMessages.push(createPinnedAgentMessage(message, pinnedParts));
  }

  return [...renderedMessages, ...pinnedMessages];
}
