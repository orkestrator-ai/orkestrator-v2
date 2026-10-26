import type { ClaudeBackgroundTask, ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-types";
import type {
  NativeAgentActivityPart,
  NativeAgentGroupPart,
  NativeAgentState,
  NativeBackgroundTask,
  NativeBackgroundTaskStatus,
  NativeFilePart,
  NativeImagePart,
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
import {
  extractMarkedAttachmentReferences,
  stripInitialPromptAttachmentReferences,
} from "@orkestrator/protocol/initial-prompt-attachments";
import { parsePromptTranscriptReferences } from "./transcript-annotations";
import { agentMailToolCall } from "./agent-mail-tool-call";
import { dedupeArtifactPublications } from "./artifact-publication-dedupe";

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

type AttachmentPart = NativeFilePart | NativeImagePart;

function isAttachmentPart(part: NativeMessagePart): part is AttachmentPart {
  return part.type === "file" || (part.type === "image" && part.imageSource === "attachment");
}

function attachmentReference(part: AttachmentPart): { name: string; path: string } {
  const path = fileAttachmentIdentity(part);
  const pathWithoutTrailingSeparators = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(
    pathWithoutTrailingSeparators.lastIndexOf("/"),
    pathWithoutTrailingSeparators.lastIndexOf("\\"),
  );
  return {
    name: part.filename || pathWithoutTrailingSeparators.slice(separatorIndex + 1),
    path,
  };
}

function parseNativeUserContent(
  content: string,
  structuredAttachments: readonly AttachmentPart[] = [],
): {
  cleanContent: string;
  parts: NativeMessagePart[];
} {
  const parsedReferences = parsePromptTranscriptReferences(content);
  const parsedAttachments = parseNativeAttachmentsFromContent(parsedReferences.cleanPrompt);
  const markedReferences = extractMarkedAttachmentReferences(parsedAttachments.cleanContent);
  const knownAttachments = [...structuredAttachments, ...parsedAttachments.attachments];
  const knownIdentities = new Set(knownAttachments.map(fileAttachmentIdentity));
  const referencedAttachments: NativeFilePart[] = [];
  for (const { name, path } of markedReferences.attachments) {
    const identity = parseLocalFilePathFromUrl(path) ?? path;
    // Inline/deferred attachments may retain only a bare filename. Match that
    // spelling only when it identifies a single marked reference; equal
    // basenames in different directories must remain separate attachments.
    const matchingBareName = knownAttachments.some((part) => {
      const known = fileAttachmentIdentity(part);
      return (
        known === name &&
        !/[\\/]/.test(known) &&
        markedReferences.attachments.filter((reference) => reference.name === name).length === 1
      );
    });
    if (knownIdentities.has(identity) || matchingBareName) continue;
    referencedAttachments.push({ type: "file", content: path, filename: name });
    knownIdentities.add(identity);
  }
  return {
    cleanContent: stripInitialPromptAttachmentReferences(
      markedReferences.prompt,
      knownAttachments.map(attachmentReference),
    ),
    parts: [
      ...parsedAttachments.attachments,
      ...referencedAttachments,
      ...parsedReferences.references.map((reference) => ({
        type: "transcript-reference" as const,
        content: reference.selectedText,
        reference: reference.reference,
        ...(reference.userComment ? { comment: reference.userComment } : {}),
      })),
    ],
  };
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

/**
 * A mail call is a message, not tool activity: it stays out of the collapsed
 * tool group so what an agent sent or read is visible in the transcript.
 */
function isAgentMailActivity(part: NativeMessagePart): boolean {
  return part.type === "tool-invocation" && !part.toolDenied && agentMailToolCall(part) !== null;
}

function isAgentActivity(part: NativeMessagePart): part is NativeAgentActivityPart {
  return part.type === "subagent" || part.type === "task-group";
}

export function normalizeClaudePart(part: ClaudeMessagePart): NativeMessagePart | null {
  switch (part.type) {
    case "text":
    case "transcript-reference":
    case "async-question":
    case "thinking":
    case "file":
    case "tool-invocation":
    case "tool-result":
    case "subagent":
    case "agent-group":
    case "tool-group":
    case "task-group":
    // A published artifact is a first-class transcript part, never tool activity.
    case "artifact":
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
    // Artifact publications stay visible at the top level: a task group never
    // adopts one, even when the publishing call ran inside a subagent.
    const explicitParent =
      part.parentTaskUseId && part.type !== "artifact"
        ? taskGroups.get(part.parentTaskUseId)
        : undefined;
    if (explicitParent && !(part.type === "tool-invocation" && shouldPromote(part))) {
      explicitParent.childTools.push(part);
      currentTask = explicitParent;
      continue;
    }

    if (
      part.type === "text" ||
      part.type === "transcript-reference" ||
      part.type === "async-question" ||
      part.type === "file" ||
      part.type === "artifact"
    ) {
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

    if (isAgentMailActivity(part)) {
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
      case "async-question":
        return part.asyncQuestion.questions.length > 0;
      // A published artifact always renders a card (at least its summary).
      case "artifact":
        return true;
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
function fileAttachmentIdentity(part: AttachmentPart): string {
  const fileUrl = part.fileUrl;
  if (fileUrl && !fileUrl.startsWith("data:")) {
    return parseLocalFilePathFromUrl(fileUrl) ?? fileUrl;
  }
  return parseLocalFilePathFromUrl(part.content) ?? part.content;
}

function normalizeNativeUserPresentation(message: NativeMessage): NativeMessage {
  if (message.role !== "user") return message;

  const structuredAttachments = message.parts.filter(isAttachmentPart);
  const parsedContent = parseNativeUserContent(message.content, structuredAttachments);
  let parsedPresentationPart = false;
  const parsedParts = message.parts.flatMap((part): NativeMessagePart[] => {
    if (part.type !== "text") return [part];

    const parsed = parseNativeUserContent(part.content, structuredAttachments);
    if (parsed.cleanContent === part.content) return [part];

    parsedPresentationPart = true;
    return [
      ...(parsed.cleanContent ? [{ ...part, content: parsed.cleanContent }] : []),
      ...parsed.parts,
    ];
  });

  const contentHasPresentationObjects = parsedContent.cleanContent !== message.content;
  if (!parsedPresentationPart && !contentHasPresentationObjects) return message;

  let nextParts = parsedParts;
  if (!parsedPresentationPart) {
    const hasTextPart = nextParts.some((part) => part.type === "text");
    nextParts = [
      ...(!hasTextPart && parsedContent.cleanContent
        ? [{ type: "text" as const, content: parsedContent.cleanContent }]
        : []),
      ...nextParts,
      ...parsedContent.parts,
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

  const messageWithPresentation = normalizeNativeUserPresentation(message);
  const dedupedParts = dropEmptyThinkingParts(
    dedupeStreamedNativeParts(messageWithPresentation.parts),
  );
  const normalized: NativeMessage = {
    ...messageWithPresentation,
    parts: groupNativeAgentActivity(
      groupNativeToolActivity(groupNativeSubagentTaskParts(dedupedParts)),
    ),
  };
  normalizedNativeMessageCache.set(message, normalized);
  return normalized;
}

export function normalizeNativeMessages(messages: readonly NativeMessage[]): NativeMessage[] {
  const rows = dedupeArtifactPublications(messages).flatMap((message) =>
    splitAssistantTranscriptBlocks(normalizeNativeMessage(message)),
  );
  return coalesceAdjacentToolMessages(rows);
}

function isMergeableToolPart(part: NativeMessagePart): boolean {
  return (
    part.type === "thinking" ||
    part.type === "tool-invocation" ||
    part.type === "tool-group" ||
    part.type === "subagent" ||
    part.type === "task-group" ||
    part.type === "agent-group"
  );
}

function isToolOnlyAssistantMessage(message: NativeMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.content.trim().length > 0) return false;
  if (message.parts.length === 0) return false;
  if (!messageHasVisibleContent(message)) return false;
  return message.parts.every(isMergeableToolPart);
}

function flattenMergeableParts(parts: readonly NativeMessagePart[]): NativeMessagePart[] {
  const flat: NativeMessagePart[] = [];
  for (const part of parts) {
    if (part.type === "tool-group" || part.type === "agent-group") {
      flat.push(...part.parts);
    } else {
      flat.push(part);
    }
  }
  return flat;
}

function latestMessageCreatedAt(a: string, b: string): string {
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
    return bMs >= aMs ? b : a;
  }
  return b || a;
}

const coalescedMessageCache = new WeakMap<NativeMessage, WeakMap<NativeMessage, NativeMessage>>();

function mergeAdjacentToolMessages(previous: NativeMessage, message: NativeMessage): NativeMessage {
  const cachedForPrevious = coalescedMessageCache.get(previous);
  const cached = cachedForPrevious?.get(message);
  if (cached) return cached;

  const regrouped = groupNativeAgentActivity(
    groupNativeToolActivity(
      flattenMergeableParts(previous.parts).concat(flattenMergeableParts(message.parts)),
    ),
  );
  const result: NativeMessage = {
    ...previous,
    parts: regrouped,
    content: "",
    createdAt: latestMessageCreatedAt(previous.createdAt, message.createdAt),
    latestSourceMessageId: getNativeMessageBoundarySourceId(message),
    earliestSourceMessageId: previous.earliestSourceMessageId ?? previous.id,
    settleAnchorCreatedAt: previous.settleAnchorCreatedAt ?? previous.createdAt,
  };
  const resultCache = cachedForPrevious ?? new WeakMap<NativeMessage, NativeMessage>();
  resultCache.set(message, result);
  if (!cachedForPrevious) coalescedMessageCache.set(previous, resultCache);
  return result;
}

/**
 * Merge consecutive tool-only assistant rows into one block.
 *
 * OpenCode (and other bridges) can emit each tool call as its own backend
 * message. Within a message tools are already grouped into a single
 * `tool-group` card, but across messages each row renders its own card — so a
 * burst of Reads shows as several one-row blocks. When there is no text in
 * between, readers experience it as one block, so display it as one. Timing
 * is deliberately ignored: a slow tool must not split a collapsed tool block
 * just because the clock rolled over to the next minute.
 */
/**
 * The row id each source message was last displayed under inside a coalesced
 * tool run. A run keeps that id while any member survives, so history paging
 * that merges older calls in front (or live calls behind) does not rename the
 * row — which would remount it and reset everything the reader opened inside.
 * Weakly held: a member that leaves the projection takes its alias with it.
 */
const coalescedRowAliases = new WeakMap<NativeMessage, string>();
const renamedCoalescedRows = new WeakMap<NativeMessage, Map<string, NativeMessage>>();

function withRowId(row: NativeMessage, id: string): NativeMessage {
  if (row.id === id) return row;
  let byId = renamedCoalescedRows.get(row);
  if (!byId) {
    byId = new Map();
    renamedCoalescedRows.set(row, byId);
  }
  let renamed = byId.get(id);
  if (!renamed) {
    renamed = { ...row, id };
    byId.set(id, renamed);
  }
  return renamed;
}

/**
 * Surviving row ids for a projection whose source objects are rebuilt on
 * every read (a reviewer transcript parsed from raw records), keyed by member
 * message id. Owned by the view that renders the projection and pruned to it
 * on every pass, so it is bounded by the loaded history.
 */
export type CoalescedRowAliases = Map<string, string>;

/** Give each coalesced run its surviving id; never two rows one id. */
function assignCoalescedRowIds(
  merged: NativeMessage[],
  members: NativeMessage[][],
  byId: CoalescedRowAliases | undefined,
): void {
  const used = new Set<string>();
  members.forEach((group, index) => {
    if (group.length < 2) used.add(merged[index]!.id);
  });
  members.forEach((group, index) => {
    if (group.length < 2) return;
    let id: string | undefined;
    for (const member of group) {
      const alias = byId ? byId.get(member.id) : coalescedRowAliases.get(member);
      if (alias !== undefined && !used.has(alias)) {
        id = alias;
        break;
      }
    }
    id ??= used.has(merged[index]!.id) ? group.at(-1)!.id : merged[index]!.id;
    used.add(id);
    for (const member of group) {
      if (byId) byId.set(member.id, id);
      else coalescedRowAliases.set(member, id);
    }
    merged[index] = withRowId(merged[index]!, id);
  });
  if (byId) {
    const present = new Set(members.flatMap((group) => group.map((member) => member.id)));
    for (const key of Array.from(byId.keys())) if (!present.has(key)) byId.delete(key);
  }
}

export function coalesceAdjacentToolMessages(
  messages: readonly NativeMessage[],
  aliases?: CoalescedRowAliases,
): NativeMessage[] {
  const merged: NativeMessage[] = [];
  const members: NativeMessage[][] = [];
  for (const message of messages) {
    if (message.role === "assistant" && !messageHasVisibleContent(message)) {
      continue;
    }
    const previous = merged.at(-1);
    if (
      previous &&
      isToolOnlyAssistantMessage(previous) &&
      isToolOnlyAssistantMessage(message) &&
      previous.modelId === message.modelId &&
      previous.turnId === message.turnId &&
      /*
       * Every step row of a plan-mode turn carries the flag, so steps of one
       * plan turn still merge. A flagged row never merges into an unflagged
       * one: the merged row keeps the first row's flag, and the plan-review
       * controls read it off the latest assistant row.
       */
      (previous.planReview === true) === (message.planReview === true)
    ) {
      merged[merged.length - 1] = mergeAdjacentToolMessages(previous, message);
      members[members.length - 1]!.push(message);
      continue;
    }
    merged.push(message);
    members.push([message]);
  }
  assignCoalescedRowIds(merged, members, aliases);
  return merged;
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
  if (message.role === "user") {
    return normalizeNativeMessage({
      id: message.id,
      role: message.role,
      content: message.content,
      parts: [
        ...(message.content ? [{ type: "text" as const, content: message.content }] : []),
        ...message.parts
          .filter((part) => part.type !== "text")
          .map(normalizeClaudePart)
          .filter((part): part is NativeMessagePart => part !== null),
      ],
      createdAt: message.createdAt,
      ...(message.modelId ? { modelId: message.modelId } : {}),
    });
  }
  const cleanContent = message.content;
  const rawParts = message.parts
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
    left?.startedAt === right?.startedAt &&
    left?.settledAt === right?.settledAt &&
    BACKGROUND_TASK_DETAIL_KEYS.every((key) => key === "usage" || left?.[key] === right?.[key]) &&
    left?.usage?.totalTokens === right?.usage?.totalTokens &&
    left?.usage?.toolUses === right?.usage?.toolUses &&
    left?.usage?.durationMs === right?.usage?.durationMs
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

function startedAtField(startedAt: string | undefined): { startedAt?: string } {
  return startedAt ? { startedAt } : {};
}

type BackgroundTaskDetails = Pick<
  NativeBackgroundTask,
  | "error"
  | "summary"
  | "outputFile"
  | "usage"
  | "agentRole"
  | "kind"
  | "parentTaskId"
  | "prompt"
  | "command"
  | "outputTail"
  | "workflowName"
  | "lastToolName"
  | "progressSummary"
  | "pausedMs"
  | "endReason"
>;

const BACKGROUND_TASK_DETAIL_KEYS = [
  "error",
  "summary",
  "outputFile",
  "usage",
  "agentRole",
  "kind",
  "parentTaskId",
  "prompt",
  "command",
  "outputTail",
  "workflowName",
  "lastToolName",
  "progressSummary",
  "pausedMs",
  "endReason",
] as const satisfies ReadonlyArray<keyof BackgroundTaskDetails>;

/** What the task's record says beyond its lifecycle, carrying only fields it has. */
function backgroundTaskDetails(task: BackgroundTaskDetails | undefined): BackgroundTaskDetails {
  if (!task) return {};
  const details: Record<string, unknown> = {};
  for (const key of BACKGROUND_TASK_DETAIL_KEYS) {
    if (task[key]) details[key] = task[key];
  }
  return details as BackgroundTaskDetails;
}

function backgroundTaskStartedAt(
  task: { startedAt?: number | string } | undefined,
): string | undefined {
  if (!task || task.startedAt === undefined) return undefined;
  const epoch = typeof task.startedAt === "number" ? task.startedAt : Date.parse(task.startedAt);
  if (!Number.isFinite(epoch)) return undefined;
  /*
   * A finite epoch can still sit outside the range `Date` represents — a bridge
   * reporting nanoseconds is enough — and `toISOString` throws there rather than
   * returning anything. This runs inside the decoration memo on the render path,
   * so an unguarded throw would take the whole transcript down to lose one
   * timer. Same guard `backgroundTaskSettledAt` uses below.
   */
  const date = new Date(epoch);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
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
  /** Launch edge, in bridge epoch milliseconds or projection ISO form. */
  startedAt?: number | string;
  /** Terminal edge as the bridge records it, in epoch milliseconds. */
  endedAt?: number;
  /** Terminal edge as the projection carries it; see `settledAt` there. */
  settledAt?: string;
  error?: string;
  summary?: string;
  outputFile?: string;
  usage?: NativeBackgroundTask["usage"];
  /** Projection only; see the protocol summary's `agentRole`. */
  agentRole?: string;
  kind?: NativeBackgroundTask["kind"];
  parentTaskId?: string;
  prompt?: string;
  command?: string;
  outputTail?: string;
  workflowName?: string;
  lastToolName?: string;
  progressSummary?: string;
  pausedMs?: number;
  endReason?: NativeBackgroundTask["endReason"];
}

export function applyClaudeBackgroundTaskStates<TMessage extends NativeMessage>(
  messages: TMessage[],
  backgroundTasks: Record<string, ClaudeBackgroundTaskState>,
): TMessage[] {
  const tasksById = new Map<string, ClaudeBackgroundTaskState>();
  const tasksByToolUseId = new Map<string, ClaudeBackgroundTaskState>();
  const cleanupTaskIds = new Set<string>();
  const cleanupToolUseIds = new Set<string>();
  for (const task of Object.values(backgroundTasks)) {
    // Its launch row already shows how it really ended; the resume scan's
    // stop would relabel it, under the scan's text instead of its own name.
    if (isResumeCleanupTask(task)) {
      cleanupTaskIds.add(task.id);
      if (task.toolUseId) cleanupToolUseIds.add(task.toolUseId);
      continue;
    }
    tasksById.set(task.id, task);
    if (task.toolUseId) tasksByToolUseId.set(task.toolUseId, task);
  }
  const isCleanupLaunch = (part: NativeMessagePart, recoveredId: string | undefined): boolean =>
    (part.toolUseId !== undefined && cleanupToolUseIds.has(part.toolUseId)) ||
    (recoveredId !== undefined && cleanupTaskIds.has(recoveredId));

  /*
   * Transcript replay does not persist SDK task lifecycle edges on every
   * Claude version. Recover the durable task-id → launch-description join from
   * the Bash tool result so stopped rows remain named after a bridge restart.
   */
  const launchesByTaskId = new Map<
    string,
    BackgroundTaskDetails & {
      id: string;
      description?: string;
      status?: ClaudeBackgroundTask["status"];
      startedAt?: string;
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
      // Recovery must not turn a historical shell launch back into a task card
      // after the resume scan has excluded its lifecycle above.
      if (isCleanupLaunch(part, recoveredId)) continue;
      const authoritative =
        (part.toolUseId ? tasksByToolUseId.get(part.toolUseId) : undefined) ??
        (recoveredId ? tasksById.get(recoveredId) : undefined);
      const taskId = authoritative?.id ?? recoveredId;
      if (!taskId) continue;
      launchesByTaskId.set(taskId, {
        id: taskId,
        description: authoritative?.description ?? stringArgument(part.toolArgs, "description"),
        status: authoritative?.status,
        startedAt: backgroundTaskStartedAt(authoritative) ?? part.createdAt,
        settledAt: backgroundTaskSettledAt(authoritative),
        ...backgroundTaskDetails(authoritative),
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
      if (!isAgentTool && isCleanupLaunch(part, recoveredId)) return part;
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
          ...startedAtField(backgroundTaskStartedAt(authoritativeLaunch) ?? part.createdAt),
          ...settledAtField(backgroundTaskSettledAt(authoritativeLaunch)),
          ...backgroundTaskDetails(authoritativeLaunch),
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
            ...startedAtField(backgroundTaskStartedAt(launch) ?? part.createdAt),
            ...settledAtField(backgroundTaskSettledAt(launch)),
            ...backgroundTaskDetails(launch),
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
            ...startedAtField(backgroundTaskStartedAt(task)),
            ...settledAtField(backgroundTaskSettledAt(task)),
            ...backgroundTaskDetails(task),
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

function collectToolUseIds(parts: readonly NativeMessagePart[], ids: Set<string>): void {
  for (const part of parts) {
    if (part.toolUseId) ids.add(part.toolUseId);
    if (part.type === "agent-group" || part.type === "tool-group") {
      collectToolUseIds(part.parts, ids);
    } else if (part.type === "task-group") {
      collectToolUseIds([part.task, ...part.childTools], ids);
    } else if (part.type === "subagent" && part.subagentActions) {
      collectToolUseIds(part.subagentActions, ids);
    }
  }
}

export interface BackgroundTaskSnapshot {
  id: string;
  status: NativeBackgroundTaskStatus;
  description?: string;
  /** The tool call that launched the task, when the provider reported one. */
  toolUseId?: string;
  /** Backend-recorded launch clock; see the protocol summary's `startedAt`. */
  startedAt?: string;
  /** Backend-recorded terminal edge; see `NativeBackgroundTask.settledAt`. */
  settledAt?: string;
  error?: string;
  summary?: string;
  outputFile?: string;
  usage?: NativeBackgroundTask["usage"];
  /** See the protocol summary's `agentRole`. */
  agentRole?: string;
  kind?: NativeBackgroundTask["kind"];
  /** See the protocol summary's `parentTaskId`. */
  parentTaskId?: string;
  prompt?: string;
  command?: string;
  outputTail?: string;
  workflowName?: string;
  lastToolName?: string;
  progressSummary?: string;
  pausedMs?: number;
  endReason?: NativeBackgroundTask["endReason"];
  /** Housekeeping the provider asks hosts to keep out of the transcript. */
  ambient?: boolean;
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
          ...(task.startedAt ? { createdAt: task.startedAt } : {}),
          backgroundTask: {
            id: task.id,
            status: task.status,
            ...(task.description ? { description: task.description } : {}),
            ...(task.startedAt ? { startedAt: task.startedAt } : {}),
            ...(task.settledAt ? { settledAt: task.settledAt } : {}),
            ...backgroundTaskDetails(task),
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
 *
 * Claude also reports a foreground command that runs for more than a moment as
 * a task. Its launch is an ordinary tool row, not a card, so while it runs it
 * still gets a card here for the stop control. Once it settles, that row
 * already shows the finished command, and a second card would only repeat it
 * away from the text around it.
 *
 * A task an agent launched belongs to that agent's card, not the transcript:
 * the agent's own commands are its work, and listing them beside it reads as
 * work the conversation started. One whose parent has a card here is left to
 * `childBackgroundTasksByParent`; one whose parent has none keeps its own row.
 * Housekeeping the provider marks ambient gets no row at all, and tasks the
 * provider cleaned up on resume are counted by `withResumeCleanupNotices`.
 */
export function rowlessBackgroundTaskMessages(
  tasks: readonly BackgroundTaskSnapshot[],
  messages: readonly NativeMessage[],
): NativeMessage[] {
  if (tasks.length === 0) return EMPTY_ROWLESS_TASKS;

  const rendered = collectRenderedBackgroundTaskIds(messages);
  const anchors = createNativeAgentSettleAnchors(messages);
  let launchToolUseIds: Set<string> | undefined;
  const hasLaunchRow = (task: BackgroundTaskSnapshot): boolean => {
    if (!task.toolUseId) return false;
    if (!launchToolUseIds) {
      launchToolUseIds = new Set();
      for (const message of messages) collectToolUseIds(message.parts, launchToolUseIds);
    }
    return launchToolUseIds.has(task.toolUseId);
  };
  const ownRow = (task: BackgroundTaskSnapshot): boolean =>
    !rendered.has(task.id) &&
    !isResumeCleanupTask(task) &&
    (isLiveBackgroundTask(task.status) ||
      (anchors.resolve(task.settledAt) !== undefined && !hasLaunchRow(task)));
  const nested = nestedBackgroundTaskIds(
    tasks,
    (task) => rendered.has(task.id) || (!task.ambient && ownRow(task)),
  );
  const rows = tasks.filter((task) => !task.ambient && !nested.has(task.id) && ownRow(task));
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

/**
 * Whether the provider settled this task while resuming, from an earlier
 * process this session never saw it run in.
 */
function isResumeCleanupTask(task: Pick<BackgroundTaskSnapshot, "endReason">): boolean {
  return task.endReason === "resume-cleanup";
}

/**
 * The transcript with one line where the provider cleaned up earlier tasks.
 *
 * On resume Claude Code settles every task from the previous process it finds
 * no ending for, each under the same generic summary and with no name. A card
 * per task reads as that many agents stopping just now, so the tasks that
 * settled at the same position share one line placed after it instead. The
 * position rule is the one settled cards use: one that resolves before the
 * loaded window gets nothing.
 */
export function withResumeCleanupNotices(
  messages: NativeMessage[],
  tasks: readonly BackgroundTaskSnapshot[],
): NativeMessage[] {
  let anchors: ReturnType<typeof createNativeAgentSettleAnchors> | undefined;
  const groups = new Map<string, { count: number; settledAt: string }>();
  for (const task of tasks) {
    if (!isResumeCleanupTask(task) || task.ambient || !task.settledAt) continue;
    anchors ??= createNativeAgentSettleAnchors(messages);
    const anchorId = anchors.resolve(task.settledAt);
    if (anchorId === undefined) continue;
    const group = groups.get(anchorId);
    if (!group) {
      groups.set(anchorId, { count: 1, settledAt: task.settledAt });
      continue;
    }
    group.count += 1;
    if (task.settledAt < group.settledAt) group.settledAt = task.settledAt;
  }
  if (groups.size === 0) return messages;

  return messages.flatMap((message) => {
    const group = groups.get(message.id);
    if (!group) return [message];
    const content =
      group.count === 1
        ? "1 earlier background task was cleaned up"
        : `${group.count.toLocaleString("en-US")} earlier background tasks were cleaned up`;
    const notice: NativeMessage = {
      id: `resume-cleanup:${message.id}`,
      role: "system",
      content,
      parts: [{ type: "status", content, severity: "info" }],
      createdAt: group.settledAt,
    };
    return [message, notice];
  });
}

/**
 * The task's parent, when it has one in the snapshot that can hold it.
 *
 * A parent chain that leads back to the task is malformed data, and following
 * it would have two cards each render the other inside itself; such a task
 * simply has no parent here.
 */
function backgroundTaskParent<T extends Pick<BackgroundTaskSnapshot, "id" | "parentTaskId">>(
  task: T,
  byId: ReadonlyMap<string, T>,
): T | undefined {
  const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
  if (!parent) return undefined;
  const seen = new Set([task.id]);
  for (let ancestor: T | undefined = parent; ancestor;) {
    if (seen.has(ancestor.id)) return undefined;
    seen.add(ancestor.id);
    ancestor = ancestor.parentTaskId ? byId.get(ancestor.parentTaskId) : undefined;
  }
  return parent;
}

/**
 * Ids of the tasks that render inside their parent's card.
 *
 * A task nests when its parent is in the snapshot and has a card — its own, or
 * a slot inside *its* parent — so an agent's agent's commands nest all the way
 * down. `hasCard` says whether a task that does not nest has a card anyway.
 */
function nestedBackgroundTaskIds(
  tasks: readonly BackgroundTaskSnapshot[],
  hasCard: (task: BackgroundTaskSnapshot) => boolean,
): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const shown = new Map<string, boolean>();
  const nested = new Set<string>();
  // Parent chains are acyclic once `backgroundTaskParent` has vetted them.
  const isShown = (task: BackgroundTaskSnapshot): boolean => {
    const known = shown.get(task.id);
    if (known !== undefined) return known;
    const parent = task.ambient ? undefined : backgroundTaskParent(task, byId);
    const nests = parent !== undefined && isShown(parent);
    if (nests) nested.add(task.id);
    const result = nests || hasCard(task);
    shown.set(task.id, result);
    return result;
  };
  for (const task of tasks) isShown(task);
  return nested;
}

/**
 * Each task's child tasks, by parent id, oldest first.
 *
 * Children without their own transcript card are listed under their parent.
 * `rowlessBackgroundTaskMessages` gives a row only to a child whose parent
 * has no card at all.
 */
export function childBackgroundTasksByParent(
  tasks: readonly BackgroundTaskSnapshot[],
  messages: readonly NativeMessage[] = [],
): ReadonlyMap<string, readonly NativeBackgroundTask[]> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, NativeBackgroundTask[]>();
  const rendered = collectRenderedBackgroundTaskIds(messages);
  for (const task of tasks) {
    if (rendered.has(task.id)) continue;
    const parentId = task.ambient ? undefined : backgroundTaskParent(task, byId)?.id;
    if (!parentId) continue;
    const list = children.get(parentId) ?? [];
    list.push({
      id: task.id,
      status: task.status,
      ...(task.description ? { description: task.description } : {}),
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.settledAt ? { settledAt: task.settledAt } : {}),
      ...backgroundTaskDetails(task),
    });
    children.set(parentId, list);
  }
  for (const list of children.values()) {
    list.sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""));
  }
  return children;
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
  return (
    part.type === "text" ||
    part.type === "transcript-reference" ||
    part.type === "async-question" ||
    part.type === "file" ||
    part.type === "artifact"
  );
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
      .filter((part) => part.type === "text" || part.type === "async-question")
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
  return coalesceAdjacentToolMessages(
    dedupeArtifactPublications(messages.map(normalizeClaudeMessage)).flatMap((message) =>
      splitAssistantTranscriptBlocks(message),
    ),
  );
}

/** Resolve a timestamp-split display row back to its persisted message. */
export function getNativeSourceMessageId(messageId: string): string {
  const splitMarker = messageId.indexOf(":text-block:");
  return splitMarker < 0 ? messageId : messageId.slice(0, splitMarker);
}

function lastPartSourceMessageId(parts: readonly NativeMessagePart[]): string | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.type === "tool-group" || part.type === "agent-group") {
      const nested = lastPartSourceMessageId(part.parts);
      if (nested) return nested;
    } else if (part.type === "task-group") {
      const nested = lastPartSourceMessageId([part.task, ...part.childTools]);
      if (nested) return nested;
    }
    if (part.sourceMessageId) return part.sourceMessageId;
  }
  return undefined;
}

/** Resolve a display row to the last persisted provider message it contains. */
export function getNativeMessageBoundarySourceId(message: NativeMessage): string {
  return (
    message.latestSourceMessageId ??
    lastPartSourceMessageId(message.parts) ??
    getNativeSourceMessageId(message.id)
  );
}

/** @deprecated Use {@link getNativeSourceMessageId}. */
export function getClaudeSourceMessageId(messageId: string): string {
  return getNativeSourceMessageId(messageId);
}
