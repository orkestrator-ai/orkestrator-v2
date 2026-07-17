import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";
import type {
  NativeAgentActivityPart,
  NativeAgentGroupPart,
  NativeFilePart,
  NativeMessage,
  NativeMessagePart,
  NativeTaskGroupPart,
  NativeToolGroupPart,
  NativeToolInvocationPart,
} from "./native-message-types";

interface AttachmentTag {
  type: string;
  path: string;
  filename: string;
}

function parseAttachmentTag(tagContent: string): AttachmentTag | null {
  const typeMatch = tagContent.match(/type="([^"]*)"/);
  const pathMatch = tagContent.match(/path="([^"]*)"/);
  const filenameMatch = tagContent.match(/filename="([^"]*)"/);

  const type = typeMatch?.[1];
  const path = pathMatch?.[1];
  const filename = filenameMatch?.[1] || "";

  if (type && path) {
    return { type, path, filename };
  }
  return null;
}

export function parseNativeAttachmentsFromContent(
  content: string,
): { cleanContent: string; attachments: NativeFilePart[] } {
  const attachments: NativeFilePart[] = [];
  const attachedFilesRegex = /<attached-files>\s*([\s\S]*?)\s*<\/attached-files>/g;
  let cleanContent = content;

  let match: RegExpExecArray | null;
  while ((match = attachedFilesRegex.exec(content)) !== null) {
    const block = match[0];
    const innerContent = match[1] || "";
    const attachmentRegex = /<attachment\s+([^>]*)\s*\/>/g;

    let attachmentMatch: RegExpExecArray | null;
    while ((attachmentMatch = attachmentRegex.exec(innerContent)) !== null) {
      const parsed = parseAttachmentTag(attachmentMatch[1] || "");
      if (!parsed) continue;
      attachments.push({
        type: "file",
        content: parsed.path,
        fileUrl: parsed.type === "image" ? parsed.path : undefined,
      });
    }

    cleanContent = cleanContent.replace(block, "").trim();
  }

  return { cleanContent, attachments };
}

function isTaskTool(toolName?: string): boolean {
  const normalized = toolName?.toLowerCase();
  return normalized === "task" || normalized === "agent";
}

function isToolActivity(part: NativeMessagePart): boolean {
  return (
    part.type === "thinking" ||
    part.type === "tool-invocation"
  );
}

function isAgentActivity(part: NativeMessagePart): part is NativeAgentActivityPart {
  return part.type === "subagent" || part.type === "task-group";
}

function toNativeToolInvocationPart(
  part: ClaudeMessagePart,
): NativeToolInvocationPart {
  return {
    type: "tool-invocation",
    content: part.content ?? part.toolName ?? "",
    toolName: part.toolName,
    toolArgs: part.toolArgs,
    toolState: part.toolState,
    toolTitle: part.toolTitle,
    toolOutput: part.toolOutput,
    toolError: part.toolError,
    toolDiff: part.toolDiff,
    toolUseCount: part.toolUseCount,
    tokenCount: part.tokenCount,
    tokenCountText: part.tokenCountText,
    agentUsageDisplay: part.agentUsageDisplay,
    toolUseId: part.toolUseId,
    parentTaskUseId: part.parentTaskUseId,
    isMcpTool: part.isMcpTool,
    mcpServerName: part.mcpServerName,
  };
}

export function normalizeClaudePart(part: ClaudeMessagePart): NativeMessagePart | null {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        content: part.content ?? "",
        sourcePartId: part._messageUuid,
      };
    case "thinking":
      return {
        type: "thinking",
        content: part.content ?? "",
        sourcePartId: part._messageUuid,
      };
    case "file":
      return { type: "file", content: part.content ?? "" };
    case "tool-invocation":
      return toNativeToolInvocationPart(part);
    case "tool-result":
      return {
        type: "tool-result",
        content: part.content ?? "",
        toolName: part.toolName,
        toolState: part.toolState,
        toolOutput: part.toolOutput,
        toolError: part.toolError,
      };
    default:
      return null;
  }
}

function groupClaudeTaskParts(parts: NativeMessagePart[]): NativeMessagePart[] {
  const result: NativeMessagePart[] = [];
  const taskGroups = new Map<string, NativeTaskGroupPart>();
  let currentTask: NativeTaskGroupPart | null = null;

  for (const part of parts) {
    if (part.type === "text" || part.type === "file") {
      currentTask = null;
      result.push(part);
      continue;
    }

    if (part.type === "thinking") {
      currentTask = null;
      result.push(part);
      continue;
    }

    if (part.type !== "tool-invocation") {
      if (part.type !== "tool-result") {
        result.push(part);
      }
      continue;
    }

    if (isTaskTool(part.toolName)) {
      const taskGroup: NativeTaskGroupPart = {
        type: "task-group",
        content: part.content,
        task: part,
        childTools: [],
      };
      result.push(taskGroup);
      if (part.toolUseId) {
        taskGroups.set(part.toolUseId, taskGroup);
      }
      currentTask = taskGroup;
      continue;
    }

    let parentTask = part.parentTaskUseId
      ? taskGroups.get(part.parentTaskUseId)
      : undefined;
    parentTask ??= currentTask ?? undefined;

    if (parentTask) {
      parentTask.childTools.push(part);
    } else {
      result.push(part);
    }
  }

  return result;
}

function isStreamCollapsibleTextPart(
  previous: NativeMessagePart,
  next: NativeMessagePart,
): boolean {
  if (previous.type !== next.type) return false;
  if (previous.type !== "text" && previous.type !== "thinking") return false;

  const previousContent = previous.content.trim();
  const nextContent = next.content.trim();
  if (!previousContent || !nextContent) return false;

  return (
    previousContent === nextContent ||
    nextContent.startsWith(previousContent) ||
    previousContent.startsWith(nextContent)
  );
}

export function dedupeStreamedNativeParts(
  parts: NativeMessagePart[],
): NativeMessagePart[] {
  const result: NativeMessagePart[] = [];

  for (const part of parts) {
    const previous = result.at(-1);
    if (previous && isStreamCollapsibleTextPart(previous, part)) {
      if (part.content.trim().length >= previous.content.trim().length) {
        result[result.length - 1] = part;
      }
      continue;
    }

    result.push(part);
  }

  return result;
}

export function groupNativeToolActivity(parts: NativeMessagePart[]): NativeMessagePart[] {
  if (parts.some((part) => part.type === "tool-group")) {
    return parts;
  }

  const rendered: NativeMessagePart[] = [];
  let toolGroup: NativeMessagePart[] = [];

  const flushToolGroup = () => {
    if (toolGroup.length === 0) return;
    const group: NativeToolGroupPart = {
      type: "tool-group",
      content: "",
      parts: toolGroup,
    };
    rendered.push(group);
    toolGroup = [];
  };

  for (const part of parts) {
    if (isAgentActivity(part)) {
      flushToolGroup();
      rendered.push(part);
      continue;
    }

    if (isToolActivity(part)) {
      toolGroup.push(part);
      continue;
    }

    if (part.type === "tool-result") {
      continue;
    }

    flushToolGroup();
    rendered.push(part);
  }

  flushToolGroup();
  return rendered;
}

export function groupNativeAgentActivity(parts: NativeMessagePart[]): NativeMessagePart[] {
  const rendered: NativeMessagePart[] = [];
  let agentGroup: NativeAgentActivityPart[] = [];

  const flushAgentGroup = () => {
    if (agentGroup.length === 1) {
      rendered.push(agentGroup[0]!);
    } else if (agentGroup.length > 1) {
      const group: NativeAgentGroupPart = {
        type: "agent-group",
        content: "",
        parts: agentGroup,
      };
      rendered.push(group);
    }
    agentGroup = [];
  };

  for (const part of parts) {
    if (isAgentActivity(part)) {
      agentGroup.push(part);
      continue;
    }

    if (part.type === "agent-group") {
      agentGroup.push(...part.parts);
      continue;
    }

    flushAgentGroup();
    rendered.push(part);
  }

  flushAgentGroup();
  return rendered;
}

export function normalizeNativeMessage(message: NativeMessage): NativeMessage {
  const dedupedParts = dedupeStreamedNativeParts(message.parts);
  return {
    ...message,
    parts: groupNativeAgentActivity(groupNativeToolActivity(dedupedParts)),
  };
}

export function normalizeOpenCodeNativeMessage(message: NativeMessage): NativeMessage {
  return normalizeNativeMessage(message);
}

export function normalizeCodexNativeMessage(message: NativeMessage): NativeMessage {
  return normalizeNativeMessage(message);
}

export function normalizeClaudeMessage(message: ClaudeMessage): NativeMessage {
  const { cleanContent, attachments } = message.role === "user"
    ? parseNativeAttachmentsFromContent(message.content)
    : { cleanContent: message.content, attachments: [] };

  const rawParts = message.role === "user"
    ? [
        ...(cleanContent ? [{ type: "text" as const, content: cleanContent }] : []),
        ...attachments,
      ]
    : message.parts
        .map(normalizeClaudePart)
        .filter((part): part is NativeMessagePart => part !== null);

  const taskGroupedParts = message.role === "assistant"
    ? groupClaudeTaskParts(rawParts)
    : rawParts;

  return {
    id: message.id,
    role: message.role,
    content: cleanContent,
    parts: groupNativeAgentActivity(
      groupNativeToolActivity(dedupeStreamedNativeParts(taskGroupedParts)),
    ),
    createdAt: message.timestamp,
  };
}

export function normalizeClaudeMessages(messages: ClaudeMessage[]): NativeMessage[] {
  return messages.map(normalizeClaudeMessage);
}
