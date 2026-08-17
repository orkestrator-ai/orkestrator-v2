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

/**
 * When a child went terminal, as the backend recorded it.
 *
 * A running child is pinned to the bottom of the transcript, which is nowhere
 * near the row that launched it. Dropping it back to that launch row the
 * instant it finishes moves the card the reader is looking at, so the pin is
 * released in place instead — and "in place" is decided by this timestamp
 * against the transcript's own clocks, not by anything this renderer watched
 * happen. Two tabs, and the same tab after a reload, therefore agree.
 */
function settledAtOf(part: NativeAgentActivityPart): string | undefined {
  const source = part.type === "task-group" ? part.task : part;
  return source.backgroundTask?.settledAt ?? source.settledAt;
}

function timestampOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAgentPart(
  part: NativeMessagePart,
): part is NativeAgentActivityPart {
  return part.type === "subagent" || part.type === "task-group";
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

/**
 * Identity for one child, stable across the streamed updates that rewrite the
 * part object on every frame.
 *
 * A background task is keyed on its provider task id whichever row carries it,
 * so the rowless card a tab surfaces from the snapshot and the transcript row
 * that later materializes are recognised as the same child rather than two.
 * Only a child with no durable id at all falls back to its position, which is
 * why that fallback includes the message: two messages can hold structurally
 * identical anonymous children.
 */
export function nativeAgentActivityKey(
  part: NativeAgentActivityPart,
  messageId: string,
  partPath: string,
): string {
  const backgroundTask = part.type === "task-group"
    ? part.task.backgroundTask
    : part.backgroundTask;
  const durableId = backgroundTask?.id ?? (part.type === "task-group"
    ? part.task.toolUseId?.trim() || part.task.subagentId?.trim()
    : part.subagentId?.trim() || part.toolUseId?.trim());
  return durableId
    ? `${backgroundTask ? "background-task" : part.type}:${durableId}`
    : `${part.type}:${messageId}:${partPath}`;
}

function forEachAgentPart(
  parts: readonly NativeMessagePart[],
  messageId: string,
  path: string,
  visit: (part: NativeAgentActivityPart, key: string) => void,
): void {
  parts.forEach((part, index) => {
    const partPath = `${path}.${index}`;
    if (isAgentPart(part)) {
      visit(part, nativeAgentActivityKey(part, messageId, partPath));
      return;
    }

    if (part.type === "agent-group" || part.type === "tool-group") {
      forEachAgentPart(part.parts, messageId, partPath, visit);
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
    forEachAgentPart(message.parts, message.id, "part", (part, id) => {
      const backgroundTask = part.type === "task-group"
        ? part.task.backgroundTask
        : part.backgroundTask;
      snapshots.set(id, {
        id,
        label: nativeAgentActivityLabel(part),
        status: getNativeAgentStatus(part),
        kind: backgroundTask ? "background-task" : "subagent",
        ...(backgroundTask?.status
          ? { backgroundTaskStatus: backgroundTask.status }
          : {}),
      });
    });
  }
  return [...snapshots.values()];
}

/**
 * The row a card that settled at `settledAt` belongs under.
 *
 * The transcript had reached this message when the backend recorded the child
 * terminal, so this is where the card was sitting and where it stays. A child
 * that settled before anything in the loaded window has no row to sit under —
 * its transcript was trimmed — and gets no anchor, which leaves it in its
 * launch row rather than teleporting it to the top.
 */
export function nativeAgentSettleAnchor(
  timeline: readonly NativeMessage[],
  settledAt: string | undefined,
): string | undefined {
  const settled = timestampOf(settledAt);
  if (settled === undefined) return undefined;

  let anchorId: string | undefined;
  for (const message of timeline) {
    const createdAt = timestampOf(message.createdAt);
    if (createdAt === undefined || createdAt > settled) continue;
    anchorId = message.id;
  }
  return anchorId;
}

function hasRenderableContent(message: NativeMessage): boolean {
  return message.parts.length > 0 || message.content.trim().length > 0;
}

interface SettledAgentPart {
  part: NativeAgentActivityPart;
  anchorMessageId: string;
}

interface AgentPartExtraction {
  retainedParts: NativeMessagePart[];
  /** Running children, bound for the bottom of the transcript. */
  activeParts: NativeAgentActivityPart[];
  /** Settled children holding the position the backend recorded for them. */
  settledParts: SettledAgentPart[];
}

function extractPinnedAgentParts(
  parts: NativeMessagePart[],
  resolveAnchor: (part: NativeAgentActivityPart) => string | undefined,
): AgentPartExtraction {
  const retainedParts: NativeMessagePart[] = [];
  const activeParts: NativeAgentActivityPart[] = [];
  const settledParts: SettledAgentPart[] = [];

  for (const part of parts) {
    if (isAgentPart(part)) {
      if (isNativeAgentActive(part)) {
        activeParts.push(part);
        continue;
      }

      // No recorded settle position: a child whose bridge predates the field,
      // or one whose terminal edge the backend never saw. Its launch row is
      // then the only position anything vouches for.
      const anchorMessageId = resolveAnchor(part);
      if (anchorMessageId) {
        settledParts.push({ part, anchorMessageId });
        continue;
      }

      retainedParts.push(part);
      continue;
    }

    if (part.type === "tool-group") {
      const extracted = extractPinnedAgentParts(part.parts, resolveAnchor);
      activeParts.push(...extracted.activeParts);
      settledParts.push(...extracted.settledParts);

      if (extracted.retainedParts.length > 0) {
        retainedParts.push({
          ...part,
          parts: extracted.retainedParts,
        } satisfies NativeToolGroupPart);
      }
      continue;
    }

    if (part.type === "agent-group") {
      const extracted = extractPinnedAgentParts(part.parts, resolveAnchor);
      activeParts.push(...extracted.activeParts);
      settledParts.push(...extracted.settledParts);
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

  return { retainedParts, activeParts, settledParts };
}

function createPinnedAgentMessage(
  source: NativeMessage,
  id: string,
  parts: NativeAgentActivityPart[],
): NativeMessage {
  const isGroup = parts.length > 1;

  return {
    ...source,
    // Keep the virtualized row mounted as the active membership changes. Agent
    // expansion state lives inside NativeMessage, so a singleton-specific id
    // would collapse an expanded row as soon as a second agent starts.
    id,
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

interface SettledAgentRow {
  source: NativeMessage;
  parts: NativeAgentActivityPart[];
}

/**
 * Lift long-running children out of their launch rows.
 *
 * Running children move to the bottom, where the reader is already watching and
 * where the stop control cannot scroll away. A settled child is released at the
 * position the backend recorded for it — the transcript row the conversation had
 * reached when that child stopped — and everything else renders exactly where
 * the transcript put it.
 *
 * Pure, and a pure function of backend data: the same transcript yields the same
 * order in every tab and after every reload, because nothing here depends on
 * which lifecycle transitions this renderer happened to be mounted for.
 */
export function pinNativeAgentParts(
  messages: NativeMessage[],
  /**
   * The rows a settled card may be placed under, when that is not simply
   * `messages`.
   *
   * A tab can add rows the backend transcript does not contain — the card for a
   * task whose launch fell outside the loaded window. Those rows carry a settle
   * position of their own, so leaving them in the timeline would let one such
   * card anchor to another and drag it away from the conversation it belongs
   * beside. Only real transcript rows are positions.
   */
  anchorTimeline: readonly NativeMessage[] = messages,
): NativeMessage[] {
  const renderedMessages: NativeMessage[] = [];
  const activeMessages: NativeMessage[] = [];
  const settledRows = new Map<string, SettledAgentRow>();
  const resolveAnchor = (part: NativeAgentActivityPart) =>
    nativeAgentSettleAnchor(anchorTimeline, settledAtOf(part));

  for (const message of messages) {
    const { retainedParts, activeParts, settledParts } = extractPinnedAgentParts(
      message.parts,
      resolveAnchor,
    );

    if (activeParts.length === 0 && settledParts.length === 0) {
      renderedMessages.push(message);
      continue;
    }

    const retainedMessage = { ...message, parts: retainedParts };
    if (hasRenderableContent(retainedMessage)) {
      renderedMessages.push(retainedMessage);
    }

    if (activeParts.length > 0) {
      activeMessages.push(createPinnedAgentMessage(
        message,
        `${message.id}:active-agents`,
        activeParts,
      ));
    }

    for (const { part, anchorMessageId } of settledParts) {
      const row = settledRows.get(anchorMessageId);
      if (row) {
        row.parts.push(part);
      } else {
        settledRows.set(anchorMessageId, { source: message, parts: [part] });
      }
    }
  }

  if (settledRows.size === 0) return [...renderedMessages, ...activeMessages];

  const pinnedMessages: NativeMessage[] = [];
  for (const message of renderedMessages) {
    pinnedMessages.push(message);
    const row = settledRows.get(message.id);
    if (!row) continue;
    settledRows.delete(message.id);
    pinnedMessages.push(createPinnedAgentMessage(
      row.source,
      `${message.id}:settled-agents`,
      row.parts,
    ));
  }

  // An anchor whose message is gone — trimmed out of a windowed transcript, or
  // consumed entirely by this extraction. The card was last seen at the bottom,
  // so that is where it stays, still above anything still running.
  for (const [anchorMessageId, row] of settledRows) {
    pinnedMessages.push(createPinnedAgentMessage(
      row.source,
      `${anchorMessageId}:settled-agents`,
      row.parts,
    ));
  }

  return [...pinnedMessages, ...activeMessages];
}
