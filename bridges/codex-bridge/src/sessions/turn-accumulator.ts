/**
 * Per-turn state built up from app-server notifications.
 *
 * app-server streams deltas and then a final authoritative item, so the
 * accumulator has to satisfy an awkward set of realities at once:
 *
 *   - deltas may arrive before the `item/started` that introduces the item;
 *   - `item/completed` may arrive with no `item/started` at all;
 *   - the same notification may be delivered twice;
 *   - events from an *older* engine generation or an *older* turn may arrive
 *     after a newer one began, and must never overwrite it;
 *   - `item/completed` is authoritative and replaces whatever the deltas built.
 *
 * Anything less tolerant produces torn transcripts on reconnect.
 */
import type {
  EngineError,
  EngineEvent,
  EngineGeneration,
  EngineItem,
  EngineTurnStatus,
} from "../engine/types.js";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import {
  resolveTranscriptToolOutputState,
  stringifyTranscriptToolOutput,
} from "../subagent-transcript.js";

export type TurnPhase =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "interrupted"
  | "failed";

/**
 * A progress line is one row in a collapsed transcript, so it is capped well
 * below a message. An MCP server that streams a whole log through `message`
 * would otherwise put it in the transcript one report at a time.
 */
const MAX_ITEM_PROGRESS_CHARS = 200;

export interface ItemAccumulator {
  id: string;
  /** Position in `itemOrder`, which is what places the item in a row. */
  orderIndex: number;
  /** Last authoritative item, when one has arrived. */
  item: EngineItem | null;
  /** Streamed agent-message text, used until the final item lands. */
  textDelta: string;
  /** Reasoning summary text by summary index. */
  summaryDeltas: Map<number, string>;
  /** Reasoning content text by content index. */
  contentDeltas: Map<number, string>;
  /** Command stdout/stderr, capped for the UI. */
  outputDelta: string;
  outputTruncated: boolean;
  /**
   * The newest progress report for this item, while it is still running.
   *
   * Only the newest: progress is a hint over the item's own state, so a
   * backlog of superseded lines is noise. Cleared when the item completes,
   * because a settled row reporting live progress is worse than no line at all.
   */
  progress?: string;
  completed: boolean;
  /**
   * An agent message app-server abandoned: it streamed, then a later agent
   * message started or the turn ended without its `item/completed`. Settled
   * as far as the bridge is concerned, but a late `item/completed` still wins.
   */
  interrupted?: boolean;
  /**
   * What a command changed in its worktree. Measured after the item completes,
   * so it arrives separately from — and usually after — the item itself.
   */
  commandChanges?: MeasuredWorkspaceChange;
  /** Raw apply_patch recovery candidate, hidden while a structured item may arrive. */
  rawFallback: boolean;
  /**
   * Bumped on every mutation, so a consumer can tell "nothing happened here"
   * from "this settled a moment ago" without diffing rendered output.
   */
  version: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TurnAccumulatorOptions {
  threadId: string;
  turnId: string;
  requestId?: string;
  /** True when the final agent message must be parsed as provider-constrained JSON. */
  expectsStructuredOutput?: boolean;
  engineGeneration: EngineGeneration;
  assistantMessageId: string;
  startedAt?: string;
  /** UI cap for a single command's aggregated output. */
  maxCommandOutputChars?: number;
  /** Session configuration revision captured when the turn was dispatched. */
  configurationRevision?: number;
}

export interface AssistantSegment {
  assistantMessageId: string;
  startIndex: number;
  endIndex?: number;
  startedAt: string;
  endedAt?: string;
  /** Bumped whenever an item in this row mutates; see `assistantSegmentVersion`. */
  version: number;
}

/**
 * Items that are the model calling a tool the client runs. A response that
 * called one ends there and waits for the result, so a reasoning or agent
 * message item arriving after one belongs to the next response. Hosted tools
 * (web search, image generation) run inside the response and are not listed.
 */
const MODEL_STEP_TOOL_ITEM_TYPES = new Set<EngineItem["type"]>([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_tool_call",
  "todo_list",
]);

function isClientToolCall(item: EngineItem): boolean {
  if (item.type === "image") return item.source === "viewed";
  return MODEL_STEP_TOOL_ITEM_TYPES.has(item.type);
}

/** A code-mode `exec` cell the bridge read back from the rollout (`RefusedCellTail`). */
function isCodeModeCell(item: EngineItem): boolean {
  return item.type === "dynamic_tool_call" && item.tool === "exec";
}

/** A single runaway command must not be able to exhaust bridge memory. */
export const DEFAULT_MAX_COMMAND_OUTPUT_CHARS = 256 * 1024;

/**
 * Marks a turn we know was dispatched but whose real id app-server has not told
 * us yet. Such a placeholder owns the thread's overlap guard, but it must never
 * be mistaken for a *newer* registered turn — events for the real turn are still
 * arriving and have to be parked, not discarded.
 */
export const UNCONFIRMED_TURN_ID_PREFIX = "unconfirmed:";

export function unconfirmedTurnId(requestId: string): string {
  return `${UNCONFIRMED_TURN_ID_PREFIX}${requestId}`;
}

export class TurnAccumulator {
  readonly threadId: string;
  readonly requestId?: string;
  readonly expectsStructuredOutput: boolean;
  /** Assistant transcript row receiving newly introduced items in this turn. */
  assistantMessageId: string;
  readonly startedAt: string;
  readonly configurationRevision: number;

  /**
   * Mutable so a turn confirmed to still be running can be re-bound to the
   * replacement child after a restart. Without this, every event from the new
   * generation would be rejected as stale and the turn would hang.
   */
  engineGeneration: EngineGeneration;

  /** Mutable: `turn/start` may answer with the real id after events arrived. */
  turnId: string;
  phase: TurnPhase = "starting";
  /**
   * The user asked for this turn to stop. Kept apart from `phase` because the
   * cancel path can settle the turn terminal before a crash recovery pass looks
   * at it, and recovery must still know an interruption was requested.
   */
  cancelRequested = false;
  /**
   * The bridge interrupted this turn because the backend that owned it died
   * (`CodexRuntimeTail.interruptForParentExit`). Nobody asked for the stop, so
   * it settles like a restart mid-turn, never like a cancel: a workflow must
   * still see a turn it can continue.
   */
  stoppedByShutdown = false;
  error?: EngineError;
  finalDiff?: string;
  completedAt?: string;

  /** Insertion order of item keys, which is the render order. */
  readonly itemOrder: string[] = [];
  readonly items = new Map<string, ItemAccumulator>();

  /**
   * One assistant transcript row per model response (see `opensModelStep`),
   * and a steer — a user message inside an already-running turn — also starts
   * one. Items which existed before a boundary stay in the preceding row;
   * items introduced afterwards render into a new row below it.
   */
  private readonly assistantSegments: AssistantSegment[];
  private readonly assistantSegmentsById = new Map<string, AssistantSegment>();

  private readonly maxCommandOutputChars: number;

  /**
   * Agent messages that have started streaming but not completed. app-server
   * samples one response at a time per turn, so at most one is ever really
   * live; anything older here was cut off (see `interruptOpenAgentMessages`).
   */
  private readonly openAgentMessageIds = new Set<string>();

  /**
   * Frozen rows an item mutation moved since `takeChangedFrozenRows` last ran.
   * The live row always renders; a frozen one may no longer be tracked for
   * rendering at all, and this is how its late change still finds it.
   */
  private readonly changedFrozenRows = new Set<string>();

  /**
   * Where the latest steer sits in `itemOrder`: every item before it is
   * displayed above that steer, so a later steer can never land there.
   */
  private steerFloor = 0;
  private modelToolCalled = false;
  /**
   * Model responses app-server reported finished that no row boundary has
   * consumed yet (`noteModelResponseCompleted`). A count, not a flag: a usage
   * report can overtake the item of its own response, and a flag would then
   * swallow the next response's boundary.
   */
  private pendingResponseBoundaries = 0;

  /** Tool calls such as write_stdin/request_user_input need no rendered item. */
  noteModelToolCall(): void {
    this.modelToolCalled = true;
  }

  /**
   * app-server finished one model response of this turn. It reports token
   * usage once per Responses API completion, a response that only called a
   * tool included, and names no response on the items themselves.
   */
  noteModelResponseCompleted(): void {
    if (this.isTerminal()) return;
    this.pendingResponseBoundaries += 1;
  }

  /**
   * Whether a client tool item of this turn started in `[fromMs, toMs]`, by
   * app-server's clock. A code-mode cell recovered from the rollout is not
   * one: it is the call those items would have come from.
   */
  clientToolItemStartedBetween(fromMs: number, toMs: number): boolean {
    for (const accumulator of this.items.values()) {
      const item = accumulator.item;
      if (!item || !isClientToolCall(item) || isCodeModeCell(item)) continue;
      const at = accumulator.startedAt ?? accumulator.completedAt;
      if (at !== undefined && at >= fromMs && at <= toMs) return true;
    }
    return false;
  }

  /**
   * Bumped whenever a sub-agent lifecycle item (a spawn, wait or message to
   * an agent, or an activity beat) changes anywhere in the turn. A frozen row
   * whose agents have all finished only needs another transcript probe once
   * this moves, since only such an item can reopen one of them.
   */
  subagentEvidenceVersion = 0;

  constructor(options: TurnAccumulatorOptions) {
    this.threadId = options.threadId;
    this.turnId = options.turnId;
    this.requestId = options.requestId;
    this.expectsStructuredOutput = options.expectsStructuredOutput ?? false;
    this.engineGeneration = options.engineGeneration;
    this.assistantMessageId = options.assistantMessageId;
    this.startedAt = options.startedAt ?? new Date().toISOString();
    this.configurationRevision = options.configurationRevision ?? 0;
    const first: AssistantSegment = {
      assistantMessageId: options.assistantMessageId,
      startIndex: 0,
      startedAt: this.startedAt,
      version: 0,
    };
    this.assistantSegments = [first];
    this.assistantSegmentsById.set(first.assistantMessageId, first);
    this.maxCommandOutputChars = options.maxCommandOutputChars ?? DEFAULT_MAX_COMMAND_OUTPUT_CHARS;
  }

  isTerminal(): boolean {
    return this.phase === "completed" || this.phase === "interrupted" || this.phase === "failed";
  }

  /** True while this turn holds the overlap guard without a confirmed turn id. */
  isUnconfirmed(): boolean {
    return this.turnId.startsWith(UNCONFIRMED_TURN_ID_PREFIX);
  }

  /**
   * True when an event belongs to this turn.
   *
   * A turn id mismatch means a stale event from a previous turn; a generation
   * mismatch means it came from a process that has since been replaced. Either
   * must be dropped rather than applied.
   */
  accepts(event: { turnId?: string; engineGeneration?: EngineGeneration }): boolean {
    if (event.engineGeneration !== undefined && event.engineGeneration !== this.engineGeneration) {
      return false;
    }
    if (event.turnId !== undefined && event.turnId !== this.turnId) return false;
    return true;
  }

  /**
   * Resolves an item's accumulator, creating it on first sight, so a delta can
   * precede `item/started`.
   *
   * Every mutator funnels through here exactly once, which is what makes the
   * `version` bump below a complete record of change for that item.
   */
  private ensureItem(itemId: string): ItemAccumulator {
    let accumulator = this.items.get(itemId);
    if (!accumulator) {
      accumulator = {
        id: itemId,
        orderIndex: this.itemOrder.length,
        item: null,
        textDelta: "",
        summaryDeltas: new Map(),
        contentDeltas: new Map(),
        outputDelta: "",
        outputTruncated: false,
        completed: false,
        rawFallback: false,
        version: 0,
      };
      this.items.set(itemId, accumulator);
      this.itemOrder.push(itemId);
    }
    this.touch(accumulator);
    return accumulator;
  }

  /** Records a mutation on the item and on the row holding it. */
  private touch(accumulator: ItemAccumulator): void {
    accumulator.version += 1;
    const segment = this.segmentAtIndex(accumulator.orderIndex);
    if (!segment) return;
    segment.version += 1;
    if (segment.endIndex !== undefined) this.changedFrozenRows.add(segment.assistantMessageId);
  }

  /** Records that a sub-agent lifecycle item changed; see `subagentEvidenceVersion`. */
  private noteSubagentEvidence(item: EngineItem | null): void {
    if (item?.type === "collab_tool_call" || item?.type === "subagent_activity") {
      this.subagentEvidenceVersion += 1;
    }
  }

  /** The frozen rows whose items moved since the last call, which it forgets. */
  takeChangedFrozenRows(): string[] {
    if (this.changedFrozenRows.size === 0) return [];
    const changed = [...this.changedFrozenRows];
    this.changedFrozenRows.clear();
    return changed;
  }

  /**
   * The row an item position falls in. Rows are contiguous and ordered by
   * `startIndex`; an empty row shares its start with the next one, so the last
   * row starting at or before the position is the one that can hold it. A
   * position past a frozen row's end belongs to the row a steer has not opened
   * yet, which renders in full when it does.
   */
  private segmentAtIndex(index: number): AssistantSegment | undefined {
    let low = 0;
    let high = this.assistantSegments.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.assistantSegments[middle]!.startIndex <= index) low = middle;
      else high = middle - 1;
    }
    const segment = this.assistantSegments[low]!;
    if (segment.startIndex > index) return undefined;
    if (segment.endIndex !== undefined && index >= segment.endIndex) return undefined;
    return segment;
  }

  markRunning(turnId?: string): void {
    if (turnId) this.turnId = turnId;
    if (this.phase === "starting") this.phase = "running";
  }

  markCancelling(): void {
    // Only a live turn can enter cancelling; a terminal turn stays terminal.
    if (this.isTerminal()) return;
    this.phase = "cancelling";
    this.cancelRequested = true;
  }

  onItemStarted(item: EngineItem, startedAtMs?: number): void {
    if (item.type === "agent_message") this.interruptOpenAgentMessages(item.id);
    const accumulator = this.ensureItem(item.id);
    // A repeated `item/started` must not reset text already streamed, and must
    // not clobber a final item that somehow arrived first.
    const replacesRawFallback = accumulator.rawFallback && item.type === "file_change";
    if (!accumulator.completed || replacesRawFallback) {
      accumulator.item =
        accumulator.interrupted && item.type === "agent_message"
          ? { ...item, interrupted: true }
          : item;
    }
    if (item.type === "agent_message" && !accumulator.completed && !accumulator.interrupted) {
      this.openAgentMessageIds.add(item.id);
    }
    if (replacesRawFallback) accumulator.completed = false;
    if (item.type === "file_change") accumulator.rawFallback = false;
    accumulator.startedAt ??= startedAtMs;
    this.noteSubagentEvidence(accumulator.item);
  }

  onItemUpdated(update: EngineItem): void {
    const item = this.rowScopedPlan(update);
    const accumulator = this.ensureItem(item.id);
    const replacesRawFallback = accumulator.rawFallback && item.type === "file_change";
    if (!accumulator.completed || replacesRawFallback) accumulator.item = item;
    if (replacesRawFallback) accumulator.completed = false;
    if (item.type === "file_change") accumulator.rawFallback = false;
    this.noteSubagentEvidence(accumulator.item);
  }

  /**
   * The turn's plan arrives as one item updated in place (`plan-<turnId>`), but
   * each update is an `update_plan` call the model made in its current
   * response. Once the row holding the plan is behind the live one, a further
   * update is a new call in the live row, exactly as a reload shows it. Left in
   * place, every update for the rest of the turn would re-render a row that
   * stops being tracked once enough newer rows follow it.
   */
  private rowScopedPlan(item: EngineItem): EngineItem {
    if (item.type !== "todo_list") return item;
    const existing = this.items.get(item.id);
    const segment = this.assistantSegment();
    if (!existing || existing.orderIndex >= segment.startIndex) return item;
    return { ...item, id: `${item.id}:${this.assistantSegments.length - 1}` };
  }

  /** `item/completed` is authoritative: it replaces everything the deltas built. */
  onItemCompleted(item: EngineItem, completedAtMs?: number): void {
    const accumulator = this.ensureItem(item.id);
    accumulator.item = item;
    accumulator.completed = true;
    // Authoritative even for a message the bridge had given up on.
    if (accumulator.interrupted) accumulator.interrupted = false;
    this.openAgentMessageIds.delete(item.id);
    accumulator.rawFallback = false;
    // The item settled, so any progress line describes work that has stopped.
    accumulator.progress = undefined;
    accumulator.completedAt ??= completedAtMs;
    this.noteSubagentEvidence(item);
  }

  /**
   * Retains a raw patch call without presenting it as an authoritative item.
   *
   * The raw `custom_tool_call` and the structured `fileChange` share a call id,
   * and the raw one can arrive *after* app-server has already streamed the
   * structured patch preview. It must never demote what is already there:
   * overwriting an in-progress `fileChange` with the raw call would also hide it
   * (see `effectiveItem`), so the live diff the agent is building would vanish
   * until the patch is applied — which, behind an approval prompt, is however
   * long the user takes to answer.
   *
   * Leaving `rawFallback` alone in that case is also what keeps `completed`
   * honest: `rawFallback` is true only while the held item *is* the raw
   * candidate, so the `replacesRawFallback` branches below can never clear a
   * completion that came from an authoritative `item/completed`.
   */
  onDynamicToolStarted(item: EngineItem, startedAtMs?: number): void {
    const accumulator = this.ensureItem(item.id);
    accumulator.startedAt ??= startedAtMs;
    if (accumulator.completed) return;
    if (accumulator.item && !accumulator.rawFallback) return;
    accumulator.item = item;
    accumulator.rawFallback = true;
  }

  onTextDelta(itemId: string, delta: string): void {
    const accumulator = this.ensureItem(itemId);
    // Deltas after the authoritative item are redundant; ignoring them prevents
    // duplicated tails when a late delta trails `item/completed`.
    if (accumulator.completed) return;
    // A cut-off response does not resume: its text is settled as streamed.
    if (accumulator.interrupted) return;
    // A delta can precede its `item/started`, and only agent messages stream
    // text deltas, so this is also where a message opens.
    if (!this.openAgentMessageIds.has(itemId)) {
      this.interruptOpenAgentMessages(itemId);
      this.openAgentMessageIds.add(itemId);
    }
    accumulator.textDelta += delta;
  }

  onReasoningDelta(
    itemId: string,
    delta: string,
    channel: "summary" | "content",
    index: number,
  ): void {
    const accumulator = this.ensureItem(itemId);
    if (accumulator.completed) return;
    const target = channel === "summary" ? accumulator.summaryDeltas : accumulator.contentDeltas;
    target.set(index, (target.get(index) ?? "") + delta);
  }

  /**
   * Record a live progress report for one item.
   *
   * Ignored once the item has completed: a late report describes work that has
   * already stopped, and the row would claim to be busy forever.
   */
  onItemProgress(itemId: string, message: string): void {
    const accumulator = this.ensureItem(itemId);
    if (accumulator.completed) return;
    accumulator.progress = message.slice(0, MAX_ITEM_PROGRESS_CHARS);
    this.touch(accumulator);
  }

  onCommandOutputDelta(itemId: string, delta: string): void {
    const accumulator = this.ensureItem(itemId);
    if (accumulator.completed) return;
    const remaining = this.maxCommandOutputChars - accumulator.outputDelta.length;
    if (remaining <= 0) {
      accumulator.outputTruncated = true;
      return;
    }
    if (delta.length > remaining) {
      accumulator.outputDelta += delta.slice(0, remaining);
      accumulator.outputTruncated = true;
      return;
    }
    accumulator.outputDelta += delta;
  }

  /**
   * Completes a raw custom-tool fallback only when its matching call introduced
   * a dynamic item. Structured app-server items use the same call id and remain
   * authoritative: a later `fileChange` completion replaces this fallback.
   *
   * Returns true only when the fallback must be published immediately. Failed
   * patches have no structured `fileChange`, so they flush at once. Successful
   * results wait for the structured completion (or the final turn render), which
   * avoids flashing a less-authoritative raw card first.
   */
  onDynamicToolOutput(itemId: string, output: unknown, completedAtMs?: number): boolean {
    const accumulator = this.items.get(itemId);
    const item = accumulator?.item;
    if (
      !accumulator ||
      accumulator.completed ||
      item?.type !== "dynamic_tool_call" ||
      item.tool.trim().toLowerCase() !== "apply_patch"
    ) {
      return false;
    }

    const serialized = stringifyTranscriptToolOutput(output);
    const state = resolveTranscriptToolOutputState(item.tool, output, "success");
    accumulator.item = {
      ...item,
      content_items: serialized ? [{ type: "inputText", text: serialized }] : [],
      status: state === "failure" ? "failed" : "completed",
    };
    accumulator.completed = true;
    accumulator.progress = undefined;
    accumulator.completedAt ??= completedAtMs;
    // Not through `ensureItem`, so the row holding the call has to be told.
    this.touch(accumulator);
    return state === "failure";
  }

  /**
   * Attach a command's measured worktree change. Returns false for an item this
   * turn never saw, so the caller can patch the settled transcript instead.
   *
   * Not through `ensureItem`: a measurement must not conjure a row, but it
   * does bump `version` so a frozen segment knows it has to re-render.
   */
  onCommandChanges(itemId: string, change: MeasuredWorkspaceChange): boolean {
    const accumulator = this.items.get(itemId);
    if (!accumulator) return false;
    accumulator.commandChanges = change;
    this.touch(accumulator);
    return true;
  }

  onTurnDiff(diff: string): void {
    this.finalDiff = diff;
  }

  onError(error: EngineError): void {
    // Recorded, but not terminal on its own: app-server can report a retryable
    // error and still complete the turn.
    this.error = error;
  }

  complete(status: EngineTurnStatus, error?: EngineError): void {
    this.phase = status;
    if (error) this.error = error;
    this.completedAt = new Date().toISOString();
    // Nothing more streams once the turn ends, whatever its status.
    this.interruptOpenAgentMessages();
    // An item that never settled renders differently once the turn is over (a
    // held-back raw patch is shown, for one), and its row may be long past
    // the ones still tracked for rendering. Marking it moved reaches it there.
    for (const accumulator of this.items.values()) {
      if (!accumulator.completed && !accumulator.interrupted) this.touch(accumulator);
    }
  }

  /**
   * Settles every open agent message except `keepId` as interrupted.
   *
   * Since codex 0.162 `instant_interrupt` is on by default: `turn/steer` cuts
   * the in-flight response off, and its agent message gets `item/started` and
   * deltas but never `item/completed` — `thread/read` omits it entirely. The
   * replacement response starts as a new agent message, which is the signal
   * the old one is dead; turn completion is the backstop. Left open, the
   * fragment kept its provider phase (often `final_answer`) and stayed a
   * candidate for the turn's structured output.
   */
  private interruptOpenAgentMessages(keepId?: string): void {
    for (const id of Array.from(this.openAgentMessageIds)) {
      if (id === keepId) continue;
      this.openAgentMessageIds.delete(id);
      const accumulator = this.items.get(id);
      if (!accumulator || accumulator.completed) continue;
      accumulator.interrupted = true;
      this.touch(accumulator);
      const item = accumulator.item;
      accumulator.item =
        item?.type === "agent_message"
          ? { ...item, interrupted: true }
          : item === null
            ? { id, type: "agent_message", text: "", interrupted: true }
            : item;
    }
  }

  /** Ordered accumulators for rendering. */
  ordered(): ItemAccumulator[] {
    return this.itemOrder
      .map((id) => this.items.get(id))
      .filter((entry): entry is ItemAccumulator => entry !== undefined);
  }

  assistantSegmentsInOrder(): readonly AssistantSegment[] {
    return this.assistantSegments;
  }

  assistantSegment(assistantMessageId: string = this.assistantMessageId): AssistantSegment {
    return (
      this.assistantSegmentsById.get(assistantMessageId) ??
      this.assistantSegments[this.assistantSegments.length - 1]!
    );
  }

  /** The row with this id, without falling back to the live one. */
  findAssistantSegment(assistantMessageId: string): AssistantSegment | undefined {
    return this.assistantSegmentsById.get(assistantMessageId);
  }

  /** The row holding an item, when the item exists and a row has opened for it. */
  assistantMessageIdForItem(itemId: string): string | undefined {
    const accumulator = this.items.get(itemId);
    return accumulator
      ? this.segmentAtIndex(accumulator.orderIndex)?.assistantMessageId
      : undefined;
  }

  /**
   * Cheap "has anything in this row moved?" token.
   *
   * Every item mutation bumps the row holding the item. Equal tokens mean no
   * item in the row was created, streamed into, updated or completed since it
   * was last sampled, which is what lets a frozen row skip a re-render it
   * cannot change the result of — in constant time, however long the turn.
   */
  assistantSegmentVersion(assistantMessageId: string = this.assistantMessageId): number {
    return this.assistantSegment(assistantMessageId).version;
  }

  /** Items belonging to one assistant transcript row. */
  orderedForAssistantSegment(
    assistantMessageId: string = this.assistantMessageId,
  ): ItemAccumulator[] {
    const segment = this.assistantSegment(assistantMessageId);
    const end = segment.endIndex ?? this.itemOrder.length;
    return this.itemOrder
      .slice(segment.startIndex, end)
      .map((id) => this.items.get(id))
      .filter((entry): entry is ItemAccumulator => entry !== undefined);
  }

  /**
   * Maps an authoritative `thread/read` ordering onto the live accumulator.
   *
   * The boundary is driven by `followingItemIds` — the items app-server placed
   * *after* the steering user message — and never by the absence of an id from
   * `precedingItemIds`. Absence is not evidence: `thread/read` projects what
   * app-server has persisted, so an item that is still streaming, or one elided
   * by a partial `itemsView`, is missing from the prefix while genuinely
   * belonging above the steer. Demoting on absence emptied the pre-steer row and
   * pushed the whole in-flight response below the user's own message.
   *
   * Presence on the far side is evidence, and survives any truncation: if
   * app-server ordered an item after the steer, it did come after. Everything
   * the projection does not mention keeps the position it already has.
   *
   * The boundary can fall before the live row: the next response may have
   * opened its row while the steer was in flight (see `placeSteer`).
   */
  boundaryAfterItems(
    ordering:
      | {
          precedingItemIds?: readonly string[];
          followingItemIds?: readonly string[];
        }
      | undefined,
  ): number {
    const liveBoundary = this.itemOrder.length;
    if (!ordering?.followingItemIds?.length) return liveBoundary;
    const following = new Set(ordering.followingItemIds);
    // A later steer can never reach back above an earlier one.
    for (let index = this.steerFloor; index < liveBoundary; index += 1) {
      if (following.has(this.itemOrder[index]!)) return index;
    }
    return liveBoundary;
  }

  /**
   * Where a steer goes among the turn's rows, recording it as the floor for
   * the next one.
   *
   * Usually it splits the live row (`split`): the caller freezes the row at
   * `boundary` and opens the next one there. But a steer cuts the in-flight
   * response off, and the next response's first item can arrive — and open
   * that response's row — while `turn/steer` and its ordering read are still
   * in flight, or before an ambiguous steer is retried. Every item of such a
   * row follows the steer, so splitting the live row would freeze it empty and
   * leave the rows that follow the steer above it. The user row goes `before`
   * the first of them instead, and no row is opened or frozen.
   *
   * A boundary inside an earlier, frozen row cannot split it any more; the
   * steer goes below that row.
   */
  placeSteer(ordering: {
    precedingItemIds?: readonly string[];
    followingItemIds?: readonly string[];
  }): { kind: "split"; boundary: number } | { kind: "before"; assistantMessageId: string } {
    const boundary = this.boundaryAfterItems(ordering);
    const live = this.assistantSegment();
    if (boundary > live.startIndex) {
      this.steerFloor = boundary;
      return { kind: "split", boundary };
    }
    let first = this.assistantSegments.length - 1;
    while (first > 0 && this.assistantSegments[first - 1]!.startIndex >= boundary) first -= 1;
    const row = this.assistantSegments[first]!;
    this.steerFloor = row.startIndex;
    return { kind: "before", assistantMessageId: row.assistantMessageId };
  }

  /**
   * Freezes the current row at the exact item boundary where a steer landed.
   * Events may continue arriving while that row is rendered, so the boundary
   * must be captured before awaiting any rendering work.
   */
  freezeAssistantSegment(boundary: number = this.itemOrder.length, endedAt?: string): number {
    const segment = this.assistantSegment();
    segment.endIndex = boundary;
    if (endedAt) segment.endedAt = endedAt;
    return boundary;
  }

  /** Starts the next assistant row at a previously captured boundary. */
  startAssistantSegment(
    assistantMessageId: string,
    boundary: number,
    startedAt: string = new Date().toISOString(),
  ): void {
    this.assistantMessageId = assistantMessageId;
    this.modelToolCalled = false;
    // The row just opened is the next response's; at most one finished
    // response is behind it. A report that overtook its own item stays.
    this.pendingResponseBoundaries = Math.max(0, this.pendingResponseBoundaries - 1);
    const segment: AssistantSegment = {
      assistantMessageId,
      startIndex: boundary,
      startedAt,
      version: 0,
    };
    this.assistantSegments.push(segment);
    this.assistantSegmentsById.set(assistantMessageId, segment);
  }

  /**
   * True when `event` introduces the first item of a new model response, which
   * must open a row of its own (`startModelStep`) before it is applied.
   *
   * app-server labels no item with the response that produced it, so the
   * boundary is inferred: a response that called a tool waits for the result
   * and then the model samples again, and every response opens with reasoning
   * or a message. A new reasoning or agent message item after a tool call in
   * the live row is therefore the next response. Parallel calls in one
   * response stay together, and a turn that never calls a tool stays one row.
   *
   * A response that only calls a tool opens with neither, so app-server's
   * per-response usage report (`noteModelResponseCompleted`) is the second
   * boundary: a new tool call after a finished response, in a live row that
   * already holds a call, is the next response. Without it, a model reading
   * files one call at a time grew a single row for the whole run. A code-mode
   * cell's own calls stream as items after its response finished, so a cell
   * making several calls can split once inside itself; each report still
   * opens at most one row, so rows stay bounded by responses.
   *
   * Never while a steer is splitting the live row: items arriving then belong
   * to the row the steer is about to open.
   */
  opensModelStep(event: EngineEvent): boolean {
    let itemId: string;
    let type: EngineItem["type"];
    let toolCall = false;
    switch (event.kind) {
      case "item.started":
      case "item.completed":
        itemId = event.item.id;
        type = event.item.type;
        toolCall = isClientToolCall(event.item) && !isCodeModeCell(event.item);
        break;
      case "item.text.delta":
        itemId = event.itemId;
        type = "agent_message";
        break;
      case "item.reasoning.delta":
        itemId = event.itemId;
        type = "reasoning";
        break;
      default:
        return false;
    }
    const opensResponse = type === "reasoning" || type === "agent_message";
    if (!opensResponse && !(toolCall && this.pendingResponseBoundaries > 0)) return false;
    if (this.items.has(itemId) || this.isTerminal()) return false;
    const segment = this.assistantSegment();
    if (segment.endIndex !== undefined) return false;
    if (this.modelToolCalled) return true;
    for (let index = segment.startIndex; index < this.itemOrder.length; index += 1) {
      const item = this.items.get(this.itemOrder[index]!)?.item;
      if (item && isClientToolCall(item)) return true;
    }
    return false;
  }

  /** Closes the live row and opens the next model response's row after it. */
  startModelStep(assistantMessageId: string, startedAt: string): void {
    const boundary = this.freezeAssistantSegment(this.itemOrder.length, startedAt);
    this.startAssistantSegment(assistantMessageId, boundary, startedAt);
  }

  /**
   * Effective text for an item: the authoritative value when present, otherwise
   * the streamed deltas.
   */
  effectiveText(accumulator: ItemAccumulator): string {
    const item = accumulator.item as { type?: string; text?: string } | null;
    if (item?.type === "agent_message" && typeof item.text === "string" && item.text.length > 0) {
      return item.text;
    }
    if (item?.type === "plan" && typeof item.text === "string" && item.text.length > 0) {
      return item.text;
    }
    return accumulator.textDelta;
  }

  /** Reasoning summary/content assembled from deltas in index order. */
  effectiveReasoning(accumulator: ItemAccumulator): { summary: string[]; content: string[] } {
    const item = accumulator.item as {
      type?: string;
      summary?: string[];
      content?: string[];
    } | null;
    if (item?.type === "reasoning" && (item.summary?.length || item.content?.length)) {
      return { summary: item.summary ?? [], content: item.content ?? [] };
    }
    return {
      summary: indexedToArray(accumulator.summaryDeltas),
      content: indexedToArray(accumulator.contentDeltas),
    };
  }
}

function indexedToArray(source: Map<number, string>): string[] {
  if (source.size === 0) return [];
  const highest = Math.max(...source.keys());
  const result: string[] = [];
  for (let index = 0; index <= highest; index += 1) {
    result.push(source.get(index) ?? "");
  }
  return result;
}
