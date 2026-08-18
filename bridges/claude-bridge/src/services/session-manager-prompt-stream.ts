import type {
  MessagePatchEventData,
  NormalizedMessage,
  NormalizedPart,
  SessionState,
} from "../types/index.js";
import { TaskRegistry } from "@orkestrator/protocol/task-list";
import { isRootAssistantRecord, normalizeBackendModelId } from "@orkestrator/protocol/model-id";
import { eventEmitter } from "./event-emitter.js";
import {
  ToolTracker,
  buildMessageParts,
  type OrderedPartEntry,
} from "./session-manager-messages.js";
import { getMessageTextFromParts, isSamePublishedPart } from "./session-manager-persistence.js";

export interface PromptStreamState {
  currentAssistantMessage: NormalizedMessage | null;
  toolTracker: ToolTracker;
  taskRegistry: TaskRegistry;
  activeTaskIds: Set<string>;
  finalizedBlockCountByApiMessage: Map<string, number>;
  accumulatedOrderedParts: OrderedPartEntry[];
  getBlocksForMessage: (messageKey: string) => Map<number, OrderedPartEntry>;
  rebuildAccumulatedOrderedParts: () => void;
  emitCurrentAssistantMessage: () => void;
  syntheticMessageKeyCounter: number;
  pendingPlanRejectionFeedback: string | null;
  planApprovedThisTurn: boolean;
  pendingPlanApprovalContinuation: string | null;
  flushStreamedAssistantMessage: () => void;
  applyPartialAssistantMessage: (partialMessage: any) => boolean;
  clearFlushTimer: () => void;
}

export const MAX_STREAM_CONTENT_BLOCK_INDEX = 4_095;

export function createPromptStreamState(
  session: SessionState,
  sessionId: string,
  options: {
    flushIntervalMs: number;
    maxBlockIndex: number;
  },
): PromptStreamState {
  let streamEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const { flushIntervalMs, maxBlockIndex } = options;
  // Track current assistant message for updates
  let currentAssistantMessage: NormalizedMessage | null = null;

  // Tool tracker persists across all messages in this turn
  const toolTracker = new ToolTracker();

  // The task list, unlike the tool tracker, persists across turns — Claude's
  // tasks survive from one prompt to the next, so the registry hangs off the
  // session and is created once.
  const taskRegistry = (session.taskRegistry ??= new TaskRegistry());

  // Track accumulated ordered parts (text, thinking, and tools in chronological order).
  //
  // Parts are grouped by API message id (`msg_…`) and, within a message, by
  // content-block index. This is the only identity that is stable across the
  // SDK events that describe one block:
  //   - every `stream_event` carries its own random `uuid`, so grouping deltas
  //     by `uuid` produces one part per delta (a "Thinking" row per token);
  //   - the SDK emits one non-streaming `assistant` message per content block,
  //     each with a fresh `uuid` but the same `message.id`, so grouping those
  //     by `uuid` appends a duplicate copy of already-streamed content.
  // Grouping by (api message id, block index) makes deltas collapse onto the
  // block they belong to and makes the final block overwrite what it streamed.
  // Each message's blocks live in a map keyed by block index. A malformed
  // large index therefore cannot create a huge sparse array whose iteration
  // stalls the bridge; the small set of received indices is sorted on flush.
  const blocksByApiMessage = new Map<string, Map<number, OrderedPartEntry>>();
  // Streaming deltas do not consistently repeat their parent relationship.
  // Remember it from whichever frame supplies it so subagent thinking/text
  // does not briefly render as parent-agent output before the final block
  // replaces the stream.
  const parentTaskByApiMessage = new Map<string, string>();
  // Blocks of each API message already reconciled from non-streaming `assistant`
  // messages. Those messages don't carry the stream's block index, but they
  // arrive in block order, so the running count is the index of the next block.
  const finalizedBlockCountByApiMessage = new Map<string, number>();
  // API message id of the stream currently being received (set by `message_start`).
  let currentStreamApiMessageId: string | null = null;
  // Fallback keys for messages that carry neither an API message id nor a uuid.
  let syntheticMessageKeyCounter = 0;

  // Flattened view of `blocksByApiMessage`, in message order then block order.
  let accumulatedOrderedParts: OrderedPartEntry[] = [];

  const getBlocksForMessage = (messageKey: string): Map<number, OrderedPartEntry> => {
    let blocks = blocksByApiMessage.get(messageKey);
    if (!blocks) {
      blocks = new Map();
      blocksByApiMessage.set(messageKey, blocks);
    }
    return blocks;
  };

  /** Fold any buffered streamed deltas into the entry's `value`. */
  const materializeEntryValue = (entry: OrderedPartEntry): void => {
    if (entry.pendingChunks) {
      entry.value += entry.pendingChunks.join("");
      entry.pendingChunks = undefined;
    }
  };

  const rebuildAccumulatedOrderedParts = () => {
    const parts: OrderedPartEntry[] = [];
    // Map iteration is insertion-ordered, which is API message arrival order;
    // block indices may arrive out of order, so sort only the received keys.
    for (const blocks of blocksByApiMessage.values()) {
      const blockIndices = Array.from(blocks.keys()).sort((a, b) => a - b);
      for (const blockIndex of blockIndices) {
        const entry = blocks.get(blockIndex);
        if (!entry) continue;
        materializeEntryValue(entry);
        parts.push(entry);
      }
    }
    accumulatedOrderedParts = parts;
  };

  // Track active (pending) Task tool IDs for parent tracking
  // This allows us to associate child tools with their parent Task
  const activeTaskIds = new Set<string>();

  // Track plan rejection feedback so we can re-prompt Claude after the turn ends.
  // When ExitPlanMode is denied, the SDK may end the turn without Claude seeing
  // the feedback. We capture it here and re-send as a follow-up prompt.
  let pendingPlanRejectionFeedback: string | null = null;

  // ---------------------------------------------------------------------
  // Defensive fallback for the ExitPlanMode "approved but failed" case.
  //
  // Primary fix lives at the permissionMode site above: we now forward
  // `permissionMode: "plan"` to the SDK, so the SDK is genuinely in plan
  // mode and its native ExitPlanMode tool runs to success.
  //
  // The fallback below covers the case where the SDK's plan-mode handling
  // misbehaves (older SDK builds, future regressions, or unforeseen edge
  // cases): if the user explicitly approved the plan but the SDK still
  // marked the ExitPlanMode tool as `is_error`, we don't want to surface a
  // red "failure" to the user, and we don't want Claude to abandon the
  // turn. So we:
  //   1) Remember that the user approved this turn (`planApprovedThisTurn`).
  //   2) After every tool_result is parsed, scan the tool tracker for any
  //      ExitPlanMode tool that landed in "failure" state and rewrite it
  //      to "success" with an explanatory output. The UI then renders the
  //      tool the way the user expects.
  //   3) Set `pendingPlanApprovalContinuation` so that when the SDK ends
  //      the turn (which it usually does after a failed ExitPlanMode), we
  //      re-prompt Claude with a non-plan-mode follow-up telling them to
  //      continue with implementation.
  //
  // If the SDK behaves correctly (the expected case post-fix), the
  // ExitPlanMode tool is already in "success" state and none of the
  // override / re-prompt logic fires. The fallback is silent and free.
  // ---------------------------------------------------------------------
  let planApprovedThisTurn = false;
  let pendingPlanApprovalContinuation: string | null = null;

  // Parts exactly as last published to subscribers. Compared against the
  // freshly built parts to decide what a frame actually needs to carry.
  // Snapshotting the array is enough because parts are never mutated in
  // place: `ToolTracker` replaces a tool's object when its result lands, and
  // text/thinking parts are rebuilt from scratch each time.
  let publishedParts: NormalizedPart[] = [];
  let publishedMessageId: string | null = null;
  let publishedModelId: string | undefined;

  const emitCurrentAssistantMessage = () => {
    if (!currentAssistantMessage) return;
    const parts = currentAssistantMessage.parts;

    // A subscriber cannot patch a message it has never seen, so the first
    // frame for each message is always the whole thing.
    if (publishedMessageId !== currentAssistantMessage.id) {
      publishedMessageId = currentAssistantMessage.id;
      publishedParts = parts.slice();
      publishedModelId = currentAssistantMessage.modelId;
      // Stamped on the message itself, before it is serialized, so both this
      // frame and any REST read of the transcript agree on the revision.
      currentAssistantMessage.revision = (currentAssistantMessage.revision ?? 0) + 1;
      eventEmitter.emit({
        type: "message.updated",
        sessionId,
        data: { message: currentAssistantMessage },
      });
      return;
    }

    // Model metadata is message-level, not part-level. If the authoritative
    // SDK response resolves after streamed parts have already been published,
    // send one full frame so live subscribers learn the same model REST
    // hydration will return.
    if (publishedModelId !== currentAssistantMessage.modelId) {
      publishedParts = parts.slice();
      publishedModelId = currentAssistantMessage.modelId;
      currentAssistantMessage.revision = (currentAssistantMessage.revision ?? 0) + 1;
      eventEmitter.emit({
        type: "message.updated",
        sessionId,
        data: { message: currentAssistantMessage },
      });
      return;
    }

    const changedParts: { index: number; part: NormalizedPart }[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part && !isSamePublishedPart(publishedParts[index], part)) {
        changedParts.push({ index, part });
      }
    }

    // Nothing moved and nothing was dropped: a frame here would only cost
    // the client a re-render of identical content. The revision must not
    // advance either — no frame was published, so nobody fell behind.
    if (changedParts.length === 0 && parts.length === publishedParts.length) {
      return;
    }

    publishedParts = parts.slice();
    currentAssistantMessage.revision = (currentAssistantMessage.revision ?? 0) + 1;
    eventEmitter.emit({
      type: "message.patched",
      sessionId,
      data: {
        messageId: currentAssistantMessage.id,
        partCount: parts.length,
        changedParts,
        createdAt: currentAssistantMessage.createdAt,
        revision: currentAssistantMessage.revision,
      } satisfies MessagePatchEventData,
    });
  };

  // Streamed-delta coalescing state. Deltas land in `blocksByApiMessage`
  // immediately; the expensive snapshot (ordered-part rebuild, part build,
  // full-message emit) happens at most once per flushIntervalMs.
  let streamEventsDirty = false;
  let lastStreamMessageKey: string | null = null;
  let lastStreamModelId: string | undefined;

  const flushStreamedAssistantMessage = () => {
    if (streamEventFlushTimer) {
      clearTimeout(streamEventFlushTimer);
      streamEventFlushTimer = null;
    }
    if (!streamEventsDirty) return;
    streamEventsDirty = false;

    rebuildAccumulatedOrderedParts();
    const finalParts = buildMessageParts(accumulatedOrderedParts, toolTracker);
    const content = getMessageTextFromParts(finalParts);

    if (!currentAssistantMessage) {
      if (!lastStreamMessageKey) return;
      currentAssistantMessage = {
        id: lastStreamMessageKey,
        role: "assistant",
        content,
        parts: finalParts,
        createdAt: new Date().toISOString(),
        ...(lastStreamModelId ? { modelId: lastStreamModelId } : {}),
      };
      session.messages.push(currentAssistantMessage);
    } else {
      currentAssistantMessage.content = content;
      currentAssistantMessage.parts = finalParts;
    }

    emitCurrentAssistantMessage();
  };

  const scheduleStreamedAssistantMessageFlush = () => {
    streamEventsDirty = true;
    streamEventFlushTimer ??= setTimeout(() => {
      streamEventFlushTimer = null;
      flushStreamedAssistantMessage();
    }, flushIntervalMs);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyPartialAssistantMessage = (partialMessage: any): boolean => {
    const streamEvent = partialMessage.event;
    const eventType = streamEvent?.type;
    const explicitParentTaskUseId =
      typeof partialMessage.parent_tool_use_id === "string" &&
      partialMessage.parent_tool_use_id.length > 0
        ? partialMessage.parent_tool_use_id
        : undefined;

    // `message_start` is the only stream event carrying the API message id;
    // every later event for the same message must inherit it.
    if (eventType === "message_start") {
      const apiMessageId =
        typeof streamEvent.message?.id === "string" ? streamEvent.message.id : undefined;
      currentStreamApiMessageId = apiMessageId ?? null;
      const isRootAssistant = isRootAssistantRecord(
        partialMessage.parent_tool_use_id,
        partialMessage.isSidechain,
      );
      const modelId = isRootAssistant
        ? normalizeBackendModelId(streamEvent.message?.model)
        : undefined;
      if (modelId) lastStreamModelId = modelId;
      if (apiMessageId) {
        getBlocksForMessage(apiMessageId);
        if (explicitParentTaskUseId) {
          parentTaskByApiMessage.set(apiMessageId, explicitParentTaskUseId);
        }
      }
      return false;
    }

    if (eventType === "message_stop") {
      currentStreamApiMessageId = null;
      return false;
    }

    const blockIndex =
      Number.isInteger(streamEvent?.index) &&
      streamEvent.index >= 0 &&
      streamEvent.index <= maxBlockIndex
        ? streamEvent.index
        : undefined;
    if (blockIndex === undefined) {
      return false;
    }

    // Only fall back to the event uuid when no `message_start` was seen, which
    // real SDK streams always send before any block event.
    const messageKey =
      currentStreamApiMessageId ??
      (typeof partialMessage.uuid === "string" ? partialMessage.uuid : undefined);
    if (!messageKey) {
      return false;
    }
    const parentTaskUseId = explicitParentTaskUseId ?? parentTaskByApiMessage.get(messageKey);
    if (explicitParentTaskUseId) {
      parentTaskByApiMessage.set(messageKey, explicitParentTaskUseId);
    }

    const entriesForMessage = getBlocksForMessage(messageKey);
    let entry = entriesForMessage.get(blockIndex);

    // Append a streamed delta without rebuilding the block's string: chunks
    // are buffered on the entry and joined once per flush. A delta whose
    // type disagrees with the existing entry starts a fresh entry seeded
    // with the old (materialized) value, preserving the previous behavior.
    const appendStreamedDelta = (type: "text" | "thinking", chunk: string): OrderedPartEntry => {
      if (entry?.type === type) {
        entry.parentTaskUseId ??= parentTaskUseId;
        (entry.pendingChunks ??= []).push(chunk);
        return entry;
      }
      if (entry) materializeEntryValue(entry);
      return {
        type,
        value: `${entry?.value ?? ""}${chunk}`,
        timestamp: entry?.timestamp ?? new Date().toISOString(),
        messageUuid: messageKey,
        parentTaskUseId: entry?.parentTaskUseId ?? parentTaskUseId,
      };
    };

    if (eventType === "content_block_start") {
      const contentBlock = streamEvent.content_block;
      if (contentBlock?.type === "text") {
        entry = {
          type: "text",
          value: typeof contentBlock.text === "string" ? contentBlock.text : "",
          timestamp: entry?.timestamp ?? new Date().toISOString(),
          messageUuid: messageKey,
          parentTaskUseId,
        };
      } else if (contentBlock?.type === "thinking") {
        entry = {
          type: "thinking",
          value: typeof contentBlock.thinking === "string" ? contentBlock.thinking : "",
          timestamp: entry?.timestamp ?? new Date().toISOString(),
          messageUuid: messageKey,
          parentTaskUseId,
        };
      } else {
        return false;
      }
    } else if (eventType === "content_block_delta") {
      const delta = streamEvent.delta;
      if (delta?.type === "text_delta") {
        entry = appendStreamedDelta("text", typeof delta.text === "string" ? delta.text : "");
      } else if (delta?.type === "thinking_delta") {
        entry = appendStreamedDelta(
          "thinking",
          typeof delta.thinking === "string" ? delta.thinking : "",
        );
      } else {
        return false;
      }
    } else {
      return false;
    }

    entriesForMessage.set(blockIndex, entry);
    lastStreamMessageKey = messageKey;
    scheduleStreamedAssistantMessageFlush();
    return true;
  };

  return {
    get currentAssistantMessage() {
      return currentAssistantMessage;
    },
    set currentAssistantMessage(value) {
      currentAssistantMessage = value;
    },
    toolTracker,
    taskRegistry,
    activeTaskIds,
    finalizedBlockCountByApiMessage,
    getBlocksForMessage,
    rebuildAccumulatedOrderedParts,
    emitCurrentAssistantMessage,
    get syntheticMessageKeyCounter() {
      return syntheticMessageKeyCounter;
    },
    set syntheticMessageKeyCounter(value) {
      syntheticMessageKeyCounter = value;
    },
    get accumulatedOrderedParts() {
      return accumulatedOrderedParts;
    },
    set accumulatedOrderedParts(value) {
      accumulatedOrderedParts = value;
    },
    get pendingPlanRejectionFeedback() {
      return pendingPlanRejectionFeedback;
    },
    set pendingPlanRejectionFeedback(value) {
      pendingPlanRejectionFeedback = value;
    },
    get planApprovedThisTurn() {
      return planApprovedThisTurn;
    },
    set planApprovedThisTurn(value) {
      planApprovedThisTurn = value;
    },
    get pendingPlanApprovalContinuation() {
      return pendingPlanApprovalContinuation;
    },
    set pendingPlanApprovalContinuation(value) {
      pendingPlanApprovalContinuation = value;
    },
    flushStreamedAssistantMessage,
    applyPartialAssistantMessage,
    clearFlushTimer: () => {
      if (streamEventFlushTimer) {
        clearTimeout(streamEventFlushTimer);
        streamEventFlushTimer = null;
      }
    },
  };
}
