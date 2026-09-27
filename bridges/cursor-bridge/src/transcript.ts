/**
 * Keeping the rendered transcript inside its display budget.
 *
 * The bridge holds one transcript per session for the lifetime of an
 * environment and serves it whole to a renderer. Trimming is therefore a
 * presentation concern with a hard memory consequence, and it is deliberately
 * separate from whether background work still exists — dropping a tool card
 * for display must never be read as evidence that the tool stopped running.
 */
import {
  MAX_MESSAGES,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_PARTS_PER_MESSAGE,
  MAX_TRANSCRIPT_BYTES,
} from "./config.js";
import {
  boundTranscriptInPlace,
  type TranscriptLimits,
} from "@orkestrator/protocol/transcript-budget";
import {
  saturatedText,
  type BridgeMessage,
  type BridgeMessagePart,
  type SessionState,
} from "./state.js";

const TRUNCATION_NOTICE = "\n\n[output truncated]";
/** Maximum charged growth between exact measurements while streaming. */
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
  return boundTranscriptInPlace(state, TRANSCRIPT_LIMITS);
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
 * Enforce the budget from the SDK's synchronous update callback.
 *
 * A tab can stay inactive for an entire long turn, and `/activity` is
 * deliberately a no-hydration read, so read-time and turn-boundary trimming
 * alone let an unobserved session grow without limit. Structural limits are
 * checked on every update because they cost nothing; the byte measurement is
 * amortized over {@link STREAM_BOUND_INTERVAL_BYTES} of charged growth so
 * streaming never serializes the transcript per token.
 *
 * The retained transcript therefore never exceeds `MAX_TRANSCRIPT_BYTES`
 * plus `STREAM_BOUND_INTERVAL_BYTES` plus one admitted update — and a single
 * update is itself capped by the per-field text, argument, output and diff
 * limits in `config.ts`.
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

/**
 * Charge appended bytes so the next bound knows the budget may have moved.
 *
 * Charges must be upper bounds on encoded growth — see
 * {@link jsonStringContentBytes} — or the streaming bound can fall behind.
 */
export function chargeTranscript(state: SessionState, bytes: number): void {
  if (bytes > 0) state.uncheckedTranscriptBytes += bytes;
}
