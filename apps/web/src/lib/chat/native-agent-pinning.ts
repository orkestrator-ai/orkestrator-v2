import type {
  NativeAgentActivityPart,
  NativeAgentGroupPart,
  NativeMessage,
  NativeMessagePart,
  NativeToolGroupPart,
} from "./native-message-types";

function isAgentPart(
  part: NativeMessagePart,
): part is NativeAgentActivityPart {
  return part.type === "subagent" || part.type === "task-group";
}

function getAgentPartState(part: NativeMessagePart): string | undefined {
  if (part.type === "task-group") {
    return part.task.toolState;
  }

  return part.toolState;
}

function isActiveAgentPart(part: NativeMessagePart): boolean {
  const state = getAgentPartState(part);
  return isAgentPart(part) && state !== "success" && state !== "failure";
}

function getAgentPartKey(part: NativeMessagePart, index: number): string {
  if (part.type === "task-group") {
    const stableId = part.task.toolUseId ?? part.task.subagentId;
    if (stableId) return stableId;

    return (
      part.task.toolName ??
      part.content ??
      "agent"
    ) + `:${index}`;
  }

  const stableId = part.subagentId ?? part.toolUseId;
  if (stableId) return stableId;

  return (
    part.subagentName ??
    part.content ??
    "agent"
  ) + `:${index}`;
}

function hasRenderableContent(message: NativeMessage): boolean {
  return message.parts.length > 0 || message.content.trim().length > 0;
}

function extractActiveAgentParts(parts: NativeMessagePart[]): {
  retainedParts: NativeMessagePart[];
  pinnedParts: NativeMessagePart[];
} {
  const retainedParts: NativeMessagePart[] = [];
  const pinnedParts: NativeMessagePart[] = [];

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
  part: NativeMessagePart,
  index: number,
): NativeMessage {
  return {
    ...source,
    id: `${source.id}:active-agent:${getAgentPartKey(part, index)}`,
    content: "",
    parts: [part],
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

    pinnedParts.forEach((part, index) => {
      pinnedMessages.push(createPinnedAgentMessage(message, part, index));
    });
  }

  return [...renderedMessages, ...pinnedMessages];
}
