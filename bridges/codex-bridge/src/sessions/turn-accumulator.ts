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
  EngineGeneration,
  EngineItem,
  EngineTurnStatus,
} from "../engine/types.js";
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

export interface ItemAccumulator {
  id: string;
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
  completed: boolean;
  /** Raw apply_patch recovery candidate, hidden while a structured item may arrive. */
  rawFallback: boolean;
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
  readonly assistantMessageId: string;
  readonly startedAt: string;

  /**
   * Mutable so a turn confirmed to still be running can be re-bound to the
   * replacement child after a restart. Without this, every event from the new
   * generation would be rejected as stale and the turn would hang.
   */
  engineGeneration: EngineGeneration;

  /** Mutable: `turn/start` may answer with the real id after events arrived. */
  turnId: string;
  phase: TurnPhase = "starting";
  error?: EngineError;
  finalDiff?: string;
  completedAt?: string;

  /** Insertion order of item keys, which is the render order. */
  readonly itemOrder: string[] = [];
  readonly items = new Map<string, ItemAccumulator>();

  private readonly maxCommandOutputChars: number;

  constructor(options: TurnAccumulatorOptions) {
    this.threadId = options.threadId;
    this.turnId = options.turnId;
    this.requestId = options.requestId;
    this.expectsStructuredOutput = options.expectsStructuredOutput ?? false;
    this.engineGeneration = options.engineGeneration;
    this.assistantMessageId = options.assistantMessageId;
    this.startedAt = options.startedAt ?? new Date().toISOString();
    this.maxCommandOutputChars =
      options.maxCommandOutputChars ?? DEFAULT_MAX_COMMAND_OUTPUT_CHARS;
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

  /** Creates the accumulator on demand, so a delta can precede `item/started`. */
  private ensureItem(itemId: string): ItemAccumulator {
    let accumulator = this.items.get(itemId);
    if (!accumulator) {
      accumulator = {
        id: itemId,
        item: null,
        textDelta: "",
        summaryDeltas: new Map(),
        contentDeltas: new Map(),
        outputDelta: "",
        outputTruncated: false,
        completed: false,
        rawFallback: false,
      };
      this.items.set(itemId, accumulator);
      this.itemOrder.push(itemId);
    }
    return accumulator;
  }

  markRunning(turnId?: string): void {
    if (turnId) this.turnId = turnId;
    if (this.phase === "starting") this.phase = "running";
  }

  markCancelling(): void {
    // Only a live turn can enter cancelling; a terminal turn stays terminal.
    if (!this.isTerminal()) this.phase = "cancelling";
  }

  onItemStarted(item: EngineItem, startedAtMs?: number): void {
    const accumulator = this.ensureItem(item.id);
    // A repeated `item/started` must not reset text already streamed, and must
    // not clobber a final item that somehow arrived first.
    const replacesRawFallback =
      accumulator.rawFallback && item.type === "file_change";
    if (!accumulator.completed || replacesRawFallback) accumulator.item = item;
    if (replacesRawFallback) accumulator.completed = false;
    if (item.type === "file_change") accumulator.rawFallback = false;
    accumulator.startedAt ??= startedAtMs;
  }

  onItemUpdated(item: EngineItem): void {
    const accumulator = this.ensureItem(item.id);
    const replacesRawFallback =
      accumulator.rawFallback && item.type === "file_change";
    if (!accumulator.completed || replacesRawFallback) accumulator.item = item;
    if (replacesRawFallback) accumulator.completed = false;
    if (item.type === "file_change") accumulator.rawFallback = false;
  }

  /** `item/completed` is authoritative: it replaces everything the deltas built. */
  onItemCompleted(item: EngineItem, completedAtMs?: number): void {
    const accumulator = this.ensureItem(item.id);
    accumulator.item = item;
    accumulator.completed = true;
    accumulator.rawFallback = false;
    accumulator.completedAt ??= completedAtMs;
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
    const state = resolveTranscriptToolOutputState(
      item.tool,
      output,
      "success",
    );
    accumulator.item = {
      ...item,
      content_items: serialized
        ? [{ type: "inputText", text: serialized }]
        : [],
      status: state === "failure" ? "failed" : "completed",
    };
    accumulator.completed = true;
    accumulator.completedAt ??= completedAtMs;
    return state === "failure";
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
  }

  /** Ordered accumulators for rendering. */
  ordered(): ItemAccumulator[] {
    return this.itemOrder
      .map((id) => this.items.get(id))
      .filter((entry): entry is ItemAccumulator => entry !== undefined);
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
    const item = accumulator.item as
      | { type?: string; summary?: string[]; content?: string[] }
      | null;
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
