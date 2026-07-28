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

function isActiveAgentPart(
  part: NativeMessagePart,
): part is NativeAgentActivityPart {
  const state = getAgentPartState(part);
  return isAgentPart(part) && state !== "success" && state !== "failure";
}

function getAgentPartKey(part: NativeAgentActivityPart, index: number): string {
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
    id: isGroup
      ? `${source.id}:active-agents`
      : `${source.id}:active-agent:${getAgentPartKey(parts[0]!, 0)}`,
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
