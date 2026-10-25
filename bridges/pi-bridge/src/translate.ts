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
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  encodedJsonBytes,
  jsonStringContentBytes,
} from "@orkestrator/protocol/node/transcript-budget";
import { nextPartOrdinal, toolResultImagePartId } from "@orkestrator/protocol/transcript-part-ids";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { noteCommandOutput } from "./commands.js";
import { MAX_TOOL_TITLE_BYTES } from "./config.js";
import { renderToolCall, type RenderedToolCall } from "./tool-rendering.js";
import {
  appendBounded,
  boundText,
  boundTranscriptDuringStreaming,
  chargeTranscript,
  rowChanged,
} from "./transcript.js";
import {
  isObject,
  nonBlank,
  piRunId,
  setSteerJournal,
  toolSourceStates,
  type BridgeMessage,
  type BridgeCompactionPart,
  type BridgeImagePart,
  type BridgeRetryPart,
  type BridgeTextPart,
  type BridgeToolPart,
  type JsonObject,
  type SessionState,
  type TurnUsage,
} from "./state.js";

/**
 * Whether a turn-scoped frame still has an owner to render into.
 *
 * The SDK's listener is per *session*, not per run, so a frame carries nothing
 * that identifies which run produced it. A run this bridge has given up on —
 * one that outran `PROMPT_TIMEOUT_MS` and was aborted — can still emit for as
 * long as it takes Pi to wind down, and those frames would otherwise append to
 * a transcript already reported as failed and interleave with the next turn's
 * message.
 *
 * Session-scoped frames (the title, the thinking level, the queue, compaction)
 * are deliberately not gated: they are true whether or not a turn is running,
 * and dropping them would lose state the tab reads while idle.
 */
function turnFramesWelcome(state: SessionState): boolean {
  return state.status === "running" || state.compacting;
}

/**
 * Apply one session event to the transcript.
 *
 * Unknown event types are ignored rather than rejected. Pi adds vocabulary
 * faster than this bridge can track it, and an unrecognized frame mid-turn
 * must degrade to "not rendered", never to a failed turn.
 */
/**
 * Which Pi session events this translator accounts for.
 *
 * A `Record` over the SDK's own `AgentSessionEvent` union rather than a list,
 * so a Pi release that adds an event **fails this typecheck** instead of the
 * event arriving as an unexplained gap. `true` means the switch below does
 * something with it; `false` means known and deliberately not rendered, each
 * documented — "we chose not to show this" and "we never heard of this" must
 * not look the same in the drift counter.
 */
const HANDLED_SESSION_EVENTS: Record<AgentSessionEvent["type"], boolean> = {
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  turn_end: true,
  queue_update: true,
  compaction_start: true,
  compaction_end: true,
  thinking_level_changed: true,
  session_info_changed: true,
  auto_retry_start: true,
  auto_retry_end: true,
  bash_execution_update: true,
  // Read for its `aborted` verdict only (see `turnAborted`); never rendered.
  agent_settled: true,
  // Turn and agent lifecycle. The bridge derives running/idle from its own
  // dispatch rather than from these, so rendering them would add rows for
  // boundaries the transcript already shows through the messages inside them.
  turn_start: false,
  agent_start: false,
  agent_end: false,
  // Pi retrying a compaction's summary request: the shared retry row, settled
  // by `compaction_end`. A branch summary's retries are not rendered (see
  // `applySummarizationRetry`).
  summarization_retry_scheduled: true,
  summarization_retry_attempt_start: true,
  summarization_retry_finished: true,
  // Pi appending to its own JSONL session file. The bridge builds its
  // transcript from the message and tool events instead, so consuming this too
  // would double every row. Plan 03 uses it for historic replay, not live.
  entry_appended: false,
};

export function applySessionEvent(state: SessionState, event: unknown): void {
  if (!isObject(event) || !nonBlank(event.type)) return;
  state.diagnostics?.activity(event.type);
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    state.diagnostics?.tool(
      event.toolCallId,
      event.toolName,
      event.type === "tool_execution_end" ? "completed" : "started",
    );
  }

  switch (event.type) {
    case "message_start":
      if (!turnFramesWelcome(state)) break;
      applyResponseBoundary(state, event.message);
      applyCommandOutput(state, event.message);
      applySteerDelivery(state, event.message);
      break;
    case "message_update":
      if (!turnFramesWelcome(state)) break;
      applyMessageUpdate(state, event.assistantMessageEvent);
      break;
    case "message_end":
      // The assistant message is final. A later delta belongs to a new one.
      state.openTextParts.clear();
      if (turnFramesWelcome(state)) applyResponseOutcome(state, event.message);
      break;
    case "tool_execution_start":
      if (!turnFramesWelcome(state)) break;
      applyToolExecution(state, event, "pending");
      break;
    case "tool_execution_update":
      if (!turnFramesWelcome(state)) break;
      applyToolExecution(state, event, "pending");
      break;
    case "tool_execution_end":
      if (!turnFramesWelcome(state)) break;
      applyToolExecution(state, event, "settled");
      break;
    case "turn_end":
      if (!turnFramesWelcome(state)) break;
      applyTurnUsage(state, event.message);
      break;
    case "agent_settled":
      // Pi 1.1: whether the run that just settled was aborted — by this
      // bridge, by an extension's `ctx.abort()`, or by Pi itself. The turn's
      // terminal path reads it, so an abort the bridge never asked for still
      // ends the turn as cancelled rather than completed.
      if (!turnFramesWelcome(state)) break;
      if (event.aborted === true) state.turnAborted = true;
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
      if (!turnFramesWelcome(state)) break;
      applyRetryStart(state, event);
      break;
    case "summarization_retry_scheduled":
      applySummarizationRetry(state, event);
      break;
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      // The row stays pending until `compaction_end`: `finished` fires on
      // success and on giving up alike, and says which to neither.
      break;
    case "auto_retry_end":
      // Settles the row `auto_retry_start` opened. Without this the card stayed
      // pending forever, so a retry that ultimately failed read as one that
      // worked — and one that worked read as one still in flight.
      applyRetryEnd(state, event);
      break;
    case "bash_execution_update":
      // A user-initiated `!command`, which this bridge never issues. Ignored
      // rather than rendered: it belongs to whoever ran it.
      break;
    default:
      // A type the table names as `false` is a documented gap; one it does not
      // name is an SDK addition. Both are counted, distinguishably. Names only:
      // an event payload carries prompts, file contents and tool output.
      state.health.recordUnknown(
        event.type in HANDLED_SESSION_EVENTS ? `unrendered:${event.type}` : event.type,
      );
      break;
  }
  // Synchronous by design: this function runs on Pi's SDK listener and must
  // never await a renderer, persistence or any other downstream consumer.
  boundTranscriptDuringStreaming(state);
}

/**
 * Close the current row when Pi starts a new model response.
 *
 * One row per model response, never one per turn. A turn can run for hours
 * and thousands of parts; folded into a single row it grew past every
 * transcript window, so readers could show only a front-trimmed copy and lost
 * its start for good once newer rows pushed it out of the live tail. Pi emits
 * a response's tool executions after its `message_end` and before the next
 * response's `message_start`, so tool cards stay on the row of the response
 * that requested them. The next row is opened lazily, so a response that
 * fails before producing anything leaves no empty bubble.
 */
function applyResponseBoundary(state: SessionState, value: unknown): void {
  if (!isObject(value) || value.role !== "assistant") return;
  state.currentAssistantMessageId = undefined;
  state.openTextParts.clear();
}

/**
 * Pi emits the queued steering instruction as an ordinary user message at the
 * safe-point where it joins the run. That event, not the HTTP request, owns the
 * permanent transcript row and the positive reconciliation record.
 */
function applySteerDelivery(state: SessionState, value: unknown): void {
  if (!isObject(value) || value.role !== "user") return;
  const pending = state.pendingSteerDeliveries[0];
  if (!pending) return;
  if (piRunId(state) !== pending.expectedRunId) return;
  const text = messageText(value.content);
  if (!text) return;

  state.pendingSteerDeliveries.shift();
  const entry = state.steerJournal.get(pending.requestId);
  if (entry) setSteerJournal(state, { ...entry, state: "delivered" });

  // Anything Pi emits after this user frame belongs below a fresh assistant
  // boundary. The pre-steer row may already contain prose and tool cards.
  state.currentAssistantMessageId = undefined;
  state.openTextParts.clear();
  const messageId = randomBytes(12).toString("hex");
  const message: BridgeMessage = {
    id: messageId,
    role: "user",
    content: text,
    parts: [
      {
        type: "text",
        content: text,
        sourcePartId: `${messageId}:0`,
        sourceMessageId: messageId,
      },
    ],
    createdAt: messageCreatedAt(value.timestamp),
  };
  state.messages.push(message);
  chargeTranscript(state, Buffer.byteLength(JSON.stringify(message)));
  rowChanged(state, message);
}

/**
 * Display output from an extension command running without a model turn.
 *
 * `pi.sendMessage({ display: true, ... })` appends a `custom` role message and
 * emits it as `message_start`; nothing else here renders that role. While an
 * extension command owns the turn, its display text becomes the command's
 * outcome instead of vanishing.
 */
function applyCommandOutput(state: SessionState, value: unknown): void {
  if (!state.commandRun || !isObject(value) || value.role !== "custom") return;
  if (value.display !== true) return;
  noteCommandOutput(state, messageText(value.content));
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function messageCreatedAt(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
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
    const before = existing.content;
    existing.content = appendBounded(existing, existing.content, text);
    chargeAppended(state, before, existing.content);
  } else {
    const part: BridgeTextPart = {
      type: kind,
      content: text,
      sourcePartId: `${message.id}:${nextPartOrdinal(message)}`,
      sourceMessageId: message.id,
      createdAt: new Date().toISOString(),
    };
    message.parts.push(part);
    state.openTextParts.set(kind, part.sourcePartId);
    chargeNewEntry(state, part);
  }

  // `content` is the flat text the transcript exposes as the message body, and
  // reasoning is not part of it: it is shown in its own collapsed block.
  if (kind === "text") {
    const before = message.content;
    message.content = appendBounded(message, message.content, text);
    chargeAppended(state, before, message.content);
  }
  rowChanged(state, message);
}

/**
 * The most bounded set of in-flight tool inputs worth holding.
 *
 * One turn's parallel calls, with room to spare. The map is cleared when a
 * call settles and when a turn ends, so this cap only ever bites on a runaway
 * stream of starts with no ends — where dropping the oldest input costs a card
 * title, not correctness.
 */
const MAX_TRACKED_TOOL_INPUTS = 256;

/**
 * Remember what a tool call was started with.
 *
 * The end frame does not repeat the arguments, so without this every settled
 * card re-rendered from `{}`.
 */
function rememberToolInput(state: SessionState, toolCallId: string, input: unknown): void {
  if (!isObject(input)) return;
  if (state.toolInputs.size >= MAX_TRACKED_TOOL_INPUTS) {
    const oldest = state.toolInputs.keys().next();
    if (!oldest.done) state.toolInputs.delete(oldest.value);
  }
  state.toolInputs.set(toolCallId, input);
}

function applyToolExecution(
  state: SessionState,
  event: JsonObject,
  phase: "pending" | "settled",
): void {
  const toolCallId = nonBlank(event.toolCallId) ? event.toolCallId : undefined;
  if (!toolCallId) return;
  // Pi sends the arguments on the start frame only. Falling back to the
  // remembered input is what keeps a settled `bash` card titled with the
  // command it ran instead of the word "bash", and keeps the file path on an
  // edit or write diff — the diff itself only ever arrives on the end frame,
  // so it cannot be preserved by simply not re-rendering.
  if (isObject(event.args)) rememberToolInput(state, toolCallId, event.args);
  const input = isObject(event.args) ? event.args : state.toolInputs.get(toolCallId);
  const rendered = renderToolCall({
    toolName: nonBlank(event.toolName) ? event.toolName : "tool",
    input,
    // `tool_execution_update` streams a partial result under its own key; the
    // end frame carries the final one. Both render through the same path so a
    // long `bash` call fills in as it runs.
    result: phase === "settled" ? event.result : event.partialResult,
    isError: event.isError === true,
  });

  // Pi 0.99: a call another tool made through `ctx.executeTool()` carries that
  // tool's call id. The id is the whole link, so it is stamped once and kept.
  const parentToolCallId =
    nonBlank(event.parentToolCallId) && event.parentToolCallId !== toolCallId
      ? event.parentToolCallId
      : undefined;
  const message = toolCallRow(
    state,
    event.type === "tool_execution_start",
    toolCallId,
    parentToolCallId,
  );
  // A tool card is a discrete block, so the prose around it must not keep
  // growing behind it — otherwise text produced after the call is folded into
  // the paragraph that preceded it and appears above the card that caused it.
  // A card on an earlier row interrupts nothing the current row is writing.
  if (message.id === state.currentAssistantMessageId) closeTextParts(state);
  const part = upsertToolPart(state, message, toolCallId);
  rememberToolCallRow(state, toolCallId, message.id);
  if (parentToolCallId) part.parentTaskUseId = parentToolCallId;
  part.toolName = rendered.toolName;
  part.content = rendered.toolTitle
    ? boundText(rendered.toolTitle, MAX_TOOL_TITLE_BYTES)
    : rendered.toolName;
  part.toolTitle = part.content;
  if (rendered.toolArgs) part.toolArgs = rendered.toolArgs;
  if (rendered.toolOutput !== undefined) part.toolOutput = rendered.toolOutput;
  if (rendered.toolError !== undefined) part.toolError = rendered.toolError;
  if (rendered.toolDiff) part.toolDiff = rendered.toolDiff;
  const pendingChanges = state.pendingCommandChanges?.get(toolCallId);
  if (pendingChanges) {
    part.commandChanges = pendingChanges;
    state.pendingCommandChanges?.delete(toolCallId);
  }

  if (phase === "settled") {
    part.toolState = rendered.toolError === undefined ? "success" : "failure";
    // Pi 1.1 measures `execute()` itself, for nested calls too. Never stamped
    // on a running card, and absent when Pi did not run the tool.
    const durationMs = providerDuration(event.durationMs);
    if (durationMs !== undefined) part.toolDurationMs = durationMs;
    // The call is over, so its input has no further reader.
    state.toolInputs.delete(toolCallId);
  } else if (part.toolState === undefined) {
    part.toolState = "pending";
  }

  if (rendered.todos) {
    // The list is session-wide, so hold the newest one for restart recovery as
    // well as stamping it on the card that carried it.
    state.todos = rendered.todos;
  }

  chargeToolPart(state, part);
  // Only once the call settles: a partial result can carry the same image
  // repeatedly as it streams, and a duplicated screenshot in the transcript is
  // worse than one that appears a moment late.
  if (phase === "settled") appendToolResultImages(state, message, toolCallId, rendered.images);
  rowChanged(state, message);
}

/** Measured changes held for cards not rendered yet; see `pendingCommandChanges`. */
const MAX_PENDING_COMMAND_CHANGES = 64;

/**
 * Stamp a shell call's measured line changes onto its card.
 *
 * The measurement finishes in Pi's post-tool hook, which runs before the
 * call's `tool_execution_end` — so the card is normally there, mid-flight, and
 * is patched in place; the end frame's re-render leaves the field alone. A
 * card not rendered yet picks the change up from the pending map when its
 * first frame arrives. Newest messages first: the call is almost always in the
 * turn still running.
 */
export function applyCommandChanges(
  state: SessionState,
  toolCallId: string,
  change: MeasuredWorkspaceChange,
): void {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const row = state.messages[index]!;
    for (const part of row.parts) {
      if (part.type !== "tool-invocation" || part.toolUseId !== toolCallId) continue;
      part.commandChanges = change;
      chargeToolPart(state, part);
      rowChanged(state, row);
      return;
    }
  }
  const pending = (state.pendingCommandChanges ??= new Map());
  if (pending.size >= MAX_PENDING_COMMAND_CHANGES) {
    const oldest = pending.keys().next();
    if (!oldest.done) pending.delete(oldest.value);
  }
  pending.set(toolCallId, change);
}

/**
 * Show images a tool returned, rather than the word "[image]".
 *
 * Keyed on the call id so a re-render of the same settled call cannot append a
 * second copy — Pi can re-emit an end frame, and the transcript is not a place
 * that tolerates duplicates.
 */
function appendToolResultImages(
  state: SessionState,
  message: BridgeMessage,
  toolCallId: string,
  images: RenderedToolCall["images"],
): void {
  if (!images || images.length === 0) return;
  for (const [index, image] of images.entries()) {
    const sourcePartId = toolResultImagePartId(toolCallId, index);
    if (message.parts.some((candidate) => candidate.sourcePartId === sourcePartId)) continue;
    const part: BridgeImagePart = {
      type: "image",
      content: image.content,
      sourcePartId,
      sourceMessageId: message.id,
      createdAt: new Date().toISOString(),
      fileUrl: image.fileUrl,
      // The agent looked at it; it did not produce it and the user did not
      // attach it.
      imageSource: "viewed",
    };
    message.parts.push(part);
    chargeNewEntry(state, part);
  }
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
  if (!isObject(message)) return;
  // Pi 1.1 times each model response (`AssistantMessage.durationMs`); summed,
  // it is the turn's provider time, the neutral `apiDurationMs`.
  const responseMs = providerDuration(message.durationMs);
  if (responseMs !== undefined) {
    state.currentTurnApiDurationMs = (state.currentTurnApiDurationMs ?? 0) + responseMs;
  }
  if (!isObject(message.usage)) return;
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
/**
 * A compaction boundary, as its own transcript row.
 *
 * The synthetic tool card this replaces read as something the agent chose to
 * run and dropped both token counts on the floor. A compaction is a boundary in
 * the conversation — the model no longer remembers what is above it — so it
 * gets a boundary row carrying Pi's own `tokensBefore`.
 *
 * A failed compaction keeps its old shape: it is a failure the user can act on
 * (the context did not shrink), not a boundary that happened.
 */
function applyCompaction(state: SessionState, event: JsonObject): void {
  settleCompactionRetry(state, event);
  if (event.aborted === true) {
    state.revision += 1;
    return;
  }
  const message = currentAssistantMessage(state);
  closeTextParts(state);

  if (nonBlank(event.errorMessage)) {
    const part = upsertToolPart(state, message, `compaction:${nextPartOrdinal(message)}`);
    part.toolName = "compact_context";
    part.content = "Compacting context failed";
    part.toolTitle = part.content;
    part.toolState = "failure";
    part.toolError = boundText(event.errorMessage, MAX_TOOL_TITLE_BYTES);
    chargeToolPart(state, part);
    rowChanged(state, message);
    return;
  }

  const result = isObject(event.result) ? event.result : {};
  const summary = nonBlank(result.summary) ? result.summary : "";
  const tokensBefore = typeof result.tokensBefore === "number" ? result.tokensBefore : undefined;
  const estimatedAfter =
    typeof result.estimatedTokensAfter === "number" ? result.estimatedTokensAfter : undefined;
  const sourcePartId = `compaction:${nextPartOrdinal(message)}`;
  const part: BridgeCompactionPart = {
    type: "compaction",
    content: boundText(summary, MAX_TOOL_TITLE_BYTES * 32),
    sourcePartId,
    sourceMessageId: message.id,
    createdAt: new Date().toISOString(),
    ...(tokensBefore !== undefined ? { compactedTokensBefore: tokensBefore } : {}),
    // `estimatedTokensAfter` is Pi's word, and the estimate is the honest
    // framing: the real post-compaction count is not known until the next
    // model response.
    ...(estimatedAfter !== undefined
      ? { tokenCountText: `~${estimatedAfter.toLocaleString()} tokens after` }
      : {}),
  };
  message.parts.push(part);
  chargeNewEntry(state, part);
  rowChanged(state, message);
}

/**
 * Record whether the response that just ended failed.
 *
 * Pi reports a provider error, and a run that threw (an OAuth refresh that
 * failed, say), as an assistant message with `stopReason: "error"`, and the
 * run still resolves. Without this the turn would end idle and empty. Only the
 * last response counts: Pi retries within the same run, so a later answer
 * replaces an earlier failure.
 */
function applyResponseOutcome(state: SessionState, message: unknown): void {
  if (!isObject(message) || message.role !== "assistant") return;
  state.turnError =
    message.stopReason === "error"
      ? boundText(
          nonBlank(message.errorMessage)
            ? message.errorMessage.trim()
            : "Pi ended the turn on a provider error.",
          MAX_TOOL_TITLE_BYTES,
        )
      : undefined;
}

/**
 * Pi retrying a compaction's summary request, as the retry row a turn's own
 * retries use, on the row the compaction lands on. One row per compaction: a
 * later attempt updates it rather than stacking rows that never settle.
 *
 * Pi also retries a branch summary (history navigation), with the same events
 * and no source on this one. That runs outside a compaction, and the navigate
 * route answers with its outcome, so it is not rendered.
 */
function applySummarizationRetry(state: SessionState, event: JsonObject): void {
  if (!state.compacting) return;
  const open = compactionRetryPart(state);
  if (open?.part.toolState === "pending") {
    if (nonBlank(event.errorMessage)) {
      open.part.content = boundText(event.errorMessage.trim(), MAX_TOOL_TITLE_BYTES);
    }
    if (typeof event.attempt === "number") open.part.retryAttempt = event.attempt;
    rowChanged(state, open.message);
    return;
  }
  const { message, part } = applyRetryStart(state, event);
  state.compactionRetry = { messageId: message.id, sourcePartId: part.sourcePartId };
}

function compactionRetryPart(
  state: SessionState,
): { message: BridgeMessage; part: BridgeRetryPart } | undefined {
  const target = state.compactionRetry;
  if (!target) return undefined;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index]!;
    if (message.id !== target.messageId) continue;
    const part = message.parts.find((candidate) => candidate.sourcePartId === target.sourcePartId);
    return part?.type === "retry" ? { message, part } : undefined;
  }
  return undefined;
}

/** Settle the compaction's retry row with the compaction's own outcome. */
function settleCompactionRetry(state: SessionState, event: JsonObject): void {
  const open = compactionRetryPart(state);
  state.compactionRetry = undefined;
  if (open?.part.toolState !== "pending") return;
  const failed = event.aborted === true || nonBlank(event.errorMessage);
  open.part.toolState = failed ? "failure" : "success";
  if (nonBlank(event.errorMessage)) {
    open.part.content = boundText(event.errorMessage.trim(), MAX_TOOL_TITLE_BYTES);
  }
  rowChanged(state, open.message);
}

/** Open a retry row for the request that just failed. */
function applyRetryStart(
  state: SessionState,
  event: JsonObject,
): { message: BridgeMessage; part: BridgeRetryPart } {
  const message = currentAssistantMessage(state);
  closeTextParts(state);
  const sourcePartId = `retry:${nextPartOrdinal(message)}`;
  const part: BridgeRetryPart = {
    type: "retry",
    content: boundText(
      nonBlank(event.errorMessage) ? event.errorMessage.trim() : "the request failed",
      MAX_TOOL_TITLE_BYTES,
    ),
    sourcePartId,
    sourceMessageId: message.id,
    createdAt: new Date().toISOString(),
    toolState: "pending",
    ...(typeof event.attempt === "number" ? { retryAttempt: event.attempt } : {}),
  };
  message.parts.push(part);
  chargeNewEntry(state, part);
  rowChanged(state, message);
  return { message, part };
}

/**
 * Settle the newest unsettled retry row.
 *
 * By recency rather than by attempt number: Pi's `auto_retry_end` names an
 * attempt, but a transcript trim can evict the row that attempt opened, and
 * settling nothing is better than settling the wrong row.
 */
function applyRetryEnd(state: SessionState, event: JsonObject): void {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const row = state.messages[index]!;
    const parts = row.parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part?.type !== "retry" || part.toolState !== "pending") continue;
      part.toolState = event.success === true ? "success" : "failure";
      if (event.success !== true && nonBlank(event.finalError)) {
        part.content = boundText(event.finalError.trim(), MAX_TOOL_TITLE_BYTES);
      }
      rowChanged(state, row);
      return;
    }
  }
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

/**
 * The row of the model response being written, created on first use.
 *
 * Deliberately lazy: a response that produces nothing but tool calls still
 * needs a carrier, but one that fails before producing anything should not
 * leave an empty bubble in the transcript.
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
  state.turnOpenedAssistantRow = true;
  // Blocks belong to the message that opened them.
  state.openTextParts.clear();
  chargeNewEntry(state, message);
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
  // Newest first: the open block is almost always at or near the end.
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]!;
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

/**
 * Tool calls whose row is remembered. Far beyond one response's calls; past
 * it the oldest entry goes, and a frame for that call lands on the current
 * row, as every frame did before rows were split.
 */
const MAX_TRACKED_TOOL_CALL_ROWS = 1_024;

/**
 * The row a tool call's frame belongs to.
 *
 * An update or result goes to the row already holding the call, so a late
 * frame never opens a second card. A start never does: it is a call's first
 * frame, and a provider that reuses call ids across responses must get a new
 * card on the current row, not have an old one rewritten. Otherwise a nested
 * call goes to the row holding its parent, so the child renders beside it,
 * and anything else to the current response's row.
 */
function toolCallRow(
  state: SessionState,
  starting: boolean,
  toolCallId: string,
  parentToolCallId: string | undefined,
): BridgeMessage {
  return (
    (starting ? undefined : rowHoldingToolCall(state, toolCallId)) ??
    (parentToolCallId ? rowHoldingToolCall(state, parentToolCallId) : undefined) ??
    currentAssistantMessage(state)
  );
}

function rowHoldingToolCall(state: SessionState, toolCallId: string): BridgeMessage | undefined {
  const messageId = state.toolCallRows?.get(toolCallId);
  if (!messageId) return undefined;
  // Newest first: the row is almost always the current one or close to it.
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index]!;
    if (message.id === messageId) return message;
  }
  // Trimmed from the transcript; its card is gone with it.
  state.toolCallRows?.delete(toolCallId);
  return undefined;
}

function rememberToolCallRow(state: SessionState, toolCallId: string, messageId: string): void {
  const rows = (state.toolCallRows ??= new Map());
  if (rows.get(toolCallId) === messageId) return;
  // Re-inserted, so eviction drops the call that was started longest ago.
  rows.delete(toolCallId);
  if (rows.size >= MAX_TRACKED_TOOL_CALL_ROWS) {
    const oldest = rows.keys().next();
    if (!oldest.done) rows.delete(oldest.value);
  }
  rows.set(toolCallId, messageId);
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
    sourcePartId: `${message.id}:${nextPartOrdinal(message)}`,
    sourceMessageId: message.id,
    toolUseId: toolCallId,
    createdAt: new Date().toISOString(),
  };
  message.parts.push(part);
  chargeNewEntry(state, part);
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

/**
 * Charge a new message or part at its exact encoded size plus the separator it
 * adds to its array. New entries are small skeletons or a single delta, so
 * measuring them costs what appending them did.
 */
function chargeNewEntry(state: SessionState, entry: object): void {
  chargeTranscript(state, encodedJsonBytes(entry) + 1);
}

/**
 * Charge what an append added to a string field.
 *
 * `appendBounded` only ever extends its input (or returns it unchanged once
 * saturated), so the suffix past the old length is exactly what was written.
 * Comparing prefixes instead would cost a multi-megabyte scan per token.
 */
function chargeAppended(state: SessionState, before: string, after: string): void {
  if (after === before) return;
  chargeTranscript(state, jsonStringContentBytes(after.slice(before.length)));
}

/**
 * Rebuild on resume the cards of the calls a tool made through
 * `ctx.executeTool()`, from its result's `nestedCalls` record.
 *
 * Live, each nested call arrives as its own `tool_execution_*` frames naming
 * its parent. The session file keeps only the calling tool's bounded record of
 * them, so without this a resumed codemode card lost its children. Pi ids a
 * nested call `<caller>/<n>`, which also recovers a grandchild's parent. The
 * record keeps no results: a replayed child has its title, arguments, outcome
 * and duration, never output.
 */
export function replayNestedToolCalls(
  message: BridgeMessage,
  parentToolCallId: string,
  nestedCalls: unknown,
): void {
  if (!isObject(nestedCalls) || !Array.isArray(nestedCalls.calls)) return;
  for (const call of nestedCalls.calls) {
    if (!isObject(call) || !nonBlank(call.id) || call.id === parentToolCallId) continue;
    const id = call.id;
    if (message.parts.some((part) => part.type === "tool-invocation" && part.toolUseId === id)) {
      continue;
    }
    const rendered = renderToolCall({
      toolName: nonBlank(call.name) ? call.name : "tool",
      input: call.arguments,
    });
    const slash = id.lastIndexOf("/");
    const failed = call.status !== "ok";
    const durationMs = providerDuration(call.durationMs);
    const part: BridgeToolPart = {
      type: "tool-invocation",
      content: rendered.toolTitle ?? rendered.toolName,
      sourcePartId: `${message.id}:${nextPartOrdinal(message)}`,
      sourceMessageId: message.id,
      toolUseId: id,
      parentTaskUseId:
        id.startsWith(`${parentToolCallId}/`) && slash > parentToolCallId.length
          ? id.slice(0, slash)
          : parentToolCallId,
      toolName: rendered.toolName,
      ...(rendered.toolTitle ? { toolTitle: rendered.toolTitle } : {}),
      ...(rendered.toolArgs ? { toolArgs: rendered.toolArgs } : {}),
      toolState: failed ? "failure" : "success",
      ...(durationMs !== undefined ? { toolDurationMs: durationMs } : {}),
    };
    if (failed) {
      part.toolError = boundText(
        call.status === "unfinished"
          ? "Still running when the calling tool finished."
          : nonBlank(call.error)
            ? call.error
            : `The ${rendered.toolName} tool failed`,
        MAX_TOOL_TITLE_BYTES,
      );
    }
    message.parts.push(part);
  }
}

/** A provider-measured duration, or undefined when it is not a usable one. */
export function providerDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
