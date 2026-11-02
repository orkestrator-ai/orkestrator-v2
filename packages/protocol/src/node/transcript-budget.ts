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
  /**
   * Encoded size of each message, already known — from
   * {@link TranscriptRowSizes} — so the plan measures only parts.
   */
  messageSizes?: readonly number[];
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
  const known = options.messageSizes;
  if (known && known.length !== messages.length) {
    throw new Error("planOldestFirstTrim: messageSizes must describe every message");
  }
  const sizes = known ? known.slice() : messages.map((message) => measure(message));
  let measuredValues = known ? 0 : sizes.length;
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
  rowSizes?: TranscriptRowSizes,
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
    rowSizes?.invalidateRow(message);
    state.droppedParts += removed;
    state.transcriptTruncated = true;
    changed = true;
  }

  // The write path's dirty counter. Zero means these exact messages were
  // already measured, and re-measuring cannot change them, so a poll of a
  // large idle session does not pay a second full serialization.
  state.uncheckedTranscriptBytes = 0;

  const plan = planOldestFirstTrim(state.messages, limits.maxTranscriptBytes, {
    messageSizes: rowSizes?.measureRows(state.messages),
  });
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
    rowSizes?.invalidateRow(state.messages[0]!);
    state.droppedParts += plan.droppedParts;
    state.transcriptTruncated = true;
    changed = true;
  }
  return changed;
}

/**
 * Verify every remembered size against a fresh measurement and throw on a
 * mismatch. On under `bun test` (`NODE_ENV=test`), so each bridge suite proves
 * its write paths note every row they change; off in production, where it
 * would cost the serialization the cache exists to avoid.
 */
const VERIFY_REMEMBERED_SIZES = process.env.NODE_ENV === "test";

export interface RememberedSizeOptions {
  /** Re-measure every remembered size and throw when one is stale. */
  verify?: boolean;
}

/** Thrown in verification mode when a remembered size no longer matches. Content-free. */
export class StaleTranscriptSizeError extends Error {
  constructor(kind: "row" | "part", remembered: number, measured: number) {
    super(
      `Remembered transcript ${kind} size is stale (${remembered} bytes remembered, ` +
        `${measured} measured): a write path changed it without noting the change`,
    );
    this.name = "StaleTranscriptSizeError";
  }
}

/**
 * Encoded sizes of a transcript's rows, remembered between exact bounds.
 *
 * A dirty read used to serialize every retained row to learn whether the
 * transcript was still inside its budget, although only the rows that changed
 * since the last bound can have moved. This remembers each row's size and
 * re-measures only:
 *
 * - the newest row, always, because streaming writes into it without noting
 *   anything; and
 * - any row whose id was passed to {@link invalidate} since it was measured.
 *   The bridges call it from the same hook that records a row for
 *   `revisedMessageIds` (`noteRowRevised`, ACP's `noteRevisedRow`), which every
 *   in-place change to an older row must already reach, or readers would keep
 *   a stale copy of it.
 *
 * A remembered size is also tied to the row object it was taken from and to
 * the row that followed it, so a replaced history, a reused id, or a row that
 * became the newest again when the rows after it were removed (and may have
 * been streamed into since) is measured afresh.
 *
 * Bounds: one entry per retained row other than the newest, rebuilt on every
 * measurement, so never more than the transcript's own message cap.
 */
export class TranscriptRowSizes {
  #rows = new Map<string, RememberedRow>();
  readonly #verify: boolean;

  constructor(options: RememberedSizeOptions = {}) {
    this.#verify = options.verify ?? VERIFY_REMEMBERED_SIZES;
  }

  /** The row `id` changed in place; measure it again next time. */
  invalidate(id: string): void {
    this.#rows.delete(id);
  }

  /** {@link invalidate} for a row object, when it has an id. */
  invalidateRow(row: object): void {
    const id = rowId(row);
    if (id !== undefined) this.#rows.delete(id);
  }

  /** Forget every remembered size: the history was replaced. */
  clear(): void {
    this.#rows.clear();
  }

  /** Remembered entries, for tests of the count bound. */
  get size(): number {
    return this.#rows.size;
  }

  /**
   * The encoded size of each of `messages`, exactly as {@link encodedJsonBytes}
   * would report it, measuring only the rows that may have changed.
   */
  measureRows(messages: readonly object[], measure = encodedJsonBytes): number[] {
    const previous = this.#rows;
    const next = new Map<string, RememberedRow>();
    const newest = messages.length - 1;
    const sizes = messages.map((row, index) => {
      const id = rowId(row);
      const known = id === undefined ? undefined : previous.get(id);
      const follower = messages[index + 1];
      let bytes: number;
      if (index < newest && known?.row === row && known.follower === follower) {
        bytes = known.bytes;
        if (this.#verify) {
          const measured = measure(row);
          if (measured !== bytes) throw new StaleTranscriptSizeError("row", bytes, measured);
        }
      } else {
        bytes = measure(row);
      }
      if (follower && id !== undefined) next.set(id, { row, follower, bytes });
      return bytes;
    });
    this.#rows = next;
    return sizes;
  }
}

interface RememberedRow {
  row: object;
  /** The row after it when measured; the newest row is never remembered. */
  follower: object;
  bytes: number;
}

function rowId(row: object): string | undefined {
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Exact encoded sizes of flat objects rewritten in place — tool cards — that
 * re-measure only the string fields that changed.
 *
 * A tool card is rewritten on every streaming frame, and charging it meant
 * serializing the whole card each time: up to half a megabyte of output per
 * frame of a running command. Strings are immutable, so a string field whose
 * value is the one last measured costs nothing, and one that extends it (the
 * usual streaming shape) costs its new suffix plus one prefix comparison.
 * Object and array fields can be mutated in place, so they are measured every
 * time.
 *
 * The result is exactly `encodedJsonBytes(object)`.
 *
 * Bounds: per live object (held weakly), one entry per string field it holds,
 * each referencing a string the object held when last measured.
 */
export class EncodedObjectSizes {
  #fields = new WeakMap<object, Map<string, { value: string; bytes: number }>>();
  readonly #verify: boolean;

  constructor(options: RememberedSizeOptions = {}) {
    this.#verify = options.verify ?? VERIFY_REMEMBERED_SIZES;
  }

  measure(object: object): number {
    let fields = this.#fields.get(object);
    if (!fields) {
      fields = new Map();
      this.#fields.set(object, fields);
    }
    let bytes = 2;
    let members = 0;
    for (const key of Object.keys(object)) {
      const value = (object as Record<string, unknown>)[key];
      if (value === undefined || typeof value === "function" || typeof value === "symbol") {
        fields.delete(key);
        continue;
      }
      let valueBytes: number;
      if (typeof value === "string") {
        valueBytes = encodedStringBytes(value, fields.get(key));
        fields.set(key, { value, bytes: valueBytes });
      } else {
        fields.delete(key);
        valueBytes = encodedJsonBytes(value);
      }
      bytes += encodedJsonBytes(key) + 1 + valueBytes;
      members += 1;
    }
    if (fields.size > members) {
      for (const key of Array.from(fields.keys())) {
        if (!Object.hasOwn(object, key)) fields.delete(key);
      }
    }
    bytes += Math.max(0, members - 1);
    if (this.#verify) {
      const measured = encodedJsonBytes(object);
      if (measured !== bytes) throw new StaleTranscriptSizeError("part", bytes, measured);
    }
    return bytes;
  }
}

/** Encoded bytes of `JSON.stringify(value)`, from the previous value when `value` extends it. */
function encodedStringBytes(
  value: string,
  previous: { value: string; bytes: number } | undefined,
): number {
  if (previous) {
    if (previous.value === value) return previous.bytes;
    const before = previous.value;
    if (value.length > before.length && value.startsWith(before)) {
      const suffix = value.slice(before.length);
      // JSON escapes each UTF-16 unit on its own except a surrogate pair:
      // apart, each half is a six-byte `\uXXXX`; together, four UTF-8 bytes.
      const high = before.charCodeAt(before.length - 1);
      const low = suffix.charCodeAt(0);
      const splitPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
      return previous.bytes + jsonStringContentBytes(suffix) - (splitPair ? 8 : 0);
    }
  }
  return Buffer.byteLength(JSON.stringify(value));
}
