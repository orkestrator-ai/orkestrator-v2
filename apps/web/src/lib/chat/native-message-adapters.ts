import type {
  ClaudeBackgroundTask,
  ClaudeMessage,
  ClaudeMessagePart,
} from "@/lib/claude-client";
import type {
  NativeAgentActivityPart,
  NativeAgentGroupPart,
  NativeFilePart,
  NativeMessage,
  NativeMessagePart,
  NativeTaskGroupPart,
  NativeToolGroupPart,
} from "./native-message-types";
import { parseLocalFilePathFromUrl } from "./file-url";
import type { AcpMessage } from "@/lib/acp-client";

interface AttachmentTag {
  type: string;
  path: string;
  filename: string;
}

function decodeXmlAttribute(value: string): string {
  return value.replace(
    /&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      switch (entity.toLowerCase()) {
        case "&quot;": return '"';
        case "&apos;": return "'";
        case "&amp;": return "&";
        case "&lt;": return "<";
        case "&gt;": return ">";
        default: {
          const isHex = entity.toLowerCase().startsWith("&#x");
          const digits = entity.slice(isHex ? 3 : 2, -1);
          const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
          return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : entity;
        }
      }
    },
  );
}

function parseAttachmentTag(tagContent: string): AttachmentTag | null {
  const typeMatch = tagContent.match(/type="([^"]*)"/);
  const pathMatch = tagContent.match(/path="([^"]*)"/);
  const filenameMatch = tagContent.match(/filename="([^"]*)"/);

  const type = typeMatch?.[1] ? decodeXmlAttribute(typeMatch[1]) : undefined;
  const path = pathMatch?.[1] ? decodeXmlAttribute(pathMatch[1]) : undefined;
  const filename = filenameMatch?.[1]
    ? decodeXmlAttribute(filenameMatch[1])
    : "";

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
        ...(parsed.filename ? { filename: parsed.filename } : {}),
      });
    }

    cleanContent = cleanContent.replace(block, "").trim();
  }

  return { cleanContent, attachments };
}

function isTaskTool(toolName?: string): boolean {
  const normalized = toolName?.toLowerCase();
  return normalized === "task"
    || normalized === "agent"
    || normalized === "spawn_subagent";
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

function groupTaskParts(
  parts: NativeMessagePart[],
  shouldGroup: (part: Extract<NativeMessagePart, { type: "tool-invocation" }>) => boolean,
): NativeMessagePart[] {
  const result: NativeMessagePart[] = [];
  const taskGroups = new Map<string, NativeTaskGroupPart>();
  let currentTask: NativeTaskGroupPart | null = null;

  for (const part of parts) {
    const explicitParent = part.parentTaskUseId
      ? taskGroups.get(part.parentTaskUseId)
      : undefined;
    if (explicitParent && !(part.type === "tool-invocation" && isTaskTool(part.toolName))) {
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

    if (isTaskTool(part.toolName) && shouldGroup(part)) {
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

    const parentTask = currentTask ?? undefined;

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
 */
function groupNativeSubagentTaskParts(parts: NativeMessagePart[]): NativeMessagePart[] {
  return groupTaskParts(parts, (part) => part.agentState !== undefined);
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

/**
 * Reasoning with no text renders nothing, so it must be dropped before
 * grouping — otherwise it still forms a tool group and the transcript shows an
 * empty bordered block.
 */
export function dropEmptyThinkingParts(
  parts: NativeMessagePart[],
): NativeMessagePart[] {
  return parts.filter(
    (part) => part.type !== "thinking" || part.content.trim().length > 0,
  );
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
  return messages.map(normalizeNativeMessage);
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
    ? groupTaskParts(rawParts, () => true)
    : rawParts;

  return {
    id: message.id,
    role: message.role,
    content: cleanContent,
    parts: groupNativeAgentActivity(
      groupNativeToolActivity(
        dropEmptyThinkingParts(dedupeStreamedNativeParts(taskGroupedParts)),
      ),
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

function isBackgroundTaskLaunch(part: ClaudeMessagePart): boolean {
  return (
    part.type === "tool-invocation"
    && part.toolArgs?.run_in_background === true
  );
}

/*
 * Claude emits three different notes when a command ends up in the background,
 * and all three carry the same durable id:
 *   "Command running in background with ID: <id>. …"
 *   "Command was manually backgrounded by user with ID: <id>"
 *   "…timeout and was moved to the background (ID: <id>). …"
 * Matching only the first would leave Ctrl+B and timeout-backgrounded commands
 * unnamed and unlabelled after a transcript rehydration.
 */
const LAUNCH_TASK_ID_PATTERN =
  /\bbackground(?:ed by user)?\s*(?:with ID:|\(ID:)\s*([^\s.)]+)/i;

function backgroundTaskIdFromLaunchOutput(output?: string): string | undefined {
  if (!output) return undefined;

  const textMatch = output.match(LAUNCH_TASK_ID_PATTERN);
  if (textMatch?.[1]) return textMatch[1];

  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return stringArgument(parsed, "backgroundTaskId", "task_id", "taskId");
  } catch {
    return undefined;
  }
}

function sameBackgroundTask(
  left: ClaudeMessagePart["backgroundTask"],
  right: ClaudeMessagePart["backgroundTask"],
): boolean {
  return (
    left?.id === right?.id
    && left?.description === right?.description
    && left?.status === right?.status
  );
}

/**
 * Join Claude's authoritative background-task lifecycle onto the Task/Agent
 * or background command that launched it, plus later task action rows.
 *
 * A background tool_result means "launched successfully", not "the task
 * finished". SDK events use `tool_use_id` as the stable launch correlation;
 * persisted Bash results provide a durable task-id fallback after restart.
 */
export function applyClaudeBackgroundTaskStates(
  messages: ClaudeMessage[],
  backgroundTasks: Record<string, ClaudeBackgroundTask>,
): ClaudeMessage[] {
  const tasksById = new Map<string, ClaudeBackgroundTask>();
  const tasksByToolUseId = new Map<string, ClaudeBackgroundTask>();
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
    { id: string; description?: string; status?: ClaudeBackgroundTask["status"] }
  >();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation") continue;
      const authoritative = part.toolUseId
        ? tasksByToolUseId.get(part.toolUseId)
        : undefined;
      const recoveredId = isBackgroundTaskLaunch(part)
        ? backgroundTaskIdFromLaunchOutput(part.toolOutput)
        : undefined;
      const taskId = authoritative?.id ?? recoveredId;
      if (!taskId) continue;
      launchesByTaskId.set(taskId, {
        id: taskId,
        description:
          authoritative?.description
          ?? stringArgument(part.toolArgs, "description"),
        status: authoritative?.status,
      });
    }
  }

  /*
   * Nothing to join: no authoritative snapshot and no launch recoverable from
   * the transcript. Bail before the rewrite so the common case (a session with
   * no background work at all) stays allocation-free — this memo recomputes on
   * every streamed message update.
   */
  if (tasksById.size === 0 && launchesByTaskId.size === 0) return messages;

  let messagesChanged = false;
  const nextMessages = messages.map((message) => {
    let partsChanged = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool-invocation") return part;

      const isAgentTool = isTaskTool(part.toolName);
      const authoritativeLaunch = part.toolUseId
        ? tasksByToolUseId.get(part.toolUseId)
        : undefined;

      let agentState = part.agentState;
      if (isAgentTool && authoritativeLaunch) {
        agentState = backgroundTaskAgentState(authoritativeLaunch.status);
      }

      let backgroundTask = part.backgroundTask;
      if (!isAgentTool && isBackgroundTaskLaunch(part)) {
        const recoveredId = backgroundTaskIdFromLaunchOutput(part.toolOutput);
        const launch =
          authoritativeLaunch
          ?? (recoveredId ? tasksById.get(recoveredId) : undefined)
          ?? (recoveredId ? launchesByTaskId.get(recoveredId) : undefined);
        if (launch) {
          backgroundTask = {
            id: launch.id,
            description:
              launch.description
              ?? stringArgument(part.toolArgs, "description"),
            status: launch.status,
          };
        }
      } else if (isBackgroundTaskActionTool(part.toolName)) {
        const taskId = stringArgument(part.toolArgs, "task_id", "taskId");
        const task = taskId
          ? tasksById.get(taskId) ?? launchesByTaskId.get(taskId)
          : undefined;
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
          };
        }
      }

      if (
        part.agentState === agentState
        && sameBackgroundTask(part.backgroundTask, backgroundTask)
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
    return { ...message, parts };
  });

  return messagesChanged ? nextMessages : messages;
}

const CLAUDE_TEXT_BLOCK_GROUP_WINDOW_MS = 2 * 60 * 1000;

interface ClaudeTextBlockSegment {
  parts: NativeMessagePart[];
  firstTextAt?: string;
  firstTextAtMs?: number;
  firstPartIndex: number;
}

function parseTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Split a long-running Claude assistant turn into separately timestamped
 * transcript rows. A text block can start a new row only after intervening
 * tool/reasoning activity and only when it arrives more than two minutes after
 * the first text block in the current row.
 */
/**
 * Identity cache for split display rows. Without it a long assistant turn that
 * splits into several rows would mint new row objects every render, undoing
 * the normalization cache for exactly the transcripts big enough to care.
 */
const splitClaudeTextBlocksCache = new WeakMap<NativeMessage, NativeMessage[]>();

export function splitClaudeAssistantTextBlocks(
  message: NativeMessage,
): NativeMessage[] {
  const cached = splitClaudeTextBlocksCache.get(message);
  if (cached) return cached;
  const rows = splitClaudeAssistantTextBlocksUncached(message);
  splitClaudeTextBlocksCache.set(message, rows);
  return rows;
}

function splitClaudeAssistantTextBlocksUncached(
  message: NativeMessage,
): NativeMessage[] {
  if (message.role !== "assistant") return [message];

  const segments: ClaudeTextBlockSegment[] = [];
  let current: ClaudeTextBlockSegment = {
    parts: [],
    firstPartIndex: 0,
  };
  let hasText = false;
  let hasBoundarySinceText = false;

  const finishCurrentSegment = () => {
    if (current.parts.length > 0) segments.push(current);
  };

  for (let index = 0; index < message.parts.length; index += 1) {
    const part = message.parts[index]!;

    if (part.type !== "text") {
      current.parts.push(part);
      if (hasText) hasBoundarySinceText = true;
      continue;
    }

    const partTimestamp = parseTimestamp(part.createdAt);
    const shouldStartNewSegment =
      hasText &&
      hasBoundarySinceText &&
      current.firstTextAtMs !== undefined &&
      partTimestamp !== undefined &&
      partTimestamp - current.firstTextAtMs >
        CLAUDE_TEXT_BLOCK_GROUP_WINDOW_MS;

    if (shouldStartNewSegment) {
      finishCurrentSegment();
      current = {
        parts: [],
        firstTextAt: part.createdAt,
        firstTextAtMs: partTimestamp,
        firstPartIndex: index,
      };
      hasText = false;
    }

    current.parts.push(part);
    if (!hasText) {
      current.firstTextAt = part.createdAt;
      current.firstTextAtMs = partTimestamp;
    }
    hasText = true;
    hasBoundarySinceText = false;
  }

  finishCurrentSegment();
  if (segments.length <= 1) return [message];

  return segments.map((segment, index) => ({
    ...message,
    id:
      index === 0
        ? message.id
        : `${message.id}:text-block:${segment.firstPartIndex}`,
    content: segment.parts
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join(""),
    parts: segment.parts,
    createdAt:
      index === 0
        ? message.createdAt
        : segment.firstTextAt ?? message.createdAt,
  }));
}

/**
 * Claude-specific display normalization. Unlike the provider-neutral
 * normalizer, this may expand one long assistant turn into multiple transcript
 * rows so each delayed text block receives its own timestamp and copy action.
 */
export function normalizeClaudeMessagesForDisplay(
  messages: ClaudeMessage[],
): NativeMessage[] {
  return messages.flatMap((message) =>
    splitClaudeAssistantTextBlocks(normalizeClaudeMessage(message)),
  );
}

/** Resolve a timestamp-split display row back to its persisted Claude message. */
export function getClaudeSourceMessageId(messageId: string): string {
  const splitMarker = messageId.indexOf(":text-block:");
  return splitMarker < 0 ? messageId : messageId.slice(0, splitMarker);
}
