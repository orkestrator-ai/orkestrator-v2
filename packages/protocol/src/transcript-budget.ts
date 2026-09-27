/**
 * Linear, exact byte accounting for trimming a bridge's in-memory transcript.
 *
 * The Cursor, Pi and ACP bridges each keep one transcript per session and
 * bound it oldest-first: whole messages from the front, then parts from the
 * front of the one message left. They used to re-serialize the entire
 * transcript after every dropped entry, which is quadratic in the number of
 * entries shed — thousands of full passes on the synchronous SDK listener when
 * a long turn crosses the budget.
 *
 * This module measures every candidate exactly once and subtracts. The unit is
 * the UTF-8 byte length of `JSON.stringify`, including escapes, brackets and
 * separating commas, so the planned size is the size the old loop would have
 * measured, not an estimate. Callers apply the returned plan with one splice
 * per array.
 */

import { Buffer } from "node:buffer";

/** UTF-8 bytes of `JSON.stringify(value)`; zero for values JSON omits. */
export function encodedJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json);
}

/** Bytes of a JSON array whose elements encode to `total` bytes in all. */
export function jsonArrayBytes(count: number, total: number): number {
  return 2 + total + Math.max(0, count - 1);
}

export interface TrimCandidateMessage {
  parts: readonly unknown[];
}

/**
 * A part the caller puts in front of the retained parts once any are dropped
 * (ACP's "transcript trimmed" notice). It occupies a slot, so it counts against
 * the part length a trim must strictly reduce.
 */
export interface LeadingPartReplacement {
  /** Encoded bytes of the replacement part exactly as it will be stored. */
  bytes: number;
  /** True when `parts[0]` already is that replacement. */
  present: boolean;
}

export interface OldestFirstTrimOptions<TMessage extends TrimCandidateMessage> {
  /** Custom measurement, for tests; defaults to {@link encodedJsonBytes}. */
  measure?: (value: unknown) => number;
  /** The replacement for the message whose parts are about to be trimmed, if any. */
  leadingReplacement?: (message: TMessage) => LeadingPartReplacement;
}

export interface OldestFirstTrimPlan {
  /** Whole messages to remove from the front. */
  droppedMessages: number;
  /** Parts removed from the front of the single retained message, excluding any existing replacement. */
  droppedParts: number;
  /** Exact encoded bytes of the retained array once the plan is applied. */
  bytes: number;
  /** True when the plan still leaves the array over budget. */
  overflowed: boolean;
  /** How many message serializations the plan cost; one per candidate, plus parts when needed. */
  measuredValues: number;
}

/**
 * Plan the trim the bridges' former loops performed, in one linear pass.
 *
 * Semantics preserved from those loops:
 * - drop whole messages from the front while more than one remains and the
 *   array is over budget;
 * - with one message left and still over budget, drop parts from its front,
 *   each step strictly shortening `parts`, and never iterating once `parts`
 *   has one entry left;
 * - with a leading replacement, the replacement takes the front slot the
 *   first time anything is dropped, so the first step removes two real parts
 *   unless the replacement is already present.
 */
export function planOldestFirstTrim<TMessage extends TrimCandidateMessage>(
  messages: readonly TMessage[],
  maximumBytes: number,
  options: OldestFirstTrimOptions<TMessage> = {},
): OldestFirstTrimPlan {
  const measure = options.measure ?? encodedJsonBytes;
  const sizes = messages.map((message) => measure(message));
  let measuredValues = sizes.length;
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let count = messages.length;
  let bytes = jsonArrayBytes(count, total);

  let droppedMessages = 0;
  while (bytes > maximumBytes && count > 1) {
    total -= sizes[droppedMessages]!;
    droppedMessages += 1;
    count -= 1;
    bytes = jsonArrayBytes(count, total);
  }

  let droppedParts = 0;
  const only = count === 1 ? messages[droppedMessages] : undefined;
  if (bytes > maximumBytes && only && only.parts.length > 1) {
    const replacement = options.leadingReplacement?.(only);
    const offset = replacement?.present ? 1 : 0;
    const realCount = only.parts.length - offset;
    const realSizes = only.parts.slice(offset).map((part) => measure(part));
    measuredValues += realSizes.length;
    const realTotal = realSizes.reduce((sum, size) => sum + size, 0);
    const existingReplacementBytes = replacement?.present ? replacement.bytes : 0;
    const partsInner = (length: number, partBytes: number) => partBytes + Math.max(0, length - 1);
    // Everything in the message except the contents of its `parts` array.
    const messageShell =
      sizes[droppedMessages]! - partsInner(only.parts.length, existingReplacementBytes + realTotal);
    const otherBytes = bytes - sizes[droppedMessages]!;

    let removed = 0;
    let dropped = 0;
    let length = only.parts.length;
    while (bytes > maximumBytes && length > 1) {
      // Each step must strictly shorten `parts`; with a replacement that has
      // not been inserted yet, one extra real part pays for its slot.
      do {
        removed += realSizes[dropped]!;
        dropped += 1;
      } while (dropped < realCount && (replacement ? 1 : 0) + realCount - dropped >= length);
      length = (replacement ? 1 : 0) + realCount - dropped;
      const retainedBytes = (replacement ? replacement.bytes : 0) + realTotal - removed;
      bytes = otherBytes + messageShell + partsInner(length, retainedBytes);
    }
    droppedParts = dropped;
  }

  return {
    droppedMessages,
    droppedParts,
    bytes,
    overflowed: bytes > maximumBytes,
    measuredValues,
  };
}

/**
 * Exact UTF-8 bytes a string occupies inside a JSON document, without its
 * surrounding quotes.
 *
 * Streaming producers charge appended text with this rather than with
 * `string.length`: UTF-16 length undercounts multibyte text by up to three
 * times, and escapes (`\n`, `\"`, control characters) grow it further, so a
 * length-based charge let the dirty counter lag far behind the real size.
 * Concatenation never encodes larger than the sum of its pieces, so summing
 * per-append charges is an upper bound on the growth they cause.
 */
export function jsonStringContentBytes(value: string): number {
  return value ? Buffer.byteLength(JSON.stringify(value)) - 2 : 0;
}

/** The display-transcript state the Cursor and Pi bridges bound in place. */
export interface BoundableTranscriptState {
  messages: TrimCandidateMessage[];
  droppedMessages: number;
  droppedParts: number;
  transcriptTruncated: boolean;
  /** Upper bound on encoded growth since the last exact measurement. */
  uncheckedTranscriptBytes: number;
}

export interface TranscriptLimits {
  maxMessages: number;
  maxPartsPerMessage: number;
  maxTranscriptBytes: number;
}

/**
 * Bring a bridge's display transcript back inside its budget, in place.
 *
 * The cheap structural bounds run first (message count, parts per message);
 * the byte bound then measures every retained message once and trims with
 * {@link planOldestFirstTrim}. Returns true when anything was dropped, so the
 * caller can bump the revision its readers watch.
 *
 * Trimming is display-only. Callers keep lifecycle registries (active
 * children, approvals, dispatch journals) outside `messages`, so shedding a
 * card never implies the work behind it stopped.
 */
export function boundTranscriptInPlace(
  state: BoundableTranscriptState,
  limits: TranscriptLimits,
): boolean {
  let changed = false;

  if (state.messages.length > limits.maxMessages) {
    const removed = state.messages.length - limits.maxMessages;
    const dropped = state.messages.splice(0, removed);
    state.droppedMessages += removed;
    state.droppedParts += dropped.reduce((total, message) => total + message.parts.length, 0);
    state.transcriptTruncated = true;
    changed = true;
  }

  for (const message of state.messages) {
    if (message.parts.length <= limits.maxPartsPerMessage) continue;
    const removed = message.parts.length - limits.maxPartsPerMessage;
    (message.parts as unknown[]).splice(0, removed);
    state.droppedParts += removed;
    state.transcriptTruncated = true;
    changed = true;
  }

  // The write path's dirty counter. Zero means these exact messages were
  // already measured, and re-measuring cannot change them, so a poll of a
  // large idle session does not pay a second full serialization.
  state.uncheckedTranscriptBytes = 0;

  const plan = planOldestFirstTrim(state.messages, limits.maxTranscriptBytes);
  if (plan.droppedMessages > 0) {
    const dropped = state.messages.splice(0, plan.droppedMessages);
    state.droppedMessages += dropped.length;
    state.droppedParts += dropped.reduce((total, message) => total + message.parts.length, 0);
    state.transcriptTruncated = true;
    changed = true;
  }
  // A single message can exceed the whole budget on its own. Its parts are
  // shed from the front rather than dropping the message, so the turn the
  // user is watching keeps its most recent output.
  if (plan.droppedParts > 0) {
    (state.messages[0]!.parts as unknown[]).splice(0, plan.droppedParts);
    state.droppedParts += plan.droppedParts;
    state.transcriptTruncated = true;
    changed = true;
  }
  return changed;
}
