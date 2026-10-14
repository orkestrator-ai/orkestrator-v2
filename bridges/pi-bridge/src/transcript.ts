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
import { RecentlyRevisedRows } from "@orkestrator/protocol/node/revised-rows";
import {
  boundTranscriptInPlace,
  type TranscriptLimits,
} from "@orkestrator/protocol/node/transcript-budget";
import {
  saturatedText,
  type BridgeMessage,
  type BridgeMessagePart,
  type SessionState,
} from "./state.js";

const TRUNCATION_NOTICE = "\n\n[output truncated]";
/** Maximum unchecked growth while no renderer is polling the transcript. */
export const STREAM_BOUND_INTERVAL_BYTES = Math.min(MAX_TRANSCRIPT_BYTES, 1024 * 1024);

const TRANSCRIPT_LIMITS: TranscriptLimits = {
  maxMessages: MAX_MESSAGES,
  maxPartsPerMessage: MAX_PARTS_PER_MESSAGE,
  maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
};

/**
 * Append to a byte-capped buffer, returning the value to store.
 *
 * Returns the original reference unchanged once saturated so callers can skip
 * the write entirely; `carrier` is what records saturation, so an already-full
 * part costs one WeakSet lookup per remaining chunk instead of a full re-encode.
 */
export function appendBounded(
  carrier: BridgeMessage | BridgeMessagePart,
  current: string,
  addition: string,
  limit = MAX_MESSAGE_TEXT_BYTES,
): string {
  if (!addition) return current;
  if (saturatedText.has(carrier)) return current;
  const currentBytes = Buffer.byteLength(current);
  const additionBytes = Buffer.byteLength(addition);
  if (currentBytes + additionBytes <= limit) return current + addition;

  const available = limit - currentBytes - Buffer.byteLength(TRUNCATION_NOTICE);
  saturatedText.add(carrier);
  if (available <= 0) {
    return current.endsWith(TRUNCATION_NOTICE) ? current : current + TRUNCATION_NOTICE;
  }
  return current + sliceToBytes(addition, available) + TRUNCATION_NOTICE;
}

/** Truncate a standalone string to a byte budget, marking it when it trims. */
export function boundText(value: string, limit: number): string {
  if (Buffer.byteLength(value) <= limit) return value;
  const available = Math.max(0, limit - Buffer.byteLength(TRUNCATION_NOTICE));
  return sliceToBytes(value, available) + TRUNCATION_NOTICE;
}

/** Cut a string at a byte budget without splitting a UTF-8 code point. */
export function sliceToBytes(value: string, limit: number): string {
  if (limit <= 0) return "";
  const buffer = Buffer.from(value);
  if (buffer.length <= limit) return value;
  // `toString` on a buffer cut mid-sequence yields U+FFFD; walk back to the
  // last lead byte so the trimmed text stays valid rather than merely short.
  let end = limit;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Bring the transcript back inside its budget.
 *
 * Runs the cheap structural bounds first (message count, parts per message)
 * and then measures each retained message exactly once — never the shrinking
 * transcript again per dropped entry. Returns true when anything was dropped,
 * so the caller can bump the revision the renderer watches.
 */
export function boundTranscript(state: SessionState): boolean {
  const rowsBefore = state.messages.slice();
  const partsBefore = rowsBefore.map((row) => row.parts.length);
  const trimmed = boundTranscriptInPlace(state, TRANSCRIPT_LIMITS);
  if (!trimmed) return false;
  // Note the retained rows that shed parts. Rows go only from the front, so
  // what is left lines up with the tail of `rowsBefore`.
  const offset = rowsBefore.length - state.messages.length;
  state.messages.forEach((row, index) => {
    if (row.parts.length < partsBefore[index + offset]!) noteRowRevised(state, row.id);
  });
  return true;
}

/**
 * Re-measure only when the write path has charged something since the last
 * pass. Called from read routes, where an unconditional bound would make every
 * poll of a large session serialize the transcript twice.
 */
export function boundTranscriptForRead(state: SessionState): void {
  if (state.uncheckedTranscriptBytes === 0) return;
  if (boundTranscript(state)) state.revision += 1;
}

/**
 * Periodically enforce bounds from the synchronous SDK event listener.
 *
 * A tab can remain inactive for an entire long-running turn, so read-time and
 * terminal-state trimming are not sufficient memory bounds. The structural
 * checks are cheap and immediate; byte measurement is amortized so streaming
 * does not serialize a multi-megabyte transcript for every delta.
 */
export function boundTranscriptDuringStreaming(state: SessionState): void {
  const newest = state.messages.at(-1);
  if (
    state.messages.length <= MAX_MESSAGES &&
    (newest?.parts.length ?? 0) <= MAX_PARTS_PER_MESSAGE &&
    state.uncheckedTranscriptBytes < STREAM_BOUND_INTERVAL_BYTES
  ) {
    return;
  }
  if (boundTranscript(state)) state.revision += 1;
}

/** Charge appended bytes so the next read knows the budget may have moved. */
export function chargeTranscript(state: SessionState, bytes: number): void {
  if (bytes > 0) state.uncheckedTranscriptBytes += bytes;
}

/**
 * Rows a reader may hold a stale copy of, for `revisedMessageIds`.
 *
 * A row is one model response, so a late tool result, a measured command
 * change or a settled retry can patch a row newer responses have pushed out of
 * the live window, and readers only re-read the window. Held off the state
 * object so no persistence path can pick it up; a restored session starts with
 * none.
 */
const revisedRows = new WeakMap<SessionState, RecentlyRevisedRows>();

/** Note that the row `id` changed in place. */
export function noteRowRevised(state: SessionState, id: string): void {
  // The newest row is always inside the live window; only a row that changes
  // once a newer one exists can be outside it.
  if (state.messages.at(-1)?.id === id) return;
  let rows = revisedRows.get(state);
  if (!rows) {
    rows = new RecentlyRevisedRows();
    revisedRows.set(state, rows);
  }
  rows.note(id);
}

/**
 * Record a change to one row: note it and bump the revision readers compare.
 * Every in-place row change goes through here or `noteRowRevised`.
 */
export function rowChanged(state: SessionState, row: BridgeMessage): void {
  noteRowRevised(state, row.id);
  state.revision += 1;
}

/** Recently changed row ids, newest first; undefined when there are none. */
export function revisedRowIds(state: SessionState): string[] | undefined {
  const ids = revisedRows.get(state)?.ids();
  return ids && ids.length > 0 ? ids : undefined;
}

/** The history was replaced: ids noted against it name nothing in the new one. */
export function forgetRevisedRows(state: SessionState): void {
  revisedRows.get(state)?.clear();
}
