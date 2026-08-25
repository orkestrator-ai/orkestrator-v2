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
import {
  saturatedText,
  type BridgeMessage,
  type BridgeMessagePart,
  type SessionState,
} from "./state.js";

const TRUNCATION_NOTICE = "\n\n[output truncated]";
/** Maximum unchecked growth while no renderer is polling the transcript. */
export const STREAM_BOUND_INTERVAL_BYTES = Math.min(MAX_TRANSCRIPT_BYTES, 1024 * 1024);

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
 * and only then measures, because measuring means serializing the whole
 * transcript. Returns true when anything was dropped, so the caller can bump
 * the revision the renderer watches.
 */
export function boundTranscript(state: SessionState): boolean {
  let changed = false;

  if (state.messages.length > MAX_MESSAGES) {
    const removed = state.messages.length - MAX_MESSAGES;
    const dropped = state.messages.splice(0, removed);
    state.droppedMessages += removed;
    state.droppedParts += dropped.reduce((total, message) => total + message.parts.length, 0);
    state.transcriptTruncated = true;
    changed = true;
  }

  for (const message of state.messages) {
    if (message.parts.length <= MAX_PARTS_PER_MESSAGE) continue;
    const removed = message.parts.length - MAX_PARTS_PER_MESSAGE;
    message.parts.splice(0, removed);
    state.droppedParts += removed;
    state.transcriptTruncated = true;
    changed = true;
  }

  // The write path's dirty counter. Zero means these exact messages were
  // already measured, and re-measuring cannot change them, so a poll of a
  // large idle session does not pay a second full serialization.
  state.uncheckedTranscriptBytes = 0;

  while (state.messages.length > 1 && transcriptBytes(state) > MAX_TRANSCRIPT_BYTES) {
    const dropped = state.messages.shift()!;
    state.droppedMessages += 1;
    state.droppedParts += dropped.parts.length;
    state.transcriptTruncated = true;
    changed = true;
  }

  // A single message can exceed the whole budget on its own. Shed its parts
  // from the front rather than dropping the message, so the turn the user is
  // watching keeps its most recent output.
  const only = state.messages[0];
  if (only && state.messages.length === 1 && transcriptBytes(state) > MAX_TRANSCRIPT_BYTES) {
    while (only.parts.length > 1 && transcriptBytes(state) > MAX_TRANSCRIPT_BYTES) {
      only.parts.shift();
      state.droppedParts += 1;
      state.transcriptTruncated = true;
      changed = true;
    }
  }

  return changed;
}

function transcriptBytes(state: SessionState): number {
  return Buffer.byteLength(JSON.stringify(state.messages));
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
