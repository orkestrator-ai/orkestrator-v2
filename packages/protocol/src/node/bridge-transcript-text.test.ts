import { describe, expect, test } from "bun:test";
import { BoundedTextAppender, boundUtf8Text, sliceUtf8 } from "./bridge-transcript-text";

// The helpers each bridge carried before they moved here, verbatim apart from
// names, as references: the shared versions must produce the same text.

const PI_NOTICE = "\n\n[output truncated]";
const ACP_MARKER = "\n[output truncated by Orkestrator]";

function referenceSliceToBytes(value: string, limit: number): string {
  if (limit <= 0) return "";
  const buffer = Buffer.from(value);
  if (buffer.length <= limit) return value;
  let end = limit;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function referenceBoundText(value: string, limit: number): string {
  if (Buffer.byteLength(value) <= limit) return value;
  const available = Math.max(0, limit - Buffer.byteLength(PI_NOTICE));
  return referenceSliceToBytes(value, available) + PI_NOTICE;
}

/** Pi's and Cursor's `appendBounded`. */
function referencePiAppend(
  saturated: WeakSet<object>,
  carrier: object,
  current: string,
  addition: string,
  limit: number,
): string {
  if (!addition) return current;
  if (saturated.has(carrier)) return current;
  const currentBytes = Buffer.byteLength(current);
  const additionBytes = Buffer.byteLength(addition);
  if (currentBytes + additionBytes <= limit) return current + addition;
  const available = limit - currentBytes - Buffer.byteLength(PI_NOTICE);
  saturated.add(carrier);
  if (available <= 0) {
    return current.endsWith(PI_NOTICE) ? current : current + PI_NOTICE;
  }
  return current + referenceSliceToBytes(addition, available) + PI_NOTICE;
}

/** ACP's `appendBounded`. */
function referenceAcpAppend(
  current: string,
  addition: string,
  maximumBytes: number,
): { value: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current);
  const remaining = Math.max(0, maximumBytes - currentBytes);
  if (Buffer.byteLength(addition) <= remaining)
    return { value: current + addition, truncated: false };
  const markerBytes = Buffer.byteLength(ACP_MARKER);
  const contentLimit = Math.max(0, maximumBytes - markerBytes);
  const prefix = referenceSliceToBytes(current, contentLimit);
  const usable = Math.max(0, contentLimit - Buffer.byteLength(prefix));
  return {
    value:
      prefix +
      referenceSliceToBytes(addition, usable) +
      referenceSliceToBytes(ACP_MARKER, maximumBytes),
    truncated: true,
  };
}

/** ACP's `appendSaturating`. */
function referenceAcpSaturating(
  saturated: WeakSet<object>,
  target: object | undefined,
  current: string,
  addition: string,
  maximumBytes: number,
): { value: string; truncated: boolean } {
  if (target && saturated.has(target)) return { value: current, truncated: true };
  const next = referenceAcpAppend(current, addition, maximumBytes);
  if (next.truncated && target) saturated.add(target);
  return next;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

// Multibyte, astral (whose halves a chunk boundary can split), escapes, and
// the notices themselves, so `endsWith(notice)` is exercised.
const PIECES = ["a", "é", "中", "😀", "\uD83D", "\uDE00", "\n", '"', " ", PI_NOTICE];

function chunk(next: () => number): string {
  const length = Math.floor(next() * 12);
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += PIECES[Math.floor(next() * PIECES.length)];
  }
  return value;
}

describe("sliceUtf8 and boundUtf8Text", () => {
  test("match the bridges' former helpers", () => {
    const next = random(7);
    for (let round = 0; round < 2_000; round += 1) {
      const value = chunk(next) + chunk(next) + chunk(next);
      const limit = Math.floor(next() * 60) - 5;
      expect(sliceUtf8(value, limit)).toBe(referenceSliceToBytes(value, limit));
      expect(boundUtf8Text(value, limit, PI_NOTICE)).toBe(referenceBoundText(value, limit));
    }
  });

  test("never split a code point", () => {
    expect(sliceUtf8("a😀b", 2)).toBe("a");
    expect(sliceUtf8("a😀b", 5)).toBe("a😀");
    expect(sliceUtf8("中", 0)).toBe("");
  });
});

describe("BoundedTextAppender", () => {
  test("append-notice streams exactly what Pi's and Cursor's appendBounded did", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const appender = new BoundedTextAppender({ notice: PI_NOTICE, policy: "append-notice" });
      const referenceSaturated = new WeakSet<object>();
      const shared = {};
      const reference = {};
      const limit = 8 + Math.floor(next() * 120);
      let actual = "";
      let expected = "";
      for (let step = 0; step < 60; step += 1) {
        const addition = chunk(next);
        actual = appender.append(actual, addition, limit, shared).value;
        expected = referencePiAppend(referenceSaturated, reference, expected, addition, limit);
        expect(actual).toBe(expected);
      }
      expect(appender.saturated.has(shared)).toBe(referenceSaturated.has(reference));
    }
  });

  test("reserve-notice streams exactly what ACP's appendSaturating did", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed * 31);
      const appender = new BoundedTextAppender({ notice: ACP_MARKER, policy: "reserve-notice" });
      const referenceSaturated = new WeakSet<object>();
      const shared = {};
      const reference = {};
      // Includes caps below the marker's own length.
      const limit = Math.floor(next() * 120);
      let actual = { value: "", truncated: false };
      let expected = { value: "", truncated: false };
      for (let step = 0; step < 60; step += 1) {
        const addition = chunk(next);
        actual = appender.append(actual.value, addition, limit, shared);
        expected = referenceAcpSaturating(
          referenceSaturated,
          reference,
          expected.value,
          addition,
          limit,
        );
        expect(actual).toEqual(expected);
      }
    }
  });

  test("reserve-notice without saturation matches ACP's plain appendBounded", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = random(seed * 17);
      const appender = new BoundedTextAppender({ notice: ACP_MARKER, policy: "reserve-notice" });
      const owner = {};
      const limit = Math.floor(next() * 120);
      let actual = "";
      let expected = "";
      for (let step = 0; step < 40; step += 1) {
        const addition = chunk(next);
        const got = appender.append(actual, addition, limit, owner, false);
        const want = referenceAcpAppend(expected, addition, limit);
        expect(got).toEqual(want);
        actual = got.value;
        expected = want.value;
      }
      expect(appender.saturated.has(owner)).toBe(false);
    }
  });

  test("remembers the buffer's exact byte length, including across a split surrogate pair", () => {
    const appender = new BoundedTextAppender({ notice: PI_NOTICE, policy: "append-notice" });
    const owner = {};
    let value = appender.append("", "ab\uD83D", 100, owner).value;
    expect(appender.byteLength(value, owner)).toBe(Buffer.byteLength(value));
    value = appender.append(value, "\uDE00c", 100, owner).value;
    expect(value).toBe("ab😀c");
    expect(appender.byteLength(value, owner)).toBe(Buffer.byteLength(value));
  });

  test("measures again when the owner's text was replaced by other code", () => {
    const appender = new BoundedTextAppender({ notice: PI_NOTICE, policy: "append-notice" });
    const owner = {};
    appender.append("", "x".repeat(10), 20, owner);
    // Someone else rewrote the field: the memo no longer describes `current`.
    const replaced = "中".repeat(6);
    expect(appender.byteLength(replaced, owner)).toBe(18);
    expect(appender.append(replaced, "abc", 20, owner)).toEqual({
      value: replaced + PI_NOTICE,
      truncated: true,
    });
  });

  test("a saturated owner returns its buffer unchanged without measuring it", () => {
    const appender = new BoundedTextAppender({ notice: PI_NOTICE, policy: "append-notice" });
    const owner = {};
    const full = appender.append("", "x".repeat(40), 30, owner);
    expect(full.truncated).toBe(true);
    expect(appender.append(full.value, "more", 30, owner)).toEqual({
      value: full.value,
      truncated: true,
    });
  });
});
