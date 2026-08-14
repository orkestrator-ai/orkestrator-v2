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

import type {
  BuildPipelineAgent,
  PipelineInteractionTranscriptEntry,
} from "@orkestrator/protocol/build-pipeline";
import {
  parseTaskSnapshotStatus,
  type TaskListSnapshot,
  type TaskSnapshotItem,
} from "@orkestrator/protocol/task-list";
import { normalizeClaudeMessagesForDisplay } from "@/lib/chat/native-message-adapters";
import { normalizeOpenCodeMessage } from "@/lib/opencode-client";
import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";
import type {
  NativeAgentActivityPart,
  NativeAgentState,
  NativeBackgroundTask,
  NativeBackgroundTaskStatus,
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

const BACKGROUND_TASK_STATUSES = new Set<NativeBackgroundTaskStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "killed",
  "paused",
]);

function asBackgroundTaskStatus(
  value: unknown,
): NativeBackgroundTaskStatus | undefined {
  return typeof value === "string"
    && BACKGROUND_TASK_STATUSES.has(value as NativeBackgroundTaskStatus)
    ? value as NativeBackgroundTaskStatus
    : undefined;
}

function asBackgroundTask(value: unknown): NativeBackgroundTask | undefined {
  const raw = asRecord(value);
  const id = asString(raw?.id);
  if (!raw || !id) return undefined;
  // Validated, not cast: a status outside the union renders as no badge at all
  // today, but the part would carry a value its own type says cannot exist, and
  // the next consumer to switch exhaustively over it inherits the lie.
  const status = asBackgroundTaskStatus(raw.status);
  return {
    id,
    description: asString(raw.description),
    ...(status ? { status } : {}),
  };
}

function asTaskItem(value: unknown): TaskSnapshotItem | undefined {
  const raw = asRecord(value);
  const id = asString(raw?.id);
  // A task can legitimately have an empty subject, so this is not `asString`.
  const subject = typeof raw?.subject === "string" ? raw.subject : undefined;
  // The protocol owns the status vocabulary and the spellings it accepts. A
  // hand-copied set here would still type-check after a status was added there,
  // while silently dropping every snapshot that used the new one.
  const status = parseTaskSnapshotStatus(raw?.status);
  if (!raw || !id || subject === undefined || !status) return undefined;
  return { id, subject, status };
}

/**
 * `TodoToolPart` maps over `items` and dereferences `id`, `subject` and
 * `status` on every element, so the snapshot is rebuilt field by field rather
 * than cast.
 *
 * One unreadable item drops the whole snapshot instead of silently shortening
 * the list: the renderer then falls back to the tool call itself, which is
 * honest, where a partial list would read as the whole of it. `complete`
 * defaults to false for the same reason — a snapshot that never said it was
 * complete must not claim to be.
 */
function asTaskSnapshot(value: unknown): TaskListSnapshot | undefined {
  const raw = asRecord(value);
  if (!raw || !Array.isArray(raw.items)) return undefined;
  const items: TaskSnapshotItem[] = [];
  for (const entry of raw.items) {
    const item = asTaskItem(entry);
    if (!item) return undefined;
    items.push(item);
  }
  const changedTaskId = asString(raw.changedTaskId);
  const truncated = asNumber(raw.truncated);
  return {
    items,
    ...(changedTaskId ? { changedTaskId } : {}),
    complete: raw.complete === true,
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

/**
 * The edit renderer calls `.split()` on `filePath`, `diff`, `before` and
 * `after` with no guard, so every field is validated. Unlike `toolArgs` — raw
 * provider JSON that the native tabs pass through identically — a diff is
 * client-constructed everywhere else, which makes this adapter the only way a
 * non-string could reach those calls.
 */
function asToolDiff(value: unknown): NativeToolDiffMetadata | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const diff: NativeToolDiffMetadata = {
    filePath: asString(raw.filePath),
    before: asString(raw.before),
    after: asString(raw.after),
    diff: asString(raw.diff),
    additions: asNumber(raw.additions),
    deletions: asNumber(raw.deletions),
  };
  // An object every field of which was dropped is not a diff at all.
  return Object.values(diff).some((field) => field !== undefined)
    ? diff
    : undefined;
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
    toolDiff: asToolDiff(raw.toolDiff),
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

/** The part types `normalizeClaudePart` understands; it drops the rest. */
const CLAUDE_PART_TYPES = new Set([
  "text",
  "thinking",
  "file",
  "tool-invocation",
  "tool-result",
]);

/**
 * Validate provider parts and put back the two names Claude spells differently.
 *
 * `toNativePart` normalizes `timestamp` → `createdAt` and `_messageUuid` →
 * `sourcePartId`, but `normalizeClaudePart` reads the wire names. Handing it a
 * native part directly leaves every part untimestamped, so
 * `splitClaudeAssistantTextBlocks` can never fire and a long stage renders as
 * one row — the exact behaviour this module claims to share with the Claude tab.
 */
function toClaudeParts(value: unknown): ClaudeMessagePart[] {
  if (!Array.isArray(value)) return [];
  return toNativeParts(value)
    .filter((part) => CLAUDE_PART_TYPES.has(part.type))
    .map(({ createdAt, sourcePartId, content, ...rest }) => ({
      ...rest,
      // The Claude adapter falls back to the tool name for a part that carries
      // no content of its own; the validator's `""` would suppress that.
      ...(content ? { content } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(sourcePartId ? { sourcePartId } : {}),
    }) as unknown as ClaudeMessagePart);
}

/** `new Date(value).toISOString()` throws beyond the ECMA-262 time clip. */
const MAX_EPOCH_MS = 8.64e15;

function isRenderableEpoch(value: unknown): boolean {
  if (typeof value === "number") {
    return isRenderableEpochNumber(value);
  }
  return asString(value) !== undefined;
}

/**
 * Numeric-only variant for a call site that feeds `new Date(...).toISOString()`
 * directly. {@link isRenderableEpoch} accepts any non-empty string because its
 * own call site only uses the answer to keep or drop a value; passing a string
 * through to `toISOString` would throw `RangeError` from inside a render.
 */
function isRenderableEpochNumber(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && Math.abs(value) <= MAX_EPOCH_MS;
}

/**
 * Per-field caps for the auto-decline record.
 *
 * The backend bounds what it writes, but the protocol permits up to 16 KB per
 * field for a snapshot written by an older build, and this renders as a single
 * centred italic block with no expand affordance.
 */
const MAX_INTERACTION_LINE_LENGTH = 512;
const MAX_INTERACTION_BODY_LENGTH = 1_024;
const MAX_INTERACTION_OPTION_LENGTH = 128;
const MAX_INTERACTION_QUESTIONS = 4;
const MAX_INTERACTION_OPTIONS = 8;

function clip(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

/** The entry with `info.time.created` removed, so the normalizer skips it. */
function withoutCreatedTime(
  raw: Record<string, unknown>,
  info: Record<string, unknown>,
): Record<string, unknown> {
  const time = asRecord(info.time);
  if (!time) return { ...raw, info: { ...info } };
  const { created: _created, ...restTime } = time;
  return { ...raw, info: { ...info, time: restTime } };
}

/**
 * OpenCode's own normalizer is not total and not deterministic, and both matter
 * here.
 *
 * It builds a `Date` from an unvalidated epoch, which throws a `RangeError` out
 * of the render-time memo for an out-of-range value — one bad entry would
 * replace the whole tab with the error boundary instead of being dropped. It
 * also mints a fresh UUID for a message with no `info.id` and stamps "now" for
 * one with no timestamp; this runs again on every backend push, so the id
 * Virtuoso keys on would churn and the row would remount mid-stream. Both are
 * anchored to the entry's position instead.
 */
function toOpenCodeMessage(
  raw: Record<string, unknown>,
  // Never null: `openCodeInfo` is what routed this entry here, and returning a
  // record is exactly what that routing decision means.
  info: Record<string, unknown>,
  index: number,
  fallbackCreatedAt: string,
): NativeMessage | null {
  const timestamped = isRenderableEpoch(asRecord(info.time)?.created);
  const entry = timestamped ? raw : withoutCreatedTime(raw, info);

  let message: NativeMessage | null;
  try {
    message = normalizeOpenCodeMessage(entry);
  } catch {
    return null;
  }
  if (!message || !hasRenderableContent(message)) return null;

  return {
    ...message,
    id: asString(info.id) ?? `pipeline-message-${index}`,
    ...(timestamped ? {} : { createdAt: fallbackCreatedAt }),
  };
}

function hasRenderableContent(message: NativeMessage): boolean {
  return message.parts.length > 0 || message.content.trim().length > 0;
}

function messageId(raw: Record<string, unknown>, index: number): string {
  return asString(raw.id) ?? `pipeline-message-${index}`;
}

/**
 * The OpenCode envelope's `info`, or null for a flat message.
 *
 * OpenCode returns `{ info, parts }`; the Claude and Codex bridges return the
 * flat message shape. Detected per entry rather than from the pipeline's agent
 * type so a snapshot whose agent was recorded differently still renders.
 */
function openCodeInfo(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  return asRecord(raw.info);
}

const PIPELINE_HANDOFF_OPEN = '<orkestrator-handoff format="json-v2">';
const PIPELINE_HANDOFF_CLOSE = "</orkestrator-handoff>";

/**
 * The fresh address-issues session receives the review history as one large
 * bootstrap prompt. The provider still needs that prompt, but showing it as the
 * first user bubble makes the useful stage output start several screens down.
 *
 * Only the first provider entry is eligible for suppression. That is the sole
 * position where the backend can dispatch this carrier, and keeping the check
 * there prevents a later model/user message that quotes the marker from being
 * hidden. Both flat bridge messages and OpenCode's `{ info, parts }` envelope
 * are recognized before provider-specific normalization.
 */
function isInitialPipelineHandoff(raw: Record<string, unknown>): boolean {
  const role = raw.role ?? openCodeInfo(raw)?.role;
  if (role !== "user") return false;

  const carriesHandoff = (value: unknown): boolean =>
    typeof value === "string"
    && value.trimStart().startsWith(PIPELINE_HANDOFF_OPEN)
    && value.includes(PIPELINE_HANDOFF_CLOSE);

  if (carriesHandoff(raw.content)) return true;
  if (!Array.isArray(raw.parts)) return false;
  return raw.parts.some((part) => {
    const candidate = asRecord(part);
    return candidate !== null
      && (carriesHandoff(candidate.content) || carriesHandoff(candidate.text));
  });
}

export function toPipelineTranscript(
  messages: unknown[] | undefined,
  agentType: BuildPipelineAgent,
  fallbackCreatedAt: string,
  interactions: readonly PipelineInteractionTranscriptEntry[] = [],
): NativeMessage[] {
  const transcript: NativeMessage[] = [];
  let hasSeenProviderEntry = false;

  (messages ?? []).forEach((entry, index) => {
    const raw = asRecord(entry);
    if (!raw) return;
    const isFirstProviderEntry = !hasSeenProviderEntry;
    hasSeenProviderEntry = true;
    if (isFirstProviderEntry && isInitialPipelineHandoff(raw)) return;

    const info = openCodeInfo(raw);
    if (info) {
      const message = toOpenCodeMessage(raw, info, index, fallbackCreatedAt);
      if (message) transcript.push(message);
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
        createdAt,
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

  if (interactions.length === 0) return transcript;

  const interactionMessages = interactions.map((interaction) => {
    const questionText = interaction.questions
      .slice(0, MAX_INTERACTION_QUESTIONS)
      .map((question) => {
        const options = question.options.length > 0
          ? `\nOffered options: ${question.options
            .slice(0, MAX_INTERACTION_OPTIONS)
            .map((option) => clip(option, MAX_INTERACTION_OPTION_LENGTH))
            .join(", ")}`
          : "";
        return `${clip(question.prompt, MAX_INTERACTION_LINE_LENGTH)}${options}`;
      }).join("\n\n");
    const details = [
      interaction.body ? clip(interaction.body, MAX_INTERACTION_BODY_LENGTH) : "",
      questionText,
    ].filter(Boolean).join("\n\n");
    const content = [
      `Auto-declined unattended ${interaction.provider} ${interaction.kind} during ${interaction.phase}`,
      `Outcome: ${interaction.outcome}`,
      clip(interaction.title, MAX_INTERACTION_LINE_LENGTH),
      details,
      "No answer was fabricated. The agent was instructed to make and state the safest likely assumption, then continue.",
    ].filter(Boolean).join("\n\n");
    return {
      id: `pipeline-interaction:${interaction.id}`,
      role: "system",
      content,
      parts: [{ type: "text", content }],
      // Persisted snapshots may have been written by an older build or edited
      // by hand. Keep one out-of-range epoch from replacing the whole tab with
      // a render error; the session start is already the stable fallback used
      // for provider messages with invalid timestamps.
      createdAt: isRenderableEpochNumber(interaction.resolvedAt)
        ? new Date(interaction.resolvedAt).toISOString()
        : fallbackCreatedAt,
    } satisfies NativeMessage;
  });

  // Merged by time rather than appended: a decline that happened 30 seconds into
  // a stage belongs beside the work it interrupted, not below the stage's last
  // message with an earlier timestamp than everything above it.
  return mergeByCreatedAt(transcript, interactionMessages);
}

/**
 * Stable merge of two already-ordered transcripts.
 *
 * A provider message whose timestamp is missing or unparseable inherits the
 * position of the one before it, so nothing is reordered on the strength of a
 * timestamp that could not be read. `Array.prototype.sort` is stable, and the
 * interactions are concatenated second, so a tie places the decline after the
 * message it followed.
 */
function mergeByCreatedAt(
  providerMessages: readonly NativeMessage[],
  interactionMessages: readonly NativeMessage[],
): NativeMessage[] {
  let carried = Number.NEGATIVE_INFINITY;
  const keyed = providerMessages.map((message) => {
    const raw = (message as { createdAt?: unknown }).createdAt
      ?? (message as { timestamp?: unknown }).timestamp;
    const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (Number.isFinite(parsed)) carried = parsed;
    return { message, key: carried };
  });
  for (const message of interactionMessages) {
    const parsed = Date.parse(message.createdAt ?? "");
    keyed.push({
      message,
      key: Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY,
    });
  }
  return keyed
    .sort((left, right) => left.key - right.key)
    .map((entry) => entry.message);
}
