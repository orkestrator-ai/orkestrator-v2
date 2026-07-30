/**
 * Adapts a build pipeline's persisted provider transcript to the shared native
 * message model, so a build stage renders through exactly the components the
 * Claude, Codex and OpenCode tabs use.
 *
 * The snapshot field is `unknown[]` by contract: the backend copies whatever the
 * provider returned and never reshapes it, and a pipeline persisted by an older
 * build can hold a shape this client no longer expects. Everything here is
 * therefore validated rather than cast — an entry that cannot be understood is
 * dropped, not rendered as raw JSON.
 */

import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { TaskListSnapshot } from "@orkestrator/protocol/task-list";
import { normalizeClaudeMessagesForDisplay } from "@/lib/chat/native-message-adapters";
import { normalizeOpenCodeMessage } from "@/lib/opencode-client";
import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";
import type {
  NativeAgentActivityPart,
  NativeAgentState,
  NativeBackgroundTask,
  NativeMessage,
  NativeMessagePart,
  NativeToolDiffMetadata,
  NativeToolInvocationPart,
  NativeToolState,
} from "@/lib/chat/native-message-types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asToolState(value: unknown): NativeToolState | undefined {
  return value === "success" || value === "failure" || value === "pending"
    ? value
    : undefined;
}

function asAgentState(value: unknown): NativeAgentState | undefined {
  return value === "active" || value === "finished" || value === "failed"
    ? value
    : undefined;
}

function asRole(value: unknown): NativeMessage["role"] | undefined {
  return value === "user" || value === "assistant" || value === "system"
    ? value
    : undefined;
}

function asBackgroundTask(value: unknown): NativeBackgroundTask | undefined {
  const raw = asRecord(value);
  const id = asString(raw?.id);
  if (!raw || !id) return undefined;
  const status = raw.status;
  return {
    id,
    description: asString(raw.description),
    ...(typeof status === "string"
      ? { status: status as NativeBackgroundTask["status"] }
      : {}),
  };
}

/** `TodoToolPart` maps over `items`, so a snapshot without one must be dropped. */
function asTaskSnapshot(value: unknown): TaskListSnapshot | undefined {
  const raw = asRecord(value);
  if (!raw || !Array.isArray(raw.items)) return undefined;
  return raw as unknown as TaskListSnapshot;
}

const PART_TYPES = new Set([
  "text",
  "thinking",
  "file",
  "tool-invocation",
  "tool-result",
  "subagent",
  "tool-group",
  "agent-group",
  "task-group",
]);

function isAgentActivityPart(
  part: NativeMessagePart,
): part is NativeAgentActivityPart {
  return part.type === "subagent" || part.type === "task-group";
}

function toNativeParts(value: unknown): NativeMessagePart[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(toNativePart)
    .filter((part): part is NativeMessagePart => part !== null);
}

/**
 * Validate one provider part into a native part.
 *
 * Fields are copied individually rather than spread: a mistyped `subagentActions`
 * or `taskSnapshot.items` would crash the renderer that maps over it, and a
 * pass-through spread is exactly how such a value would reach it.
 */
function toNativePart(value: unknown): NativeMessagePart | null {
  const raw = asRecord(value);
  const type = asString(raw?.type);
  if (!raw || !type || !PART_TYPES.has(type)) return null;

  const createdAt = asString(raw.createdAt) ?? asString(raw.timestamp);
  const base = {
    content: asString(raw.content) ?? "",
    ...(createdAt ? { createdAt } : {}),
    sourcePartId: asString(raw.sourcePartId) ?? asString(raw._messageUuid),
    sourceMessageId: asString(raw.sourceMessageId),
    fileUrl: asString(raw.fileUrl),
    toolName: asString(raw.toolName),
    toolArgs: asRecord(raw.toolArgs) ?? undefined,
    toolState: asToolState(raw.toolState),
    agentState: asAgentState(raw.agentState),
    toolTitle: asString(raw.toolTitle),
    toolOutput: asString(raw.toolOutput),
    toolError: asString(raw.toolError),
    toolDiff: (asRecord(raw.toolDiff) ?? undefined) as
      | NativeToolDiffMetadata
      | undefined,
    toolUseCount: asNumber(raw.toolUseCount),
    tokenCount: asNumber(raw.tokenCount),
    tokenCountText: asString(raw.tokenCountText),
    ...(raw.agentUsageDisplay === "token-only"
      ? { agentUsageDisplay: "token-only" as const }
      : {}),
    toolUseId: asString(raw.toolUseId),
    parentTaskUseId: asString(raw.parentTaskUseId),
    isMcpTool: raw.isMcpTool === true ? true : undefined,
    mcpServerName: asString(raw.mcpServerName),
    backgroundTask: asBackgroundTask(raw.backgroundTask),
    taskSnapshot: asTaskSnapshot(raw.taskSnapshot),
  };

  switch (type) {
    case "text":
    case "thinking":
    case "file":
    case "tool-invocation":
    case "tool-result":
      return { ...base, type };
    case "subagent":
      return {
        ...base,
        type,
        subagentId: asString(raw.subagentId),
        subagentName: asString(raw.subagentName),
        subagentRole: asString(raw.subagentRole),
        subagentPrompt: asString(raw.subagentPrompt),
        subagentActions: toNativeParts(raw.subagentActions),
        subagentActionCount: asNumber(raw.subagentActionCount),
      };
    case "tool-group": {
      const parts = toNativeParts(raw.parts);
      // An empty group still paints its border, so it is not a group at all.
      return parts.length > 0 ? { ...base, type, parts } : null;
    }
    case "agent-group": {
      const parts = toNativeParts(raw.parts).filter(isAgentActivityPart);
      return parts.length > 0 ? { ...base, type, parts } : null;
    }
    case "task-group": {
      const task = toNativePart(raw.task);
      if (task?.type !== "tool-invocation") return null;
      return {
        ...base,
        type,
        task: task as NativeToolInvocationPart,
        childTools: toNativeParts(raw.childTools),
      };
    }
    default:
      return null;
  }
}

function toClaudeParts(value: unknown): ClaudeMessagePart[] {
  if (!Array.isArray(value)) return [];
  // The Claude adapter reads the same field names this validator produces, so a
  // validated native part is a valid input to it.
  return toNativeParts(value) as unknown as ClaudeMessagePart[];
}

function hasRenderableContent(message: NativeMessage): boolean {
  return message.parts.length > 0 || message.content.trim().length > 0;
}

function messageId(raw: Record<string, unknown>, index: number): string {
  return asString(raw.id) ?? `pipeline-message-${index}`;
}

/**
 * OpenCode returns `{ info, parts }`; the Claude and Codex bridges return the
 * flat message shape. Detected per entry rather than from the pipeline's agent
 * type so a snapshot whose agent was recorded differently still renders.
 */
function isOpenCodeShaped(raw: Record<string, unknown>): boolean {
  return asRecord(raw.info) !== null;
}

export function toPipelineTranscript(
  messages: unknown[] | undefined,
  agentType: BuildPipelineAgent,
  fallbackCreatedAt: string,
): NativeMessage[] {
  const transcript: NativeMessage[] = [];

  (messages ?? []).forEach((entry, index) => {
    const raw = asRecord(entry);
    if (!raw) return;

    if (isOpenCodeShaped(raw)) {
      const message = normalizeOpenCodeMessage(entry);
      if (message && hasRenderableContent(message)) transcript.push(message);
      return;
    }

    const role = asRole(raw.role) ?? "assistant";
    const content = asString(raw.content) ?? "";
    const createdAt = asString(raw.createdAt)
      ?? asString(raw.timestamp)
      ?? fallbackCreatedAt;
    const modelId = asString(raw.modelId);

    if (agentType === "claude") {
      // Claude parts are grouped into their parent Task/Agent call and split at
      // long pauses by the same adapter the Claude tab uses.
      const claudeMessage: ClaudeMessage = {
        id: messageId(raw, index),
        role,
        content,
        parts: toClaudeParts(raw.parts),
        timestamp: createdAt,
        ...(modelId ? { modelId } : {}),
      };
      transcript.push(
        ...normalizeClaudeMessagesForDisplay([claudeMessage])
          .filter(hasRenderableContent),
      );
      return;
    }

    const message: NativeMessage = {
      id: messageId(raw, index),
      role,
      content,
      parts: toNativeParts(raw.parts),
      createdAt,
      ...(modelId ? { modelId } : {}),
      ...(asString(raw.turnId) ? { turnId: asString(raw.turnId) } : {}),
    };
    if (hasRenderableContent(message)) transcript.push(message);
  });

  return transcript;
}
