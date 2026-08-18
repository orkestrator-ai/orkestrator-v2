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

function isAgentPart(part: NativeMessagePart): part is NativeAgentActivityPart {
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
    return (
      part.subagentName?.trim() ||
      part.subagentRole?.trim() ||
      part.subagentPrompt?.trim() ||
      trimTaskPrefix(part.toolTitle?.trim() || part.content.trim()) ||
      "Sub-agent"
    );
  }

  const task = part.task;
  return (
    stringArgument(
      task.toolArgs,
      "name",
      "agentName",
      "agent_name",
      "description",
      "task",
      "prompt",
    ) ||
    trimTaskPrefix(task.toolTitle?.trim() || task.content.trim()) ||
    "Sub-agent"
  );
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
  const backgroundTask =
    part.type === "task-group" ? part.task.backgroundTask : part.backgroundTask;
  const durableId =
    backgroundTask?.id ??
    (part.type === "task-group"
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
      const backgroundTask =
        part.type === "task-group" ? part.task.backgroundTask : part.backgroundTask;
      snapshots.set(id, {
        id,
        label: nativeAgentActivityLabel(part),
        status: getNativeAgentStatus(part),
        kind: backgroundTask ? "background-task" : "subagent",
        ...(backgroundTask?.status ? { backgroundTaskStatus: backgroundTask.status } : {}),
      });
    });
  }
  return [...snapshots.values()];
}

/** Resolves settle stamps to the transcript row they belong under. */
export interface NativeAgentSettleAnchors {
  /**
   * The row a card that settled at `settledAt` belongs under.
   *
   * The transcript had reached this message when the backend recorded the child
   * terminal, so this is where the card was sitting and where it stays. A child
   * that settled before anything in the loaded window has no row to sit under —
   * its transcript was trimmed — and gets no anchor, which leaves it in its
   * launch row rather than teleporting it to the top.
   */
  resolve(settledAt: string | undefined): string | undefined;
}

/**
 * Index the rows a settled card may be placed under.
 *
 * One transcript answers this for every settled child in it, and a long session
 * holds many, so the timeline is read once here rather than once per child —
 * resolving used to walk the whole transcript per card, which is quadratic on a
 * path that re-runs on every streamed frame.
 *
 * `floors[i]` is the earliest clock at or after position `i`. That is
 * non-decreasing however unordered the transcript's own clocks happen to be, so
 * the position can be bisected without assuming the timeline is sorted — which
 * keeps the answer identical to the scan it replaces.
 */
export function createNativeAgentSettleAnchors(
  timeline: readonly NativeMessage[],
): NativeAgentSettleAnchors {
  const ids: string[] = [];
  const clocks: number[] = [];
  for (const message of timeline) {
    const createdAt = timestampOf(message.createdAt);
    // A row with no readable clock cannot vouch for where anything settled, so
    // it is not offered as a position.
    if (createdAt === undefined) continue;
    ids.push(message.id);
    clocks.push(createdAt);
  }

  const floors = Array.from<number>({ length: clocks.length });
  let floor = Number.POSITIVE_INFINITY;
  for (let index = clocks.length - 1; index >= 0; index -= 1) {
    floor = Math.min(floor, clocks[index]!);
    floors[index] = floor;
  }

  return {
    resolve(settledAt) {
      const settled = timestampOf(settledAt);
      if (settled === undefined) return undefined;

      /*
       * The last position whose floor is still at-or-before the stamp. Its own
       * clock has to be the qualifying one: nothing after it qualifies, so the
       * minimum it contributes over that range is its own.
       */
      let low = 0;
      let high = floors.length - 1;
      let anchor = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (floors[middle]! <= settled) {
          anchor = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return anchor === -1 ? undefined : ids[anchor];
    },
  };
}

/** The earlier of two settle stamps, ignoring one this module cannot read. */
function earlierStamp(first: string, second: string): string {
  const firstMs = timestampOf(first);
  const secondMs = timestampOf(second);
  if (firstMs === undefined) return second;
  if (secondMs === undefined) return first;
  return firstMs <= secondMs ? first : second;
}

function hasRenderableContent(message: NativeMessage): boolean {
  return message.parts.length > 0 || message.content.trim().length > 0;
}

interface SettledAgentPart {
  part: NativeAgentActivityPart;
  anchorMessageId: string;
  settledAt: string;
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
  anchors: NativeAgentSettleAnchors,
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
      const settledAt = settledAtOf(part);
      const anchorMessageId = anchors.resolve(settledAt);
      if (anchorMessageId && settledAt) {
        settledParts.push({ part, anchorMessageId, settledAt });
        continue;
      }

      retainedParts.push(part);
      continue;
    }

    if (part.type === "tool-group") {
      const extracted = extractPinnedAgentParts(part.parts, anchors);
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
      const extracted = extractPinnedAgentParts(part.parts, anchors);
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
  /**
   * Clock for the row, when the source message's own is the wrong one.
   *
   * A settled row sits where the backend recorded the child stopping, which is
   * not where the launch row it was lifted out of sits — so inheriting the
   * launch clock would print a time earlier than the rows above it. A running
   * row keeps the source's clock: it is pinned to the bottom precisely because
   * it has not settled anywhere yet.
   */
  createdAt?: string,
): NativeMessage {
  const isGroup = parts.length > 1;

  return {
    ...source,
    // Keep the virtualized row mounted as the active membership changes. Agent
    // expansion state lives inside NativeMessage, so a singleton-specific id
    // would collapse an expanded row as soon as a second agent starts.
    id,
    ...(createdAt ? { createdAt } : {}),
    content: "",
    parts: isGroup
      ? [
          {
            type: "agent-group",
            content: "",
            parts,
          },
        ]
      : [parts[0]!],
  };
}

interface SettledAgentRow {
  source: NativeMessage;
  parts: NativeAgentActivityPart[];
  /**
   * Clock for the row: the earliest stamp among the cards sharing it.
   *
   * Every card here settled after the anchor row and before whatever followed
   * it, so any of their stamps sits in the same gap; the earliest is the one
   * that says when this row first had something to show.
   */
  settledAt: string;
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
  const renderedSlots: Array<{
    originalMessageId: string;
    renderedMessage?: NativeMessage;
  }> = [];
  const activeMessages: NativeMessage[] = [];
  const settledRows = new Map<string, SettledAgentRow>();
  const anchors = createNativeAgentSettleAnchors(anchorTimeline);

  for (const message of messages) {
    const { retainedParts, activeParts, settledParts } = extractPinnedAgentParts(
      message.parts,
      anchors,
    );

    if (activeParts.length === 0 && settledParts.length === 0) {
      renderedMessages.push(message);
      renderedSlots.push({
        originalMessageId: message.id,
        renderedMessage: message,
      });
      continue;
    }

    const retainedMessage = { ...message, parts: retainedParts };
    if (hasRenderableContent(retainedMessage)) {
      renderedMessages.push(retainedMessage);
      renderedSlots.push({
        originalMessageId: message.id,
        renderedMessage: retainedMessage,
      });
    } else {
      // The row can disappear when it held only the child being extracted, but
      // its position is still real. Keep an empty slot so a card that settled
      // here stays before messages that arrived after it.
      renderedSlots.push({ originalMessageId: message.id });
    }

    if (activeParts.length > 0) {
      activeMessages.push(
        createPinnedAgentMessage(message, `${message.id}:active-agents`, activeParts),
      );
    }

    for (const { part, anchorMessageId, settledAt } of settledParts) {
      const row = settledRows.get(anchorMessageId);
      if (row) {
        row.parts.push(part);
        row.settledAt = earlierStamp(row.settledAt, settledAt);
      } else {
        settledRows.set(anchorMessageId, {
          source: message,
          parts: [part],
          settledAt,
        });
      }
    }
  }

  if (settledRows.size === 0) return [...renderedMessages, ...activeMessages];

  const pinnedMessages: NativeMessage[] = [];
  for (const slot of renderedSlots) {
    if (slot.renderedMessage) pinnedMessages.push(slot.renderedMessage);
    const row = settledRows.get(slot.originalMessageId);
    if (!row) continue;
    settledRows.delete(slot.originalMessageId);
    pinnedMessages.push(
      createPinnedAgentMessage(
        row.source,
        `${slot.originalMessageId}:settled-agents`,
        row.parts,
        row.settledAt,
      ),
    );
  }

  // An anchor whose message is genuinely absent from this message set (rather
  // than merely consumed by extraction). The card was last seen at the bottom,
  // so that is where it stays, still above anything still running.
  for (const [anchorMessageId, row] of settledRows) {
    pinnedMessages.push(
      createPinnedAgentMessage(
        row.source,
        `${anchorMessageId}:settled-agents`,
        row.parts,
        row.settledAt,
      ),
    );
  }

  return [...pinnedMessages, ...activeMessages];
}
