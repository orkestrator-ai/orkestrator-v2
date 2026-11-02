/**
 * Keeping the rendered transcript inside its display budget.
 *
 * The bridge holds one transcript per session for the lifetime of an
 * environment and serves it whole to a renderer. Trimming is therefore a
 * presentation concern with a hard memory consequence, and it is deliberately
 * separate from whether work still exists — dropping a tool card for display
 * must never be read as evidence that the tool stopped running, and it must
 * never resolve an approval parked on that card.
 */
import {
  MAX_MESSAGES,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_PARTS_PER_MESSAGE,
  MAX_TRANSCRIPT_BYTES,
} from "./config.js";
import { createBridgeTranscriptBounds } from "@orkestrator/protocol/node/bridge-transcript-bounds";
import {
  BoundedTextAppender,
  boundUtf8Text,
  sliceUtf8,
} from "@orkestrator/protocol/node/bridge-transcript-text";
import {
  saturatedText,
  type BridgeMessage,
  type BridgeMessagePart,
  type SessionState,
} from "./state.js";

const TRUNCATION_NOTICE = "\n\n[output truncated]";
/** Maximum unchecked growth while no renderer is polling the transcript. */
export const STREAM_BOUND_INTERVAL_BYTES = Math.min(MAX_TRANSCRIPT_BYTES, 1024 * 1024);

const bounds = createBridgeTranscriptBounds<SessionState>({
  maxMessages: MAX_MESSAGES,
  maxPartsPerMessage: MAX_PARTS_PER_MESSAGE,
  maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
  streamIntervalBytes: STREAM_BOUND_INTERVAL_BYTES,
});

const appender = new BoundedTextAppender({
  notice: TRUNCATION_NOTICE,
  policy: "append-notice",
  saturated: saturatedText,
});

/**
 * Append to a byte-capped buffer, returning the value to store.
 *
 * Returns the original reference unchanged once saturated so callers can skip
 * the write entirely; `carrier` is what records saturation, so an already-full
 * part costs one WeakSet lookup per remaining chunk instead of a full re-encode.
 * It also remembers the buffer's byte length, so a delta is not charged a
 * fresh measurement of everything before it.
 */
export function appendBounded(
  carrier: BridgeMessage | BridgeMessagePart,
  current: string,
  addition: string,
  limit = MAX_MESSAGE_TEXT_BYTES,
): string {
  return appender.append(current, addition, limit, carrier).value;
}

/** Truncate a standalone string to a byte budget, marking it when it trims. */
export function boundText(value: string, limit: number): string {
  return boundUtf8Text(value, limit, TRUNCATION_NOTICE);
}

/** Cut a string at a byte budget without splitting a UTF-8 code point. */
export const sliceToBytes = sliceUtf8;

/**
 * Bring the transcript back inside its budget.
 *
 * Runs the cheap structural bounds first (message count, parts per message)
 * and then the byte bound, which re-measures only the newest row and the rows
 * noted as changed since the last pass. Returns true when anything was
 * dropped, so the caller can bump the revision the renderer watches.
 */
export const boundTranscript = bounds.boundTranscript;

/**
 * Re-measure only when the write path has charged something since the last
 * pass. Called from read routes, where an unconditional bound would make every
 * poll of a large session serialize the transcript twice.
 */
export const boundTranscriptForRead = bounds.boundTranscriptForRead;

/**
 * Periodically enforce bounds from the synchronous SDK event listener.
 *
 * A tab can remain inactive for an entire long-running turn, so read-time and
 * terminal-state trimming are not sufficient memory bounds. The structural
 * checks are cheap and immediate; byte measurement is amortized so streaming
 * does not serialize a multi-megabyte transcript for every delta.
 */
export function boundTranscriptDuringStreaming(state: SessionState): void {
  if (!bounds.streamingBoundDue(state)) return;
  if (boundTranscript(state)) state.revision += 1;
}

/** Charge appended bytes so the next read knows the budget may have moved. */
export const chargeTranscript = bounds.chargeTranscript;

/**
 * Rows a reader may hold a stale copy of, for `revisedMessageIds`.
 *
 * A row is one model response, so a late tool result, a measured command
 * change or a settled retry can patch a row newer responses have pushed out of
 * the live window, and readers only re-read the window. Every in-place change
 * to a row other than the newest must reach `noteRowRevised` (or `rowChanged`):
 * it is also what tells the byte bound to measure that row again.
 */
export const noteRowRevised = bounds.noteRowRevised;

/** Record a change to one row: note it and bump the revision readers compare. */
export const rowChanged: (state: SessionState, row: BridgeMessage) => void = bounds.rowChanged;

/** Measure a row again at the next bound without noting it for readers. */
export const forgetRowSize: (state: SessionState, row: BridgeMessage) => void =
  bounds.forgetRowSize;

/** Lost revision notes require retained-page reconciliation. */
export const revisedRowsOverflowVersion = bounds.revisedRowsOverflowVersion;

/** Recently changed row ids, newest first; undefined when there are none. */
export const revisedRowIds = bounds.revisedRowIds;

/** The history was replaced: ids noted against it name nothing in the new one. */
export const forgetRevisedRows = bounds.forgetRevisedRows;
