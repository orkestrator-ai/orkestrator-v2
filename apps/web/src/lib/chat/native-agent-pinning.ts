import type {
  NativeAgentActivityPart,
  NativeAgentGroupPart,
  NativeBackgroundTaskStatus,
  NativeMessage,
  NativeMessagePart,
  NativeToolGroupPart,
} from "./native-message-types";
import {
  getNativeAgentStatus,
  isNativeAgentActive,
  type NativeAgentStatus,
} from "./native-agent-status";

export interface NativeAgentActivitySnapshot {
  id: string;
  label: string;
  status: NativeAgentStatus;
  kind: "subagent" | "background-task";
  backgroundTaskStatus?: NativeBackgroundTaskStatus;
}

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

function stringArgument(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function trimTaskPrefix(value: string): string {
  return value.replace(/^task\s*:\s*/i, "").trim();
}

export function nativeAgentActivityLabel(part: NativeAgentActivityPart): string {
  if (part.type === "subagent") {
    return part.subagentName?.trim()
      || part.subagentRole?.trim()
      || part.subagentPrompt?.trim()
      || trimTaskPrefix(part.toolTitle?.trim() || part.content.trim())
      || "Sub-agent";
  }

  const task = part.task;
  return stringArgument(
    task.toolArgs,
    "name",
    "agentName",
    "agent_name",
    "description",
    "task",
    "prompt",
  )
    || trimTaskPrefix(task.toolTitle?.trim() || task.content.trim())
    || "Sub-agent";
}

function collectAgentSnapshots(
  parts: NativeMessagePart[],
  messageId: string,
  path: string,
  snapshots: Map<string, NativeAgentActivitySnapshot>,
): void {
  parts.forEach((part, index) => {
    const partPath = `${path}.${index}`;
    if (isAgentPart(part)) {
      const backgroundTask = part.type === "task-group"
        ? part.task.backgroundTask
        : part.backgroundTask;
      const durableId = backgroundTask?.id ?? (part.type === "task-group"
        ? part.task.toolUseId?.trim() || part.task.subagentId?.trim()
        : part.subagentId?.trim() || part.toolUseId?.trim());
      const id = durableId
        ? `${backgroundTask ? "background-task" : part.type}:${durableId}`
        : `${part.type}:${messageId}:${partPath}`;
      snapshots.set(id, {
        id,
        label: nativeAgentActivityLabel(part),
        status: getNativeAgentStatus(part),
        kind: backgroundTask ? "background-task" : "subagent",
        ...(backgroundTask?.status
          ? { backgroundTaskStatus: backgroundTask.status }
          : {}),
      });
      return;
    }

    if (part.type === "agent-group" || part.type === "tool-group") {
      collectAgentSnapshots(part.parts, messageId, partPath, snapshots);
    }
  });
}

/**
 * Produce one current lifecycle snapshot per durable child identity.
 *
 * The map deliberately keeps the last occurrence: follow-up and wait rows can
 * mention a reusable child again, and the newest authoritative row owns the
 * status that should be announced.
 */
export function snapshotNativeAgentActivity(
  messages: NativeMessage[],
): NativeAgentActivitySnapshot[] {
  const snapshots = new Map<string, NativeAgentActivitySnapshot>();
  for (const message of messages) {
    collectAgentSnapshots(message.parts, message.id, "part", snapshots);
  }
  return [...snapshots.values()];
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
