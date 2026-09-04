/**
 * The adapter proper: Cursor SDK interaction updates become transcript parts.
 *
 * The SDK reports a turn as a stream of fine-grained `InteractionUpdate`s.
 * Orkestrator's renderer consumes an append-and-patch transcript of messages
 * and parts. This module is the only place that knows both, and it holds two
 * rules that the rest of the bridge depends on:
 *
 *  - It never awaits. Updates arrive on the SDK's own callback and every
 *    branch here is synchronous, so a slow consumer can never stall the run
 *    that is producing them.
 *  - It charges every byte it appends against the transcript budget, so a
 *    long turn is bounded by `boundTranscript` rather than by hope.
 */
import { randomBytes } from "node:crypto";
import {
  MAX_ACTIVE_SUBAGENTS_PER_SESSION,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_TITLE_BYTES,
} from "./config.js";
import { renderToolCall, type RenderedToolCall } from "./tool-rendering.js";
import { appendBounded, boundText, chargeTranscript } from "./transcript.js";
import {
  isObject,
  nonBlank,
  toolSourceStates,
  type BridgeMessage,
  type BridgeTextPart,
  type BridgeToolPart,
  type JsonObject,
  type SessionState,
  type TurnUsage,
} from "./state.js";

/** A nested update carries the launch call it belongs to; a top-level one does not. */
interface UpdateContext {
  parentTaskUseId?: string;
}

/**
 * Apply one interaction update to the session transcript.
 *
 * Unknown update types are ignored rather than rejected. The SDK adds
 * vocabulary faster than this bridge can track it, and an unrecognized frame
 * mid-turn must degrade to "not rendered", never to a failed turn.
 */
export function applyInteractionUpdate(
  state: SessionState,
  update: unknown,
  context: UpdateContext = {},
): void {
  if (!isObject(update) || !nonBlank(update.type)) return;

  switch (update.type) {
    case "text-delta":
      applyTextDelta(state, readText(update.text), "text", context);
      break;
    case "thinking-delta":
      applyTextDelta(state, readText(update.text), "thinking", context);
      break;
    case "thinking-completed":
      // The reasoning block is finished; later reasoning is a new one.
      state.openTextParts.delete(openTextKey("thinking", context.parentTaskUseId));
      break;
    case "partial-tool-call":
    case "tool-call-started":
      applyToolCall(state, update, "pending", context);
      break;
    case "tool-call-completed":
      applyToolCall(state, update, "settled", context);
      break;
    case "tool-call-delta":
      // A sub-agent's own activity, addressed by the launch call that owns it.
      applyInteractionUpdate(state, update.taskUpdate, {
        parentTaskUseId: nonBlank(update.callId) ? update.callId : context.parentTaskUseId,
      });
      break;
    case "shell-output-delta":
      applyShellOutputDelta(state, update, context);
      break;
    case "summary":
      applySummary(state, readText(update.summary), context);
      break;
    case "turn-ended":
      // Nested task usage belongs to the child model context. Folding it into
      // the parent would make the parent's live context gauge jump to an
      // unrelated window and can double-count work the SDK later reports on
      // the parent run.
      if (!context.parentTaskUseId) applyTurnUsage(state, update.usage);
      break;
    default:
      break;
  }
}

function applyTextDelta(
  state: SessionState,
  text: string,
  kind: "text" | "thinking",
  context: UpdateContext,
): void {
  if (!text) return;
  const message = currentAssistantMessage(state);
  const existing = openTextPart(state, message, kind, context.parentTaskUseId);
  if (existing) {
    const before = existing.content.length;
    existing.content = appendBounded(existing, existing.content, text);
    chargeTranscript(state, existing.content.length - before);
  } else {
    const part: BridgeTextPart = {
      type: kind,
      content: text,
      sourcePartId: `${message.id}:${message.parts.length}`,
      sourceMessageId: message.id,
      createdAt: new Date().toISOString(),
      ...(context.parentTaskUseId ? { parentTaskUseId: context.parentTaskUseId } : {}),
    };
    message.parts.push(part);
    state.openTextParts.set(openTextKey(kind, context.parentTaskUseId), part.sourcePartId);
    chargeTranscript(state, text.length + 128);
  }

  // `content` is the flat text the transcript exposes as the message body.
  // Only top-level assistant prose belongs there: a sub-agent's output is
  // shown inside its own card, and folding it in would duplicate it.
  if (kind === "text" && !context.parentTaskUseId) {
    message.content = appendBounded(message, message.content, text);
    if (state.currentTurnOutput !== null) {
      state.currentTurnOutput = appendBounded(message, state.currentTurnOutput, text);
    }
  }
  state.revision += 1;
}

function applyToolCall(
  state: SessionState,
  update: JsonObject,
  phase: "pending" | "settled",
  context: UpdateContext,
): void {
  const callId = nonBlank(update.callId) ? update.callId : undefined;
  if (!callId) return;
  const rendered = renderToolCall(update.toolCall);
  const message = currentAssistantMessage(state);
  closeTextParts(state, context.parentTaskUseId);
  const part = upsertToolPart(state, message, callId, context.parentTaskUseId);

  part.toolName = rendered.toolName;
  part.content = rendered.toolTitle
    ? boundText(rendered.toolTitle, MAX_TOOL_TITLE_BYTES)
    : rendered.toolName;
  part.toolTitle = part.content;
  if (rendered.toolArgs) part.toolArgs = rendered.toolArgs;
  if (rendered.toolOutput !== undefined) part.toolOutput = rendered.toolOutput;
  if (rendered.toolError !== undefined) part.toolError = rendered.toolError;
  if (rendered.toolDiff) part.toolDiff = rendered.toolDiff;

  if (phase === "settled") {
    part.toolState = rendered.toolError === undefined ? "success" : "failure";
  } else if (part.toolState === undefined) {
    part.toolState = "pending";
  }

  if (rendered.todos) {
    // The list is session-wide, so hold the newest one for restart recovery
    // as well as stamping it on the card that carried it.
    state.todos = rendered.todos;
  }
  if (rendered.subagent) applySubagentLifecycle(state, part, rendered, phase);

  // A settled shell call supersedes whatever was streamed into it, so drop the
  // streaming buffer rather than letting it grow for the rest of the session.
  if (phase === "settled") toolSourceStates.delete(part);
  chargeToolPart(state, part);
  state.revision += 1;
}

/**
 * Track the lifecycle of a sub-agent launched by a `task` call.
 *
 * `agentState` is deliberately separate from `toolState`: Cursor completes a
 * *background* launch as soon as the child starts, so a card whose call
 * succeeded may still have work running behind it.
 */
function applySubagentLifecycle(
  state: SessionState,
  part: BridgeToolPart,
  rendered: RenderedToolCall,
  phase: "pending" | "settled",
): void {
  const subagent = rendered.subagent!;
  if (phase === "pending") {
    if (
      !state.activeSubagentDescriptors.has(part.toolUseId) &&
      state.activeSubagentDescriptors.size >= MAX_ACTIVE_SUBAGENTS_PER_SESSION
    ) {
      // Silently dropping a child would let `/activity` answer idle while it
      // is still writing files. Latch the session instead.
      state.subagentLimitExceeded = true;
      return;
    }
    state.activeSubagentDescriptors.set(part.toolUseId, {
      description: subagent.description,
      subagentType: subagent.subagentType,
      agentId: subagent.agentId,
      toolState: "pending",
    });
    part.agentState = "active";
    return;
  }

  const failed = rendered.toolError !== undefined;
  if (subagent.isBackground && !failed) {
    // The launch returned but the child keeps running. Hold it open so
    // `/activity` reports the environment as busy; `settleBackgroundChildren`
    // closes it when the parent run ends, which is the last point at which
    // this bridge can still observe the child at all.
    const descriptor = state.activeSubagentDescriptors.get(part.toolUseId);
    if (descriptor) descriptor.toolState = "success";
    part.agentState = "active";
    return;
  }
  state.activeSubagentDescriptors.delete(part.toolUseId);
  part.agentState = failed ? "failed" : "finished";
}

/**
 * Close out background children when their parent run ends.
 *
 * A background sub-agent genuinely outlives the turn that launched it, but the
 * SDK reports it only through nested updates on that run — once the run is
 * over there is no channel left to observe it on. Holding the card active
 * would report the environment as permanently busy and stall every caller that
 * waits for idle, so the card settles here and says plainly that the child was
 * detached rather than claiming it completed.
 */
export function settleBackgroundChildren(state: SessionState): void {
  if (state.activeSubagentDescriptors.size === 0) return;
  const active = new Set(state.activeSubagentDescriptors.keys());
  state.activeSubagentDescriptors.clear();
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation" || !active.has(part.toolUseId)) continue;
      settleDetachedSubagentPart(part);
    }
  }
  state.revision += 1;
}

/** What a card says once nothing can observe its child any more. */
export const DETACHED_SUBAGENT_NOTE =
  "The turn ended while this sub-agent was still running in the background.";

/**
 * Close one sub-agent card, saying it was detached rather than that it finished.
 *
 * Shared with the restart path: a card persisted as `active` describes a child
 * of a process that no longer exists, so nothing will ever arrive to settle it
 * and the tab would show a sub-agent spinning forever.
 */
export function settleDetachedSubagentPart(part: BridgeToolPart): void {
  part.agentState = "finished";
  if (part.toolState === "pending") part.toolState = "success";
  part.toolOutput = part.toolOutput
    ? `${part.toolOutput}\n\n${DETACHED_SUBAGENT_NOTE}`
    : DETACHED_SUBAGENT_NOTE;
}

function applyShellOutputDelta(
  state: SessionState,
  update: JsonObject,
  context: UpdateContext,
): void {
  const text = readShellOutputText(update.event);
  if (!text) return;
  const message = currentAssistantMessage(state);
  // A shell delta names no call, so it belongs to the newest pending shell
  // card. Matching on the tool keeps a stray delta from appending to whatever
  // unrelated card happens to be last.
  const part = trailingPendingToolPart(message, "shell", context.parentTaskUseId);
  if (!part) return;
  const source = toolSourceStates.get(part) ?? {};
  source.streamedOutput = appendBounded(
    part,
    source.streamedOutput ?? "",
    text,
    MAX_TOOL_OUTPUT_BYTES,
  );
  toolSourceStates.set(part, source);
  part.toolOutput = source.streamedOutput;
  chargeToolPart(state, part);
  state.revision += 1;
}

/**
 * Pull display text out of a shell output event.
 *
 * The payload is an open record rather than a typed union, so read the fields
 * that carry text and ignore everything else instead of serializing a control
 * frame into the user's terminal output.
 */
function readShellOutputText(event: unknown): string {
  if (nonBlank(event)) return event;
  if (!isObject(event)) return "";
  for (const key of ["text", "chunk", "data", "output", "stdout", "stderr"]) {
    const value = event[key];
    if (nonBlank(value)) return value;
  }
  return "";
}

function applySummary(state: SessionState, summary: string, context: UpdateContext): void {
  if (!summary) return;
  const message = currentAssistantMessage(state);
  // Context compaction is a real event in the turn and the user should be able
  // to see what survived it. Rendering it as a card keeps it visible without
  // letting it read as assistant prose.
  const part = upsertToolPart(
    state,
    message,
    `summary:${message.parts.length}`,
    context.parentTaskUseId,
  );
  part.toolName = "compact_context";
  part.content = "Compacted context";
  part.toolTitle = part.content;
  part.toolState = "success";
  part.toolOutput = boundText(summary, MAX_TOOL_OUTPUT_BYTES);
  chargeToolPart(state, part);
  state.revision += 1;
}

function applyTurnUsage(state: SessionState, usage: unknown): void {
  if (!isObject(usage)) return;
  const turn: TurnUsage = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) turn[key] = value;
  }
  if (Object.keys(turn).length === 0) return;
  state.currentTurnUsage = mergeLatestUsage(state.currentTurnUsage, turn);
  state.currentRunDeltaUsage = sumUsage(state.currentRunDeltaUsage, turn);
  publishRunUsage(state);
}

/** Publish usage from runtimes that report it only on the run message stream. */
export function applyStreamUsage(state: SessionState, total: TurnUsage, latest: TurnUsage): void {
  state.currentRunStreamUsage = total;
  state.currentTurnUsage = latest;
  publishRunUsage(state);
}

const usageKeys = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

function mergeLatestUsage(current: TurnUsage | undefined, next: TurnUsage): TurnUsage {
  const merged = { ...current, ...next };
  if (next.totalTokens === undefined) delete merged.totalTokens;
  return merged;
}

function sumUsage(current: TurnUsage | undefined, next: TurnUsage): TurnUsage {
  const summed: TurnUsage = {};
  for (const key of usageKeys) {
    if (key === "totalTokens") continue;
    if (current?.[key] !== undefined || next[key] !== undefined) {
      summed[key] = (current?.[key] ?? 0) + (next[key] ?? 0);
    }
  }
  if (Object.keys(summed).length === 0) {
    summed.totalTokens = (current?.totalTokens ?? 0) + (next.totalTokens ?? 0);
  }
  return summed;
}

function usageLowerBound(...sources: Array<TurnUsage | undefined>): TurnUsage | undefined {
  const present = sources.filter((source): source is TurnUsage => source !== undefined);
  if (present.length === 0) return undefined;
  const lowerBound: TurnUsage = {};
  for (const key of usageKeys) {
    const values = present.flatMap((source) => (source[key] === undefined ? [] : [source[key]]));
    if (values.length > 0) lowerBound[key] = Math.max(...values);
  }
  return lowerBound;
}

function publishRunUsage(state: SessionState): void {
  const projected = usageLowerBound(state.currentRunDeltaUsage, state.currentRunStreamUsage);
  if (!projected) return;
  state.currentRunUsage = projected;
  state.currentRunUsageUpdatedAt = new Date().toISOString();
  // Token-only updates otherwise leave the revision unchanged, so a consumer
  // watching snapshots by revision would not know that the live meter moved.
  state.revision += 1;
}

/**
 * The assistant message this turn is writing into, created on first use.
 *
 * Deliberately lazy: a turn that produces nothing but tool calls still needs a
 * carrier, but a turn that fails before producing anything should not leave an
 * empty bubble in the transcript.
 */
export function currentAssistantMessage(state: SessionState): BridgeMessage {
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "assistant" && last.id === state.currentAssistantMessageId) return last;
  const message: BridgeMessage = {
    id: randomBytes(12).toString("hex"),
    role: "assistant",
    content: "",
    parts: [],
    createdAt: new Date().toISOString(),
    ...(state.composer.selectedModelId ? { modelId: state.composer.selectedModelId } : {}),
  };
  state.messages.push(message);
  state.currentAssistantMessageId = message.id;
  // Blocks belong to the message that opened them.
  state.openTextParts.clear();
  chargeTranscript(state, 256);
  return message;
}

function openTextKey(kind: "text" | "thinking", parentTaskUseId: string | undefined): string {
  return `${kind}\u0000${parentTaskUseId ?? ""}`;
}

/**
 * The part this delta should continue, or undefined to start a new one.
 *
 * Tracked explicitly rather than by looking at the trailing part, because
 * Cursor interleaves reasoning and prose freely: a single `thinking-delta`
 * landing between two `text-delta`s would make the trailing part the wrong
 * kind, and every subsequent chunk would open yet another block. The result is
 * a transcript chopped mid-sentence into dozens of alternating fragments.
 *
 * Keyed by sub-agent as well as kind, so a child's prose never continues the
 * parent's.
 */
function openTextPart(
  state: SessionState,
  message: BridgeMessage,
  kind: "text" | "thinking",
  parentTaskUseId: string | undefined,
): BridgeTextPart | undefined {
  const sourcePartId = state.openTextParts.get(openTextKey(kind, parentTaskUseId));
  if (!sourcePartId) return undefined;
  for (const part of message.parts) {
    if (part.type === kind && part.sourcePartId === sourcePartId) return part;
  }
  // The part was trimmed, or belongs to an earlier message. Either way it can
  // no longer be appended to.
  return undefined;
}

/**
 * Stop appending to the open blocks of this scope.
 *
 * Called when something discrete interrupts the prose — a completed reasoning
 * block, or a tool call, which the renderer shows as its own card. Without
 * this, text produced after a tool call would be folded back into the
 * paragraph that preceded it and appear above the card that caused it.
 */
function closeTextParts(state: SessionState, parentTaskUseId: string | undefined): void {
  state.openTextParts.delete(openTextKey("text", parentTaskUseId));
  state.openTextParts.delete(openTextKey("thinking", parentTaskUseId));
}

function trailingPendingToolPart(
  message: BridgeMessage,
  toolName: string,
  parentTaskUseId: string | undefined,
): BridgeToolPart | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]!;
    if (part.type !== "tool-invocation") continue;
    if (part.toolName !== toolName || part.parentTaskUseId !== parentTaskUseId) continue;
    return part.toolState === "pending" ? part : undefined;
  }
  return undefined;
}

function upsertToolPart(
  state: SessionState,
  message: BridgeMessage,
  callId: string,
  parentTaskUseId: string | undefined,
): BridgeToolPart {
  for (const part of message.parts) {
    if (part.type === "tool-invocation" && part.toolUseId === callId) return part;
  }
  const part: BridgeToolPart = {
    type: "tool-invocation",
    content: "",
    sourcePartId: `${message.id}:${message.parts.length}`,
    sourceMessageId: message.id,
    toolUseId: callId,
    createdAt: new Date().toISOString(),
    ...(parentTaskUseId ? { parentTaskUseId } : {}),
  };
  message.parts.push(part);
  chargeTranscript(state, 256);
  return part;
}

/**
 * Charge only what a patch added.
 *
 * Tool cards are rewritten in place on every streaming frame, so billing the
 * whole part each time would re-charge a one-megabyte diff per frame and force
 * a full transcript re-serialization behind it.
 */
function chargeToolPart(state: SessionState, part: BridgeToolPart): void {
  const source = toolSourceStates.get(part) ?? {};
  const size = Buffer.byteLength(JSON.stringify(part));
  chargeTranscript(state, Math.max(0, size - (source.chargedBytes ?? 0)));
  source.chargedBytes = size;
  toolSourceStates.set(part, source);
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
