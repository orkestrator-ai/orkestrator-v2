import type { ClaudeBackgroundTask, ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";
import type {
  NativeAgentActivityPart,
  NativeAgentGroupPart,
  NativeAgentState,
  NativeBackgroundTaskStatus,
  NativeFilePart,
  NativeMessage,
  NativeMessagePart,
  NativeTaskGroupPart,
  NativeToolGroupPart,
} from "./native-message-types";
import {
  isBackgroundCapableShellTool,
  recoverBackgroundTaskLaunchId,
} from "@orkestrator/protocol/native-agent";
import { createNativeAgentSettleAnchors } from "./native-agent-pinning";
import { parseLocalFilePathFromUrl } from "./file-url";
import type { AcpMessage } from "@/lib/acp-client";

interface AttachmentTag {
  type: string;
  path: string;
  filename: string;
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    switch (entity.toLowerCase()) {
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      default: {
        const isHex = entity.toLowerCase().startsWith("&#x");
        const digits = entity.slice(isHex ? 3 : 2, -1);
        const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
    }
  });
}

function parseAttachmentTag(tagContent: string): AttachmentTag | null {
  const typeMatch = tagContent.match(/type="([^"]*)"/);
  const pathMatch = tagContent.match(/path="([^"]*)"/);
  const filenameMatch = tagContent.match(/filename="([^"]*)"/);

  const type = typeMatch?.[1] ? decodeXmlAttribute(typeMatch[1]) : undefined;
  const path = pathMatch?.[1] ? decodeXmlAttribute(pathMatch[1]) : undefined;
  const filename = filenameMatch?.[1] ? decodeXmlAttribute(filenameMatch[1]) : "";

  if (type && path) {
    return { type, path, filename };
  }
  return null;
}

export function parseNativeAttachmentsFromContent(content: string): {
  cleanContent: string;
  attachments: NativeFilePart[];
} {
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
        ...(parsed.filename ? { filename: parsed.filename } : {}),
      });
    }

    cleanContent = cleanContent.replace(block, "").trim();
  }

  return { cleanContent, attachments };
}

/**
 * True for a tool whose call launches a subagent.
 *
 * Exported because the renderer routes a promoted launch on the same answer:
 * a subagent card renders the group's captured child tools, a background-task
 * card has none to render. Two copies of this list would let those decisions
 * disagree and silently drop a child's captured activity.
 */
export function isTaskTool(toolName?: string): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return normalized === "task" || normalized === "agent" || normalized === "spawn_subagent";
}

function isToolActivity(part: NativeMessagePart): boolean {
  return part.type === "thinking" || part.type === "tool-invocation";
}

function isAgentActivity(part: NativeMessagePart): part is NativeAgentActivityPart {
  return part.type === "subagent" || part.type === "task-group";
}

export function normalizeClaudePart(part: ClaudeMessagePart): NativeMessagePart | null {
  switch (part.type) {
    case "text":
    case "thinking":
    case "file":
    case "tool-invocation":
    case "tool-result":
    case "subagent":
    case "agent-group":
    case "tool-group":
    case "task-group":
      return part;
    default:
      return null;
  }
}

/**
 * A tool row that launched a provider-owned background task.
 *
 * Only a resolved task qualifies. An unresolved launch — its snapshot aged out
 * of the provider's bounded history, or the id was never recoverable — has no
 * lifecycle and no stop target, so it stays an ordinary tool row rather than a
 * card promising controls it cannot offer.
 */
function isBackgroundTaskLaunchPart(
  part: Extract<NativeMessagePart, { type: "tool-invocation" }>,
): boolean {
  if (part.backgroundTask === undefined) return false;
  // A row that merely acts on a task by id — TaskOutput, TaskStop — is
  // decorated with the same lifecycle but launched nothing, so it stays an
  // ordinary tool row rather than becoming a second card for one task.
  if (isBackgroundTaskActionTool(part.toolName)) return false;
  return part.toolArgs?.run_in_background === true || isBackgroundCapableShellTool(part.toolName);
}

function groupTaskParts(
  parts: NativeMessagePart[],
  shouldPromote: (part: Extract<NativeMessagePart, { type: "tool-invocation" }>) => boolean,
  options: { implicitSequentialParenting: boolean },
): NativeMessagePart[] {
  const result: NativeMessagePart[] = [];
  const taskGroups = new Map<string, NativeTaskGroupPart>();
  let currentTask: NativeTaskGroupPart | null = null;

  for (const part of parts) {
    const explicitParent = part.parentTaskUseId ? taskGroups.get(part.parentTaskUseId) : undefined;
    if (explicitParent && !(part.type === "tool-invocation" && shouldPromote(part))) {
      explicitParent.childTools.push(part);
      currentTask = explicitParent;
      continue;
    }

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

    if (shouldPromote(part)) {
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
      // A background shell task reports no nested activity, so it must not
      // adopt whatever the agent happens to run next. Only a real subagent
      // launch opens a positional parent.
      currentTask = isTaskTool(part.toolName) ? taskGroup : null;
      continue;
    }

    const parentTask = options.implicitSequentialParenting ? (currentTask ?? undefined) : undefined;

    if (parentTask) {
      parentTask.childTools.push(part);
    } else {
      result.push(part);
    }
  }

  return result;
}

/**
 * Promote provider-neutral Task/Agent tool launches only when their bridge has
 * supplied an explicit child lifecycle. A plain task-named tool may be an
 * ordinary foreground operation, so its name alone is not enough outside the
 * Claude adapter.
 *
 * Resolved background-task launches are promoted too. They render as the same
 * agent card rather than a provider-specific list beside the transcript, so
 * one long-running child reads the same way whichever provider owns it.
 */
function groupNativeSubagentTaskParts(parts: NativeMessagePart[]): NativeMessagePart[] {
  return groupTaskParts(
    parts,
    (part) =>
      (isTaskTool(part.toolName) && part.agentState !== undefined) ||
      isBackgroundTaskLaunchPart(part),
    { implicitSequentialParenting: false },
  );
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

export function dedupeStreamedNativeParts(parts: NativeMessagePart[]): NativeMessagePart[] {
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
    const createdAt = latestPartCreatedAt(toolGroup);
    const group: NativeToolGroupPart = {
      type: "tool-group",
      content: "",
      parts: toolGroup,
      ...(createdAt ? { createdAt } : {}),
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
      const createdAt = latestPartCreatedAt(agentGroup);
      const group: NativeAgentGroupPart = {
        type: "agent-group",
        content: "",
        parts: agentGroup,
        ...(createdAt ? { createdAt } : {}),
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

/**
 * Reasoning with no text renders nothing, so it must be dropped before
 * grouping — otherwise it still forms a tool group and the transcript shows an
 * empty bordered block.
 */
export function dropEmptyThinkingParts(parts: NativeMessagePart[]): NativeMessagePart[] {
  return parts.filter((part) => part.type !== "thinking" || part.content.trim().length > 0);
}

/**
 * Whether a normalized message renders any visible content.
 *
 * A provider can materialize an assistant message from message-level metadata
 * alone (OpenCode's `message.updated` info payload) before any parts stream in.
 * Such a block has nothing to attribute, so the model label would flicker or
 * duplicate once the real content lands in a sibling message. Attribution
 * therefore only applies to messages this helper says carry content.
 */
export function messageHasVisibleContent(message: NativeMessage): boolean {
  if (message.content.trim().length > 0) return true;
  return message.parts.some((part) => {
    switch (part.type) {
      case "text":
      case "thinking":
        return part.content.trim().length > 0;
      // Tool results are rendered inline with their invocation, never on their
      // own, so a message holding only results is still an empty block.
      case "tool-result":
        return false;
      // Both group renderers bail out on an empty child list, so an empty group
      // is as invisible as no part at all. `groupNativeToolActivity` leaves an
      // existing `tool-group` untouched, so normalization cannot be relied on to
      // remove one first.
      case "tool-group":
      case "agent-group":
        return part.parts.length > 0;
      default:
        return true;
    }
  });
}

/**
 * The effective predecessor for block-level continuity.
 *
 * Empty assistant messages (an info-only `message.updated` before any parts
 * stream) contribute nothing to attribution, duration, or continuation, so
 * they are skipped when picking the message a row should compare itself
 * against. Without this a `user → empty → content` sequence would lose the
 * response duration (the content row would think it follows an assistant, not
 * the user), and a `content → empty → content` block would repeat the model
 * label because the immediate predecessor appears content-less. Non-assistant
 * predecessors and content-bearing assistants are returned as-is.
 */
export function findPreviousNativeMessage<TMessage extends NativeMessage>(
  messages: readonly TMessage[],
  index: number,
): TMessage | null {
  for (let i = index - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (!candidate) continue;
    if (candidate.role === "assistant" && !messageHasVisibleContent(candidate)) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * Identity cache for normalized messages.
 *
 * `normalizeNativeMessage` is pure in its input object, but the transcript
 * calls it for every message on every streaming frame. Returning a fresh
 * object each time gave every mounted row a new `message` prop and defeated
 * `memo(NativeMessage)` for the whole transcript. Stores already preserve the
 * identity of unchanged source messages (`upsertMessage` only replaces the
 * edited entry), so keying on the source object is sound: an unchanged source
 * must yield the identical normalized object, and an updated source is a new
 * object that misses the cache. WeakMap keeps this from pinning old messages.
 */
const normalizedNativeMessageCache = new WeakMap<NativeMessage, NativeMessage>();

/**
 * The file a file part points at, independent of how the provider spelled it.
 *
 * The structured part and the XML wrapper describe the same attachment with
 * different strings — `file:///w/a.png` against `/w/a.png`, or a bare
 * `a.png` content against a fully qualified URL — so comparing the raw fields
 * would render the same image twice. A `data:` URL carries no identity beyond
 * its own bytes, so those fall back to the part's content.
 */
function fileAttachmentIdentity(part: NativeFilePart): string {
  const fileUrl = part.fileUrl;
  if (fileUrl && !fileUrl.startsWith("data:")) {
    return parseLocalFilePathFromUrl(fileUrl) ?? fileUrl;
  }
  return parseLocalFilePathFromUrl(part.content) ?? part.content;
}

function normalizeNativeUserAttachments(message: NativeMessage): NativeMessage {
  if (message.role !== "user") return message;

  const parsedContent = parseNativeAttachmentsFromContent(message.content);
  let parsedAttachmentPart = false;
  const parsedParts = message.parts.flatMap((part): NativeMessagePart[] => {
    if (part.type !== "text") return [part];

    const parsed = parseNativeAttachmentsFromContent(part.content);
    if (parsed.cleanContent === part.content) return [part];

    parsedAttachmentPart = true;
    return [
      ...(parsed.cleanContent ? [{ ...part, content: parsed.cleanContent }] : []),
      ...parsed.attachments,
    ];
  });

  const contentHasAttachments = parsedContent.cleanContent !== message.content;
  if (!parsedAttachmentPart && !contentHasAttachments) return message;

  let nextParts = parsedParts;
  if (!parsedAttachmentPart) {
    const hasTextPart = nextParts.some((part) => part.type === "text");
    nextParts = [
      ...(!hasTextPart && parsedContent.cleanContent
        ? [{ type: "text" as const, content: parsedContent.cleanContent }]
        : []),
      ...nextParts,
      ...parsedContent.attachments,
    ];
  }

  // Some providers project a structured file part as well as echoing the XML
  // wrapper. Keep the first copy so initial-prompt images never render twice,
  // and merge the fields only one spelling carried.
  const fileIndexes = new Map<string, number>();
  const dedupedParts: NativeMessagePart[] = [];
  for (const part of nextParts) {
    if (part.type !== "file") {
      dedupedParts.push(part);
      continue;
    }
    const identity = fileAttachmentIdentity(part);
    const existingIndex = fileIndexes.get(identity);
    if (existingIndex === undefined) {
      fileIndexes.set(identity, dedupedParts.length);
      dedupedParts.push(part);
      continue;
    }

    const existing = dedupedParts[existingIndex];
    if (existing?.type !== "file") continue;
    // The structured copy is usually the one missing a filename, and the XML
    // copy is usually the one missing a usable URL, so neither is complete on
    // its own.
    const merged: NativeFilePart = { ...existing };
    if (!merged.filename && part.filename) merged.filename = part.filename;
    if (!merged.fileUrl && part.fileUrl) merged.fileUrl = part.fileUrl;
    dedupedParts[existingIndex] = merged;
  }
  nextParts = dedupedParts;

  return {
    ...message,
    content: parsedContent.cleanContent,
    parts: nextParts,
  };
}

export function normalizeNativeMessage(message: NativeMessage): NativeMessage {
  const cached = normalizedNativeMessageCache.get(message);
  if (cached) return cached;

  const messageWithAttachments = normalizeNativeUserAttachments(message);
  const dedupedParts = dropEmptyThinkingParts(
    dedupeStreamedNativeParts(messageWithAttachments.parts),
  );
  const normalized: NativeMessage = {
    ...messageWithAttachments,
    parts: groupNativeAgentActivity(
      groupNativeToolActivity(groupNativeSubagentTaskParts(dedupedParts)),
    ),
  };
  normalizedNativeMessageCache.set(message, normalized);
  return normalized;
}

export function normalizeNativeMessages(messages: readonly NativeMessage[]): NativeMessage[] {
  return messages.flatMap((message) =>
    splitAssistantTranscriptBlocks(normalizeNativeMessage(message)),
  );
}

export function normalizeOpenCodeNativeMessage(message: NativeMessage): NativeMessage {
  return normalizeNativeMessage(message);
}

export function normalizeCodexNativeMessage(message: NativeMessage): NativeMessage {
  return normalizeNativeMessage(message);
}

/** Normalize ACP messages for Cursor and Grok below the shared tab boundary. */
export function normalizeAcpNativeMessage(message: AcpMessage): NativeMessage {
  return normalizeNativeMessage(message);
}

/** Same identity-cache rationale as `normalizeNativeMessage`, for Claude. */
const normalizedClaudeMessageCache = new WeakMap<ClaudeMessage, NativeMessage>();

export function normalizeClaudeMessage(message: ClaudeMessage): NativeMessage {
  const cached = normalizedClaudeMessageCache.get(message);
  if (cached) return cached;
  const normalized = normalizeClaudeMessageUncached(message);
  normalizedClaudeMessageCache.set(message, normalized);
  return normalized;
}

function normalizeClaudeMessageUncached(message: ClaudeMessage): NativeMessage {
  const { cleanContent, attachments } =
    message.role === "user"
      ? parseNativeAttachmentsFromContent(message.content)
      : { cleanContent: message.content, attachments: [] };

  const rawParts =
    message.role === "user"
      ? [
          ...(cleanContent ? [{ type: "text" as const, content: cleanContent }] : []),
          ...attachments,
        ]
      : message.parts
          .map(normalizeClaudePart)
          .filter((part): part is NativeMessagePart => part !== null);

  const taskGroupedParts =
    message.role === "assistant"
      ? groupTaskParts(
          rawParts,
          (part) => isTaskTool(part.toolName) || isBackgroundTaskLaunchPart(part),
          { implicitSequentialParenting: true },
        )
      : rawParts;

  return {
    id: message.id,
    role: message.role,
    content: cleanContent,
    parts: groupNativeAgentActivity(
      groupNativeToolActivity(dropEmptyThinkingParts(dedupeStreamedNativeParts(taskGroupedParts))),
    ),
    createdAt: message.createdAt,
    ...(message.modelId ? { modelId: message.modelId } : {}),
  };
}

export function normalizeClaudeMessages(messages: ClaudeMessage[]): NativeMessage[] {
  return messages.map(normalizeClaudeMessage);
}

function backgroundTaskAgentState(
  status: ClaudeBackgroundTask["status"],
): NonNullable<ClaudeMessagePart["agentState"]> {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
      return "active";
    case "completed":
      return "finished";
    case "failed":
    case "killed":
      return "failed";
  }
}

function stringArgument(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeToolName(toolName?: string): string | undefined {
  return typeof toolName === "string" ? toolName.trim().toLowerCase() : undefined;
}

/*
 * Providers spell these tools in either casing convention, exactly as the task
 * todo tools do (`todo-tool.ts`). The argument lookups already accept both
 * `task_id` and `taskId`, so the tool-name check must not be the strict half.
 */
const BACKGROUND_TASK_STOP_TOOL_NAMES = new Set(["taskstop", "task_stop"]);
const BACKGROUND_TASK_ACTION_TOOL_NAMES = new Set([
  ...BACKGROUND_TASK_STOP_TOOL_NAMES,
  "taskoutput",
  "task_output",
]);

/** True for the tool that stops a background task, in any supported spelling. */
export function isBackgroundTaskStopTool(toolName?: string): boolean {
  const normalized = normalizeToolName(toolName);
  return normalized !== undefined && BACKGROUND_TASK_STOP_TOOL_NAMES.has(normalized);
}

/** True for any tool that acts on an existing background task by id. */
export function isBackgroundTaskActionTool(toolName?: string): boolean {
  const normalized = normalizeToolName(toolName);
  return normalized !== undefined && BACKGROUND_TASK_ACTION_TOOL_NAMES.has(normalized);
}

/**
 * The id of the background task this row launched, if it launched one.
 *
 * `backgroundTaskId` is the projection's recovery, performed before the result
 * moved behind a detail reference — which is every projected row, so it is the
 * path that actually fires in the app. The output scan still matters for
 * optimistic and bridge-direct messages that carry their result inline.
 */
function backgroundTaskIdFromLaunchOutput(
  part: Pick<ClaudeMessagePart, "backgroundTaskId" | "toolArgs" | "toolName" | "toolOutput">,
): string | undefined {
  if (part.backgroundTaskId) return part.backgroundTaskId;
  return recoverBackgroundTaskLaunchId(part);
}

/**
 * True for a tool row that owns a background task.
 *
 * An explicit `run_in_background` argument is the common case. A shell row
 * whose result named a task id is the other one: Claude backgrounds a running
 * command on Ctrl+B and on a foreground timeout, and neither can change the
 * arguments the command was launched with, so the argument alone would leave
 * both unlabelled and uncontrollable.
 */
function isBackgroundTaskLaunch(part: ClaudeMessagePart, recoveredId: string | undefined): boolean {
  if (part.type !== "tool-invocation") return false;
  return (
    part.toolArgs?.run_in_background === true ||
    (recoveredId !== undefined && isBackgroundCapableShellTool(part.toolName))
  );
}

function sameBackgroundTask(
  left: ClaudeMessagePart["backgroundTask"],
  right: ClaudeMessagePart["backgroundTask"],
): boolean {
  return (
    left?.id === right?.id &&
    left?.description === right?.description &&
    left?.status === right?.status &&
    left?.settledAt === right?.settledAt
  );
}

/**
 * Join Claude's authoritative background-task lifecycle onto the Task/Agent
 * or background command that launched it, plus later task action rows, and
 * state the lifecycle of every subagent the transcript launched.
 *
 * A background tool_result means "launched successfully", not "the task
 * finished". SDK events use `tool_use_id` as the stable launch correlation;
 * persisted Bash results provide a durable task-id fallback after restart.
 */
function settledAtField(settledAt: string | undefined): { settledAt?: string } {
  return settledAt ? { settledAt } : {};
}

/**
 * The backend's terminal edge for one task, whichever shape reported it.
 *
 * The projection carries an ISO `settledAt`; the bridge's own record carries an
 * epoch `endedAt`, which some callers still pass through directly. Only a
 * terminal task has a position: a live one belongs at the bottom, and a stale
 * edge left on a revived task would drag it back up the transcript.
 */
function backgroundTaskSettledAt(
  task:
    | {
        status?: ClaudeBackgroundTask["status"];
        endedAt?: number;
        settledAt?: string;
      }
    | undefined,
): string | undefined {
  if (!task || !task.status) return undefined;
  if (task.status === "pending" || task.status === "running" || task.status === "paused") {
    return undefined;
  }
  if (task.settledAt) return task.settledAt;
  if (typeof task.endedAt !== "number" || !Number.isFinite(task.endedAt)) return undefined;
  const endedAt = new Date(task.endedAt);
  return Number.isFinite(endedAt.getTime()) ? endedAt.toISOString() : undefined;
}

/**
 * What this decoration reads off a task record, whichever shape supplied it.
 *
 * Two shapes reach it — the bridge's own `ClaudeBackgroundTask` and the
 * projection's summary — and they agree on every field named here while
 * disagreeing elsewhere: `startedAt` is epoch milliseconds on one and an ISO
 * string on the other. Naming what is used keeps that disagreement out of a
 * function that touches neither.
 */
export interface ClaudeBackgroundTaskState {
  id: string;
  toolUseId?: string;
  description?: string;
  status: ClaudeBackgroundTask["status"];
  /** Terminal edge as the bridge records it, in epoch milliseconds. */
  endedAt?: number;
  /** Terminal edge as the projection carries it; see `settledAt` there. */
  settledAt?: string;
}

export function applyClaudeBackgroundTaskStates<TMessage extends NativeMessage>(
  messages: TMessage[],
  backgroundTasks: Record<string, ClaudeBackgroundTaskState>,
): TMessage[] {
  const tasksById = new Map<string, ClaudeBackgroundTaskState>();
  const tasksByToolUseId = new Map<string, ClaudeBackgroundTaskState>();
  for (const task of Object.values(backgroundTasks)) {
    tasksById.set(task.id, task);
    if (task.toolUseId) tasksByToolUseId.set(task.toolUseId, task);
  }

  /*
   * Transcript replay does not persist SDK task lifecycle edges on every
   * Claude version. Recover the durable task-id → launch-description join from
   * the Bash tool result so stopped rows remain named after a bridge restart.
   */
  const launchesByTaskId = new Map<
    string,
    {
      id: string;
      description?: string;
      status?: ClaudeBackgroundTask["status"];
      settledAt?: string;
    }
  >();
  let hasSubagentLaunch = false;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation") continue;
      if (isTaskTool(part.toolName) && part.agentState === undefined) {
        hasSubagentLaunch = true;
      }
      const recoveredId = backgroundTaskIdFromLaunchOutput(part);
      const authoritative =
        (part.toolUseId ? tasksByToolUseId.get(part.toolUseId) : undefined) ??
        (recoveredId ? tasksById.get(recoveredId) : undefined);
      const taskId = authoritative?.id ?? recoveredId;
      if (!taskId) continue;
      launchesByTaskId.set(taskId, {
        id: taskId,
        description: authoritative?.description ?? stringArgument(part.toolArgs, "description"),
        status: authoritative?.status,
        settledAt: backgroundTaskSettledAt(authoritative),
      });
    }
  }

  /*
   * Nothing to join and no child to describe: no authoritative snapshot, no
   * launch recoverable from the transcript, and no subagent awaiting a
   * lifecycle. Bail before the rewrite so the common case (a session that
   * delegates nothing) stays allocation-free — this memo recomputes on every
   * streamed message update.
   */
  if (tasksById.size === 0 && launchesByTaskId.size === 0 && !hasSubagentLaunch) {
    return messages;
  }

  let messagesChanged = false;
  const nextMessages = messages.map((message) => {
    let partsChanged = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool-invocation") return part;

      const isAgentTool = isTaskTool(part.toolName);
      const recoveredId = backgroundTaskIdFromLaunchOutput(part);
      const authoritativeLaunch =
        (part.toolUseId ? tasksByToolUseId.get(part.toolUseId) : undefined) ??
        (recoveredId ? tasksById.get(recoveredId) : undefined);

      let agentState = part.agentState;
      let backgroundTask = part.backgroundTask;
      if (isAgentTool && authoritativeLaunch) {
        agentState = backgroundTaskAgentState(authoritativeLaunch.status);
        backgroundTask = {
          id: authoritativeLaunch.id,
          description:
            authoritativeLaunch.description ?? stringArgument(part.toolArgs, "description"),
          status: authoritativeLaunch.status,
          ...settledAtField(backgroundTaskSettledAt(authoritativeLaunch)),
        };
      } else if (isAgentTool && agentState === undefined) {
        /*
         * A foreground subagent has no background-task record, so its own tool
         * result is the whole lifecycle. Stating it explicitly is what promotes
         * the row to the shared agent card: the grouper deliberately refuses to
         * infer a child from a task-shaped tool name alone, since other
         * providers use those names for ordinary foreground work.
         */
        agentState =
          part.toolState === "failure"
            ? "failed"
            : part.toolState === "success"
              ? "finished"
              : "active";
      }

      if (!isAgentTool && isBackgroundTaskLaunch(part, recoveredId)) {
        const launch =
          authoritativeLaunch ??
          (recoveredId ? tasksById.get(recoveredId) : undefined) ??
          (recoveredId ? launchesByTaskId.get(recoveredId) : undefined);
        if (launch) {
          backgroundTask = {
            id: launch.id,
            description: launch.description ?? stringArgument(part.toolArgs, "description"),
            status: launch.status,
            ...settledAtField(backgroundTaskSettledAt(launch)),
          };
          /*
           * The launch row's own result says the command was *accepted*, so it
           * reads "success" for the task's entire life. State the child's
           * lifecycle separately, as an agent launch does — this is what keeps
           * a running task pinned instead of scrolling away as finished work.
           */
          if (launch.status) {
            agentState = backgroundTaskAgentState(launch.status);
          }
        }
      } else if (isBackgroundTaskActionTool(part.toolName)) {
        const taskId = stringArgument(part.toolArgs, "task_id", "taskId");
        const task = taskId ? (tasksById.get(taskId) ?? launchesByTaskId.get(taskId)) : undefined;
        /*
         * Only decorate a row whose task we actually resolved. An id with no
         * launch and no snapshot behind it adds nothing the renderer cannot
         * read straight off `toolArgs`, and decorating it would churn a new
         * part object on every pass.
         */
        if (taskId && task) {
          backgroundTask = {
            id: taskId,
            description: task.description,
            status: task.status,
            ...settledAtField(backgroundTaskSettledAt(task)),
          };
        }
      }

      if (
        part.agentState === agentState &&
        sameBackgroundTask(part.backgroundTask, backgroundTask)
      ) {
        return part;
      }

      partsChanged = true;
      return {
        ...part,
        ...(agentState === undefined ? {} : { agentState }),
        ...(backgroundTask === undefined ? {} : { backgroundTask }),
      };
    });

    if (!partsChanged) return message;
    messagesChanged = true;
    return { ...message, parts } as TMessage;
  });

  return messagesChanged ? nextMessages : messages;
}

function collectBackgroundTaskIds(parts: readonly NativeMessagePart[], ids: Set<string>): void {
  for (const part of parts) {
    if (part.type === "task-group") {
      const id = part.task.backgroundTask?.id;
      if (id) ids.add(id);
      continue;
    }
    if (part.type === "agent-group" || part.type === "tool-group") {
      collectBackgroundTaskIds(part.parts, ids);
    }
  }
}

/**
 * Every background task the rendered transcript already shows a card for.
 *
 * A live task whose launch row fell outside the transcript window has no card
 * and therefore no stop control, so the tab must surface it from the
 * authoritative snapshot instead. Only promoted launches count: an action row
 * that merely names a task offers nothing to act on.
 */
export function collectRenderedBackgroundTaskIds(messages: readonly NativeMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) collectBackgroundTaskIds(message.parts, ids);
  return ids;
}

export interface BackgroundTaskSnapshot {
  id: string;
  status: NativeBackgroundTaskStatus;
  description?: string;
  /** Backend-recorded launch clock; see the protocol summary's `startedAt`. */
  startedAt?: string;
  /** Backend-recorded terminal edge; see `NativeBackgroundTask.settledAt`. */
  settledAt?: string;
}

function backgroundTaskAgentStateFromStatus(status: NativeBackgroundTaskStatus): NativeAgentState {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
      return "active";
    case "completed":
      return "finished";
    default:
      return "failed";
  }
}

/**
 * A transcript row for a task the transcript itself cannot show.
 *
 * Its launch fell outside the loaded window, or the tab resumed a session whose
 * earlier turns were trimmed, so there is no row to decorate — but the snapshot
 * still describes the task and still accepts a stop. Synthesising the row it is
 * missing puts that card in the transcript, at transcript width, under the same
 * pinning rules as every other long-running child, rather than in a wider
 * pinned strip that obeys none of them.
 *
 * The tool name is deliberately not a task tool: the renderer routes an agent
 * launch to the sub-agent card, which would advertise the tool and update counts
 * a background command never reports.
 */
function createBackgroundTaskMessage(
  task: BackgroundTaskSnapshot,
  createdAt: string,
): NativeMessage {
  // The description doubles as the part's content so the accessible activity
  // label resolves to the task's name rather than the generic child fallback.
  const label = task.description?.trim() ?? "";
  return {
    id: `background-task:${task.id}`,
    role: "assistant",
    content: "",
    createdAt,
    parts: [
      {
        type: "task-group",
        content: label,
        task: {
          type: "tool-invocation",
          content: label,
          toolName: "BackgroundTask",
          agentState: backgroundTaskAgentStateFromStatus(task.status),
          backgroundTask: {
            id: task.id,
            status: task.status,
            ...(task.description ? { description: task.description } : {}),
            ...(task.settledAt ? { settledAt: task.settledAt } : {}),
          },
        },
        childTools: [],
      },
    ],
  };
}

const EMPTY_ROWLESS_TASKS: NativeMessage[] = [];

function isLiveBackgroundTask(status: NativeBackgroundTaskStatus): boolean {
  return status === "running" || status === "pending" || status === "paused";
}

/**
 * Transcript rows for the snapshot tasks the transcript itself cannot show.
 *
 * Exactly one card per task: a task the transcript already renders is left to
 * its own row, so a launch arriving late replaces the synthesised card instead
 * of doubling it — two stop controls for one task, with nothing to tell the
 * reader which is which.
 *
 * A settled task earns a row by having a backend settle position that falls
 * inside the loaded transcript: it stopped somewhere the reader can see, so its
 * card belongs there. One that settled before any loaded message is history the
 * transcript never mentioned, and rendering it would drop a pile of finished
 * cards into a conversation that has no room for them. Both answers come from
 * the backend's own timestamps, so they do not depend on what this tab watched
 * happen.
 */
export function rowlessBackgroundTaskMessages(
  tasks: readonly BackgroundTaskSnapshot[],
  messages: readonly NativeMessage[],
): NativeMessage[] {
  if (tasks.length === 0) return EMPTY_ROWLESS_TASKS;

  const rendered = collectRenderedBackgroundTaskIds(messages);
  const anchors = createNativeAgentSettleAnchors(messages);
  const rows = tasks.filter(
    (task) =>
      !rendered.has(task.id) &&
      (isLiveBackgroundTask(task.status) || anchors.resolve(task.settledAt) !== undefined),
  );
  if (rows.length === 0) return EMPTY_ROWLESS_TASKS;

  return rows.map((task) =>
    createBackgroundTaskMessage(
      task,
      /*
       * A live card sits at the bottom, so it takes the newest row's clock — the
       * one belonging to the position it actually holds. A settled one is placed
       * by its own settle position, and carrying that as the row's timestamp
       * keeps the header honest about when it stopped.
       *
       * A tab that resumed into a running task has neither: it has the snapshot
       * before it has a transcript. Its own launch clock is then the only honest
       * answer, and is why the snapshot carries one — without it this fell to the
       * epoch, and the card claimed to have started in 1970.
       *
       * The epoch remains only because a row must carry some clock and a provider
       * that reports neither leaves nothing to carry. Every task the Claude
       * bridge reports has a `startedAt`, so that last resort is not a path this
       * renders in practice.
       */
      task.settledAt ?? messages.at(-1)?.createdAt ?? task.startedAt ?? new Date(0).toISOString(),
    ),
  );
}

interface TranscriptBlockSegment {
  parts: NativeMessagePart[];
  firstPartIndex: number;
}

function parseTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function latestPartCreatedAt(parts: readonly NativeMessagePart[]): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  const consider = (value?: string) => {
    const timestamp = parseTimestamp(value);
    if (timestamp !== undefined && timestamp >= latestMs) {
      latestMs = timestamp;
      latest = value;
    }
  };
  for (const part of parts) {
    consider(part.createdAt);
    if (part.type === "tool-group" || part.type === "agent-group") {
      for (const child of part.parts) consider(child.createdAt);
    }
    if (part.type === "task-group") {
      consider(part.task.createdAt);
      for (const child of part.childTools) consider(child.createdAt);
    }
  }
  return latest;
}

function isTextSectionPart(part: NativeMessagePart): boolean {
  return part.type === "text" || part.type === "file";
}

/**
 * Identity cache for split display rows. Without it a long assistant turn that
 * splits into several rows would mint new row objects every render, undoing
 * the normalization cache for exactly the transcripts big enough to care.
 */
const splitAssistantTranscriptBlocksCache = new WeakMap<NativeMessage, NativeMessage[]>();

/**
 * Split an assistant turn into separately timestamped transcript rows.
 *
 * A run of text (or files) is one section. Tool, reasoning, and agent activity
 * is another. Crossing that boundary ends the current section so each block
 * can show when it was sent, plus its own copy/fork actions.
 */
export function splitAssistantTranscriptBlocks(message: NativeMessage): NativeMessage[] {
  const cached = splitAssistantTranscriptBlocksCache.get(message);
  if (cached) return cached;
  const rows = splitAssistantTranscriptBlocksUncached(message);
  splitAssistantTranscriptBlocksCache.set(message, rows);
  return rows;
}

/** @deprecated Use {@link splitAssistantTranscriptBlocks}. */
export function splitClaudeAssistantTextBlocks(message: NativeMessage): NativeMessage[] {
  return splitAssistantTranscriptBlocks(message);
}

function splitAssistantTranscriptBlocksUncached(message: NativeMessage): NativeMessage[] {
  if (message.role !== "assistant") return [message];

  const segments: TranscriptBlockSegment[] = [];
  let current: TranscriptBlockSegment | null = null;
  let currentIsText: boolean | null = null;

  const finishCurrentSegment = () => {
    if (current && current.parts.length > 0) segments.push(current);
    current = null;
    currentIsText = null;
  };

  for (let index = 0; index < message.parts.length; index += 1) {
    const part = message.parts[index]!;
    const isText = isTextSectionPart(part);
    if (current && currentIsText !== isText) finishCurrentSegment();
    if (!current) {
      current = { parts: [], firstPartIndex: index };
      currentIsText = isText;
    }
    current.parts.push(part);
  }
  finishCurrentSegment();
  if (segments.length <= 1) {
    const createdAt = latestPartCreatedAt(message.parts) ?? message.createdAt;
    if (createdAt === message.createdAt) return [message];
    return [{ ...message, createdAt }];
  }

  return segments.map((segment, index) => ({
    ...message,
    id: index === 0 ? message.id : `${message.id}:text-block:${segment.firstPartIndex}`,
    content: segment.parts
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join(""),
    parts: segment.parts,
    createdAt: latestPartCreatedAt(segment.parts) ?? message.createdAt,
  }));
}

/**
 * Claude-specific display normalization. Unlike the provider-neutral
 * normalizer, this may expand one long assistant turn into multiple transcript
 * rows so each text and tool section receives its own timestamp and copy action.
 */
export function normalizeClaudeMessagesForDisplay(messages: ClaudeMessage[]): NativeMessage[] {
  return messages.flatMap((message) =>
    splitAssistantTranscriptBlocks(normalizeClaudeMessage(message)),
  );
}

/** Resolve a timestamp-split display row back to its persisted message. */
export function getNativeSourceMessageId(messageId: string): string {
  const splitMarker = messageId.indexOf(":text-block:");
  return splitMarker < 0 ? messageId : messageId.slice(0, splitMarker);
}

/** @deprecated Use {@link getNativeSourceMessageId}. */
export function getClaudeSourceMessageId(messageId: string): string {
  return getNativeSourceMessageId(messageId);
}
