import { randomBytes } from "node:crypto";
import { RecentlyRevisedRows } from "@orkestrator/protocol/node/revised-rows";
import {
  MAX_EVICTED_TOOL_CALL_IDS,
  MAX_MODEL_ID_BYTES,
  SOFT_PARTS_PER_ROW,
  type BridgeMessage,
  type BridgeMessagePart,
  type BridgeToolPart,
  type SessionState,
  trimmedToolCalls,
} from "./acp-context.js";

/**
 * Which transcript row an update belongs to.
 *
 * Each model response is a row of its own. A turn the agent keeps working on
 * runs for hours, and folding it into one row produced a multi-megabyte message
 * that fits no transcript window: readers could only show a front-trimmed copy,
 * and lost its start for good once newer rows pushed it out of the live tail.
 *
 * ACP has no per-model-call event. A provider message id marks a response
 * when the agent sends one; without it, a tool call ends the response that
 * issued it, so prose or thinking after one opens the next row. Tool calls
 * join the trailing row, the response that made them, until it holds
 * `SOFT_PARTS_PER_ROW` parts. A late update finds the row holding its call,
 * wherever that is now.
 *
 * Depends on `acp-context` alone, so every module that places parts can share it.
 */

/** Index of the first row of the turn the transcript ends in. */
export function turnStartIndex(state: SessionState): number {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (state.messages[index]!.role === "user") return index + 1;
  }
  // The turn's prompt was evicted, or this is a replay with no user rows.
  return 0;
}

/**
 * Whether `message` ends in a tool call. An assistant chunk without a provider
 * message id that arrives after one belongs to the model's next response.
 */
export function endsWithToolCall(message: BridgeMessage): boolean {
  return message.parts.at(-1)?.type === "tool-invocation";
}

/**
 * Whether new top-level content should open the next row rather than join
 * `message`. A provider that issues calls back to back with no prose between
 * gives no response boundary at all, and one row would otherwise grow to the
 * hard cap and be front-trimmed.
 */
export function rowIsFull(message: BridgeMessage): boolean {
  return message.parts.length >= SOFT_PARTS_PER_ROW;
}

export function toolPartIn(message: BridgeMessage, toolUseId: string): BridgeToolPart | undefined {
  return message.parts.find(
    (part): part is BridgeToolPart =>
      part.type === "tool-invocation" && part.toolUseId === toolUseId,
  );
}

/**
 * The part for `toolUseId` in rows at or after `fromIndex`, newest row first.
 * Bounded by the transcript itself: `MAX_MESSAGES` rows of at most
 * `MAX_PARTS_PER_MESSAGE` parts, and the trailing row, where nearly every
 * update lands, is checked first.
 */
export function findToolPart(
  state: SessionState,
  toolUseId: string,
  fromIndex = 0,
): { owner: BridgeMessage; part: BridgeToolPart } | undefined {
  for (let index = state.messages.length - 1; index >= fromIndex; index -= 1) {
    const owner = state.messages[index]!;
    const part = toolPartIn(owner, toolUseId);
    if (part) return { owner, part };
  }
  return undefined;
}

/** The newest part of the current turn that matches, wherever its row is. */
export function findTurnPart<TPart extends BridgeMessagePart>(
  state: SessionState,
  matches: (part: BridgeMessagePart) => part is TPart,
): { owner: BridgeMessage; part: TPart } | undefined {
  const start = turnStartIndex(state);
  for (let index = state.messages.length - 1; index >= start; index -= 1) {
    const owner = state.messages[index]!;
    for (let partIndex = owner.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = owner.parts[partIndex]!;
      if (matches(part)) return { owner, part };
    }
  }
  return undefined;
}

/**
 * The row a new tool call or plan joins: the trailing assistant row while a
 * turn runs or a replay hydrates and it has room, otherwise a fresh one.
 */
export function currentAssistantMessage(state: SessionState): BridgeMessage {
  let message = state.messages.at(-1);
  // A hydrating replay is idle by definition, so requiring "running" here would
  // open a fresh, empty assistant message for every tool call in the history.
  if (
    !message ||
    message.role !== "assistant" ||
    rowIsFull(message) ||
    (state.status !== "running" && state.historyReplay !== "hydrate")
  ) {
    const modelId = boundedModelId(state.sessionConfig.composer.selectedModelId);
    message = {
      id: randomBytes(12).toString("hex"),
      role: "assistant",
      content: "",
      parts: [],
      createdAt: new Date().toISOString(),
      ...(modelId ? { modelId } : {}),
    };
    state.messages.push(message);
  }
  return message;
}

/**
 * A model id is an identifier, not display text, so an oversized or non-string
 * value is dropped rather than truncated — exactly as `session-config.ts`
 * rejects an over-long `selectedModelId` instead of shortening it. A truncated
 * id would match no catalogue entry and would render as a plausible-looking
 * model the agent never actually ran; absent renders as "no model recorded".
 */
export function boundedModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > MAX_MODEL_ID_BYTES) return undefined;
  return trimmed;
}

/**
 * Record that `message` changed. Only a row with a newer one after it counts:
 * the trailing row is what every read re-sends anyway. Such a row moves the
 * incremental floor and is noted for the v2 summary's `revisedMessages`, which
 * reaches readers once the row has left the live window.
 */
export function noteMessageMutation(state: SessionState, message: BridgeMessage): void {
  if (state.messages.at(-1) === message) return;
  const index = state.messages.lastIndexOf(message);
  if (index < 0) return;
  noteRevisedRow(state, index);
}

/** `noteMessageMutation` for the row holding `part`. */
export function notePartMutation(state: SessionState, part: BridgeMessagePart): void {
  const last = state.messages.at(-1);
  if (!last || last.id === part.sourceMessageId) return;
  for (let index = state.messages.length - 2; index >= 0; index -= 1) {
    const message = state.messages[index]!;
    if (message.id === part.sourceMessageId && message.parts.includes(part)) {
      noteRevisedRow(state, index);
      return;
    }
  }
  // A part whose `sourceMessageId` names no retained row (restored from an
  // older state file, say) is found by identity instead.
  if (last.parts.includes(part)) return;
  for (let index = state.messages.length - 2; index >= 0; index -= 1) {
    if (state.messages[index]!.parts.includes(part)) {
      noteRevisedRow(state, index);
      return;
    }
  }
}

function noteRevisedRow(state: SessionState, index: number): void {
  const absoluteIndex = state.droppedMessages + index;
  if (state.mutatedMessageFloor === undefined || absoluteIndex < state.mutatedMessageFloor) {
    state.mutatedMessageFloor = absoluteIndex;
  }
  (state.revisedRows ??= new RecentlyRevisedRows()).note(state.messages[index]!.id);
}

/**
 * Remember the tool calls on rows `boundTranscript` just evicted, including
 * any a trim had already removed from them, and forget their revision notes:
 * an evicted row is reached through history paging, not `revisedMessages`.
 */
export function rememberEvictedRows(state: SessionState, evicted: readonly BridgeMessage[]): void {
  for (const message of evicted) {
    state.revisedRows?.forget(message.id);
    const ids = message.parts.flatMap((part) =>
      part.type === "tool-invocation" ? [part.toolUseId] : [],
    );
    for (const id of [...(trimmedToolCalls.get(message) ?? []), ...ids]) {
      const evictedIds = (state.evictedToolCallIds ??= new Set());
      evictedIds.delete(id);
      evictedIds.add(id);
      if (evictedIds.size > MAX_EVICTED_TOOL_CALL_IDS) {
        const oldest = evictedIds.values().next().value;
        if (oldest !== undefined) evictedIds.delete(oldest);
      }
    }
  }
}

/**
 * Whether a late update for `toolUseId` must be dropped because its part is
 * gone: its row was evicted, or a trim removed it from a row that remains.
 * Rebuilding it would add an empty `Tool call` to the trailing row, with none
 * of the title, arguments or output the original carried. A new `tool_call`
 * reusing the id starts a call of its own instead.
 */
export function droppedToolCall(
  state: SessionState,
  toolUseId: string,
  isInitial: boolean,
): boolean {
  if (isInitial) {
    state.evictedToolCallIds?.delete(toolUseId);
    return false;
  }
  return (
    state.evictedToolCallIds?.has(toolUseId) === true ||
    state.messages.some((message) => trimmedToolCalls.get(message)?.has(toolUseId) === true)
  );
}
