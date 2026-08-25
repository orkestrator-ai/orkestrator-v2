/**
 * The adapter proper: Pi session events become transcript parts.
 *
 * Pi reports a turn as a stream of fine-grained `AgentSessionEvent`s.
 * Orkestrator's renderer consumes an append-and-patch transcript of messages
 * and parts. This module is the only place that knows both, and it holds two
 * rules the rest of the bridge depends on:
 *
 *  - It never awaits. Events arrive on the SDK's own listener and every branch
 *    here is synchronous, so a slow consumer can never stall the run that is
 *    producing them.
 *  - It charges every byte it appends against the transcript budget, so a long
 *    turn is bounded by `boundTranscript` rather than by hope.
 */
import { randomBytes } from "node:crypto";
import { MAX_TOOL_TITLE_BYTES } from "./config.js";
import { renderToolCall } from "./tool-rendering.js";
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

/**
 * Apply one session event to the transcript.
 *
 * Unknown event types are ignored rather than rejected. Pi adds vocabulary
 * faster than this bridge can track it, and an unrecognized frame mid-turn
 * must degrade to "not rendered", never to a failed turn.
 */
export function applySessionEvent(state: SessionState, event: unknown): void {
  if (!isObject(event) || !nonBlank(event.type)) return;

  switch (event.type) {
    case "message_update":
      applyMessageUpdate(state, event.assistantMessageEvent);
      break;
    case "message_end":
      // The assistant message is final. A later delta belongs to a new one.
      state.openTextParts.clear();
      break;
    case "tool_execution_start":
      applyToolExecution(state, event, "pending");
      break;
    case "tool_execution_update":
      applyToolExecution(state, event, "pending");
      break;
    case "tool_execution_end":
      applyToolExecution(state, event, "settled");
      break;
    case "turn_end":
      applyTurnUsage(state, event.message);
      break;
    case "queue_update":
      applyQueueUpdate(state, event);
      break;
    case "compaction_start":
      state.compacting = true;
      state.revision += 1;
      break;
    case "compaction_end":
      state.compacting = false;
      applyCompaction(state, event);
      break;
    case "thinking_level_changed":
      applyThinkingLevel(state, event.level);
      break;
    case "session_info_changed":
      if (nonBlank(event.name)) {
        state.title = boundText(event.name.trim(), 512);
        state.revision += 1;
      }
      break;
    case "auto_retry_start":
      applyNotice(state, retryNotice(event));
      break;
    case "bash_execution_update":
      // A user-initiated `!command`, which this bridge never issues. Ignored
      // rather than rendered: it belongs to whoever ran it.
      break;
    default:
      break;
  }
}

/**
 * Fold one streaming assistant-message event into the open blocks.
 *
 * Only the text and thinking deltas are rendered. Tool-call deltas are
 * deliberately skipped: `tool_execution_start` reports the same call with
 * validated arguments, and rendering the raw argument JSON as it streams would
 * show a card twice, once as malformed JSON.
 */
function applyMessageUpdate(state: SessionState, event: unknown): void {
  if (!isObject(event) || !nonBlank(event.type)) return;
  switch (event.type) {
    case "text_delta":
      applyTextDelta(state, readText(event.delta), "text");
      break;
    case "thinking_delta":
      applyTextDelta(state, readText(event.delta), "thinking");
      break;
    case "text_end":
      state.openTextParts.delete("text");
      break;
    case "thinking_end":
      state.openTextParts.delete("thinking");
      break;
    case "error":
      // The turn's own terminal path records the failure authoritatively; this
      // only stops a later delta continuing a block the error ended.
      state.openTextParts.clear();
      break;
    default:
      break;
  }
}

function applyTextDelta(state: SessionState, text: string, kind: "text" | "thinking"): void {
  if (!text) return;
  const message = currentAssistantMessage(state);
  const existing = openTextPart(state, message, kind);
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
    };
    message.parts.push(part);
    state.openTextParts.set(kind, part.sourcePartId);
    chargeTranscript(state, text.length + 128);
  }

  // `content` is the flat text the transcript exposes as the message body, and
  // reasoning is not part of it: it is shown in its own collapsed block.
  if (kind === "text") {
    message.content = appendBounded(message, message.content, text);
    if (state.currentTurnOutput !== null) {
      state.currentTurnOutput = appendBounded(message, state.currentTurnOutput, text);
    }
  }
  state.revision += 1;
}

function applyToolExecution(
  state: SessionState,
  event: JsonObject,
  phase: "pending" | "settled",
): void {
  const toolCallId = nonBlank(event.toolCallId) ? event.toolCallId : undefined;
  if (!toolCallId) return;
  const rendered = renderToolCall({
    toolName: nonBlank(event.toolName) ? event.toolName : "tool",
    input: event.args,
    // `tool_execution_update` streams a partial result under its own key; the
    // end frame carries the final one. Both render through the same path so a
    // long `bash` call fills in as it runs.
    result: phase === "settled" ? event.result : event.partialResult,
    isError: event.isError === true,
  });

  const message = currentAssistantMessage(state);
  // A tool card is a discrete block, so the prose around it must not keep
  // growing behind it — otherwise text produced after the call is folded into
  // the paragraph that preceded it and appears above the card that caused it.
  closeTextParts(state);
  const part = upsertToolPart(state, message, toolCallId);

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
    // The list is session-wide, so hold the newest one for restart recovery as
    // well as stamping it on the card that carried it.
    state.todos = rendered.todos;
  }

  chargeToolPart(state, part);
  state.revision += 1;
}

/**
 * Record the usage the finished turn reported.
 *
 * Accumulated rather than replaced: one prompt can run many turns, and the tab
 * shows what the *prompt* cost. `reasoning` is deliberately not added into the
 * total — Pi documents it as a subset of `output`, so counting it separately
 * would double-bill every thinking model.
 */
function applyTurnUsage(state: SessionState, message: unknown): void {
  if (!isObject(message) || !isObject(message.usage)) return;
  const usage = message.usage;
  const turn: TurnUsage = { ...state.currentTurnUsage };
  add(turn, "inputTokens", usage.input);
  add(turn, "outputTokens", usage.output);
  add(turn, "cacheReadTokens", usage.cacheRead);
  add(turn, "cacheWriteTokens", usage.cacheWrite);
  add(turn, "reasoningTokens", usage.reasoning);
  state.currentTurnUsage = turn;
}

function add(turn: TurnUsage, key: keyof TurnUsage, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  turn[key] = (turn[key] ?? 0) + value;
}

function applyQueueUpdate(state: SessionState, event: JsonObject): void {
  state.queue = {
    steering: readStringList(event.steering),
    followUp: readStringList(event.followUp),
  };
  state.revision += 1;
}

/**
 * Show a completed compaction as its own card.
 *
 * Context compaction rewrites the conversation the model reads, so a user who
 * cannot see it happen has no way to explain why the agent forgot something.
 * Rendering it as a card keeps it visible without letting it read as assistant
 * prose.
 */
function applyCompaction(state: SessionState, event: JsonObject): void {
  if (event.aborted === true) {
    state.revision += 1;
    return;
  }
  const summary =
    isObject(event.result) && nonBlank(event.result.summary) ? event.result.summary : "";
  const message = currentAssistantMessage(state);
  closeTextParts(state);
  const part = upsertToolPart(state, message, `compaction:${message.parts.length}`);
  part.toolName = "compact_context";
  part.content = "Compacted context";
  part.toolTitle = part.content;
  const failed = nonBlank(event.errorMessage);
  part.toolState = failed ? "failure" : "success";
  if (failed) part.toolError = boundText(event.errorMessage as string, MAX_TOOL_TITLE_BYTES);
  else if (summary) part.toolOutput = boundText(summary, MAX_TOOL_TITLE_BYTES * 32);
  chargeToolPart(state, part);
  state.revision += 1;
}

/**
 * Adopt the thinking level Pi actually settled on.
 *
 * Pi clamps a requested level to what the model supports, and an extension can
 * change it outright, so the level in flight is not always the one the picker
 * asked for. Echoing the change back is what stops the control showing a
 * selection the run is not using — the failure mode is silent, because a
 * clamped turn succeeds and simply thinks less than the user asked it to.
 */
function applyThinkingLevel(state: SessionState, level: unknown): void {
  if (!nonBlank(level) || state.composer.selectedReasoningId === level) return;
  state.composer = { ...state.composer, selectedReasoningId: level };
  state.revision += 1;
}

function retryNotice(event: JsonObject): string {
  const attempt = typeof event.attempt === "number" ? event.attempt : 0;
  const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : 0;
  const reason = nonBlank(event.errorMessage) ? event.errorMessage.trim() : "the request failed";
  return attempt && maxAttempts
    ? `Retrying (${attempt}/${maxAttempts}): ${reason}`
    : `Retrying: ${reason}`;
}

/**
 * Render a transient run notice as a settled card.
 *
 * A retry is the one thing that happens *between* turns and still changes what
 * the user should expect, so it earns a line in the transcript rather than a
 * silent pause the tab cannot explain.
 */
function applyNotice(state: SessionState, text: string): void {
  const message = currentAssistantMessage(state);
  closeTextParts(state);
  const part = upsertToolPart(state, message, `notice:${message.parts.length}`);
  part.toolName = "notice";
  part.content = boundText(text, MAX_TOOL_TITLE_BYTES);
  part.toolTitle = part.content;
  part.toolState = "success";
  chargeToolPart(state, part);
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

/**
 * The part this delta should continue, or undefined to start a new one.
 *
 * Tracked explicitly rather than by looking at the trailing part, because Pi
 * interleaves reasoning and prose freely: a single `thinking_delta` landing
 * between two `text_delta`s would make the trailing part the wrong kind, and
 * every subsequent chunk would open yet another block. The result is a
 * transcript chopped mid-sentence into dozens of alternating fragments.
 */
function openTextPart(
  state: SessionState,
  message: BridgeMessage,
  kind: "text" | "thinking",
): BridgeTextPart | undefined {
  const sourcePartId = state.openTextParts.get(kind);
  if (!sourcePartId) return undefined;
  for (const part of message.parts) {
    if (part.type === kind && part.sourcePartId === sourcePartId) return part;
  }
  // The part was trimmed, or belongs to an earlier message. Either way it can
  // no longer be appended to.
  return undefined;
}

function closeTextParts(state: SessionState): void {
  state.openTextParts.delete("text");
  state.openTextParts.delete("thinking");
}

function upsertToolPart(
  state: SessionState,
  message: BridgeMessage,
  toolCallId: string,
): BridgeToolPart {
  for (const part of message.parts) {
    if (part.type === "tool-invocation" && part.toolUseId === toolCallId) return part;
  }
  const part: BridgeToolPart = {
    type: "tool-invocation",
    content: "",
    sourcePartId: `${message.id}:${message.parts.length}`,
    sourceMessageId: message.id,
    toolUseId: toolCallId,
    createdAt: new Date().toISOString(),
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

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
