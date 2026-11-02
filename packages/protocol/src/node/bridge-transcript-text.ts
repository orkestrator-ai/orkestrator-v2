/**
 * Byte-capped text for the Pi, Cursor and ACP bridges' display transcripts.
 *
 * Each of those bridges used to carry its own copy of these helpers. They
 * agree on cutting at a UTF-8 code point and on marking a cut, and differ only
 * in the marker and in what happens when the cap is reached, which
 * {@link TruncationPolicy} names, so every bridge's output is what its own
 * copy produced.
 *
 * Appending is the streaming hot path: one call per token. The byte length of
 * the buffer being extended is remembered against the object that owns it, so
 * a delta costs the bytes of the delta rather than a fresh measurement of the
 * whole (up to half a megabyte) buffer every time.
 */

import { Buffer } from "node:buffer";

/** Cut a string at a byte budget without splitting a UTF-8 code point. */
export function sliceUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const buffer = Buffer.from(value);
  if (buffer.length <= maximumBytes) return value;
  // `toString` on a buffer cut mid-sequence yields U+FFFD (three bytes); walk
  // back to the last lead byte so the trimmed text stays valid and inside the
  // cap rather than merely short.
  let end = maximumBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/** Truncate a standalone string to a byte budget, ending it with `notice` when it trims. */
export function boundUtf8Text(value: string, maximumBytes: number, notice: string): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  const available = Math.max(0, maximumBytes - Buffer.byteLength(notice));
  return sliceUtf8(value, available) + notice;
}

/**
 * What an append does once the buffer would pass its cap.
 *
 * - `append-notice` (Pi, Cursor): keep the buffer, fill what room is left and
 *   put the notice after it. A buffer with no room left for the notice still
 *   gets it once, so it may end a few bytes past the cap.
 * - `reserve-notice` (ACP): the result never passes the cap. Room for the
 *   notice is taken from the buffer already held when the addition cannot
 *   pay for it, so a short buffer is never presented as complete.
 */
export type TruncationPolicy = "append-notice" | "reserve-notice";

export interface BoundedAppend {
  value: string;
  truncated: boolean;
}

export interface BoundedTextAppenderOptions {
  notice: string;
  policy: TruncationPolicy;
  /**
   * Owners whose buffer has reached its cap. Shared with the bridge's own
   * state module when other code reads it; created here otherwise.
   */
  saturated?: WeakSet<object>;
}

interface MeasuredText {
  value: string;
  bytes: number;
}

/**
 * Appends to byte-capped buffers, remembering each owner's buffer length.
 *
 * `owner` is the object that stores the buffer (a part, a message, a session).
 * It records saturation, so a buffer already at its cap costs one lookup per
 * remaining chunk, and it carries the memoised byte length of the buffer last
 * returned for it. The memo is only used when `current` equals the string it
 * was taken from, so an owner whose text was replaced by other code, or that
 * holds two buffers, is measured again rather than miscounted.
 *
 * Bounds: one memo entry per live owner, held weakly; each holds a reference
 * to a string its owner already holds, capped by the caller's own limit.
 */
export class BoundedTextAppender {
  readonly notice: string;
  readonly policy: TruncationPolicy;
  readonly saturated: WeakSet<object>;
  readonly #noticeBytes: number;
  readonly #lengths = new WeakMap<object, MeasuredText>();

  constructor(options: BoundedTextAppenderOptions) {
    this.notice = options.notice;
    this.policy = options.policy;
    this.saturated = options.saturated ?? new WeakSet();
    this.#noticeBytes = Buffer.byteLength(options.notice);
  }

  /**
   * Append `addition` to `current`, capped at `maximumBytes`.
   *
   * With an `owner`, a cut marks it saturated and later calls return `current`
   * unchanged with `truncated: true`; pass `saturate: false` to use the owner
   * only for the remembered length.
   */
  append(
    current: string,
    addition: string,
    maximumBytes: number,
    owner?: object,
    saturate = true,
  ): BoundedAppend {
    if (owner && saturate && this.saturated.has(owner)) return { value: current, truncated: true };
    if (!addition) return { value: current, truncated: false };
    const currentBytes = this.byteLength(current, owner);
    const additionBytes = Buffer.byteLength(addition);
    if (currentBytes + additionBytes <= maximumBytes) {
      const value = current + addition;
      if (owner) {
        this.#lengths.set(owner, {
          value,
          bytes: concatenatedBytes(current, currentBytes, addition, additionBytes),
        });
      }
      return { value, truncated: false };
    }

    if (owner) {
      this.#lengths.delete(owner);
      if (saturate) this.saturated.add(owner);
    }
    if (this.policy === "append-notice") {
      const available = maximumBytes - currentBytes - this.#noticeBytes;
      if (available <= 0) {
        const value = current.endsWith(this.notice) ? current : current + this.notice;
        return { value, truncated: true };
      }
      return { value: current + sliceUtf8(addition, available) + this.notice, truncated: true };
    }
    const contentLimit = Math.max(0, maximumBytes - this.#noticeBytes);
    const prefix = currentBytes <= contentLimit ? current : sliceUtf8(current, contentLimit);
    const prefixBytes = prefix === current ? currentBytes : Buffer.byteLength(prefix);
    const usable = Math.max(0, contentLimit - prefixBytes);
    return {
      value: prefix + sliceUtf8(addition, usable) + sliceUtf8(this.notice, maximumBytes),
      truncated: true,
    };
  }

  /** UTF-8 bytes of `value`, from `owner`'s memo when it still describes `value`. */
  byteLength(value: string, owner?: object): number {
    const known = owner ? this.#lengths.get(owner) : undefined;
    // `===` on the very string the memo was taken from is a pointer check.
    if (known && known.value === value) return known.bytes;
    return Buffer.byteLength(value);
  }
}

/**
 * UTF-8 bytes of `left + right` from the two lengths.
 *
 * A surrogate pair split across the join encodes as two replacement
 * characters (three bytes each) apart and as one four-byte code point
 * together, so the sum overcounts by two in exactly that case.
 */
function concatenatedBytes(
  left: string,
  leftBytes: number,
  right: string,
  rightBytes: number,
): number {
  const high = left.charCodeAt(left.length - 1);
  const low = right.charCodeAt(0);
  const splitPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return leftBytes + rightBytes - (splitPair ? 2 : 0);
}
