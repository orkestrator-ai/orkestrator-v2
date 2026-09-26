import { describe, expect, test } from "bun:test";
import {
  boundTranscriptResponse,
  parseTranscriptFromIndex,
  retainUtf8Tail,
} from "./transcript-window.js";

function message(id: string, parts: unknown[], content = id) {
  return { id, content, parts };
}

function textPart(bytes: number) {
  return { type: "text", content: "x".repeat(bytes) };
}

describe("boundTranscriptResponse", () => {
  test("reports an empty transcript as untruncated", () => {
    const bounded = boundTranscriptResponse([], 1024);
    expect(bounded.messages).toEqual([]);
    expect(bounded.messageWindow).toEqual({ truncated: false });
    expect(bounded.overflowed).toBe(false);
  });

  test("returns a transcript that already fits untouched", () => {
    const messages = [message("a", [textPart(8)]), message("b", [textPart(8)])];
    const bounded = boundTranscriptResponse(messages, 1024 * 1024);
    expect(bounded.messages).toEqual(messages);
    expect(bounded.messageWindow).toEqual({ truncated: false });
    expect(bounded.overflowed).toBe(false);
  });

  test("drops whole messages from the front and keeps the newest", () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      message(`m-${index}`, [textPart(64 * 1024)]),
    );
    const bounded = boundTranscriptResponse(messages, 512 * 1024);

    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(512 * 1024);
    expect(bounded.messages.at(-1)?.id).toBe("m-19");
    expect(bounded.messages[0]?.id).not.toBe("m-0");
    expect(bounded.messageWindow.truncated).toBe(true);
    expect(bounded.messageWindow.omittedMessages).toBe(messages.length - bounded.messages.length);
    expect(bounded.messageWindow.omittedParts).toBeUndefined();
    expect(bounded.overflowed).toBe(false);
  });

  test("trims parts off the front of a single oversized message", () => {
    // One message, far over budget, built from many parts: the only lever left
    // after the message-level loop stops at the final index.
    const parts = Array.from({ length: 40 }, () => textPart(16 * 1024));
    const bounded = boundTranscriptResponse([message("only", parts)], 256 * 1024);

    expect(bounded.messages).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(256 * 1024);
    expect(bounded.messageWindow.truncated).toBe(true);
    expect(bounded.messageWindow.omittedParts).toBeGreaterThan(0);
    expect(bounded.messageWindow.omittedMessages).toBeUndefined();
    expect(bounded.messages[0]!.parts.length).toBe(
      parts.length - bounded.messageWindow.omittedParts!,
    );
    // Trimming is oldest-first, so the newest part always survives.
    expect(bounded.messages[0]!.parts.at(-1)).toEqual(parts.at(-1)!);
    expect(bounded.overflowed).toBe(false);
  });

  test("falls back to the tail of content when no part is left to drop", () => {
    const bounded = boundTranscriptResponse(
      [message("only", [textPart(4 * 1024)], "y".repeat(64 * 1024))],
      8 * 1024,
      { contentFallbackBytes: 1024 },
    );

    expect(bounded.messages[0]!.parts).toEqual([]);
    expect(Buffer.byteLength(bounded.messages[0]!.content)).toBe(1024);
    // The tail is retained, so the very last characters survive.
    expect(bounded.messages[0]!.content.endsWith("yyy")).toBe(true);
    expect(bounded.messageWindow.truncated).toBe(true);
    expect(bounded.overflowed).toBe(false);
  });

  test("marks a lone truncated-content message as truncated even with no parts", () => {
    // `omittedMessages` and `omittedParts` are both zero here, so `truncated`
    // has to come from the content fallback or the caller is told nothing was
    // dropped while looking at a shortened message.
    const bounded = boundTranscriptResponse(
      [message("only", [], "z".repeat(64 * 1024))],
      8 * 1024,
      { contentFallbackBytes: 1024 },
    );

    expect(bounded.messageWindow).toEqual({ truncated: true });
    expect(Buffer.byteLength(bounded.messages[0]!.content)).toBe(1024);
  });

  test("reports overflow instead of cutting content when the fallback is declined", () => {
    const original = message("only", [], "z".repeat(64 * 1024));
    const bounded = boundTranscriptResponse([original], 8 * 1024, {
      contentFallbackBytes: null,
    });

    expect(bounded.overflowed).toBe(true);
    expect(bounded.messages[0]!.content).toBe(original.content);
    expect(bounded.messages[0]!.parts).toEqual([]);
  });

  test("honours a zero envelope reserve for a bare message array", () => {
    const messages = [message("a", [textPart(2048)])];
    const withReserve = boundTranscriptResponse(messages, 4096);
    const withoutReserve = boundTranscriptResponse(messages, 4096, {
      envelopeReserveBytes: 0,
    });
    // The reserve is the only reason the first bound has less room to work in.
    expect(withoutReserve.messages).toEqual(messages);
    expect(withoutReserve.messageWindow.truncated).toBe(false);
    expect(withReserve.messages).toEqual(messages);
  });

  test("trims thousands of small parts without re-measuring the whole message", () => {
    /*
     * The part loop used to recompute `JSON.stringify(message)` after every
     * single shift. With this many parts that is quadratic — thousands of full
     * passes over a multi-megabyte message — and this is exactly the overflow
     * path the byte ceiling exists to handle.
     */
    const parts = Array.from({ length: 20_000 }, () => textPart(512));
    const started = performance.now();
    const bounded = boundTranscriptResponse([message("only", parts)], 2 * 1024 * 1024);
    const elapsedMs = performance.now() - started;

    expect(bounded.messageWindow.omittedParts).toBeGreaterThan(10_000);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(2 * 1024 * 1024);
    // Linear costs a few passes; quadratic costs thousands and blows past this
    // by orders of magnitude on any machine.
    expect(elapsedMs).toBeLessThan(5_000);
  });
});

describe("retainUtf8Tail", () => {
  test("returns the value untouched when it already fits", () => {
    expect(retainUtf8Tail("hello", 64)).toBe("hello");
  });

  test("returns nothing for a non-positive budget", () => {
    expect(retainUtf8Tail("hello", 0)).toBe("");
  });

  test("starts on a code-point boundary rather than mid-sequence", () => {
    // Each emoji is four bytes, so a 10-byte cut lands inside one. Splitting it
    // would decode to U+FFFD, which is three bytes and can exceed the cap the
    // cut was made to satisfy.
    const value = "😀😀😀😀";
    const tail = retainUtf8Tail(value, 10);

    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(10);
    expect(tail).toBe("😀😀");
    expect(tail).not.toContain("�");
  });

  test("keeps the end of the string, not the beginning", () => {
    expect(retainUtf8Tail("abcdefghij", 3)).toBe("hij");
  });
});

describe("parseTranscriptFromIndex", () => {
  const accepted: Array<[string, number]> = [
    ["0", 0],
    ["1", 1],
    ["123", 123],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ];
  test.each(accepted)("accepts canonical %p", (input, expected) => {
    expect(parseTranscriptFromIndex(input)).toBe(expected);
  });

  const rejected: Array<[string, string | null]> = [
    ["missing", null],
    ["empty", ""],
    ["first unsafe integer", "9007199254740992"],
    ["rounded unsafe integer", "9007199254740993"],
    ["numeric prefix with suffix", "12junk"],
    ["fraction", "1.5"],
    ["integral fraction", "1.0"],
    ["trailing dot", "1."],
    ["negative", "-1"],
    ["negative zero", "-0"],
    ["explicit plus", "+1"],
    ["exponent", "1e3"],
    ["hex", "0x10"],
    ["binary", "0b1"],
    ["octal prefix", "0o7"],
    ["numeric separator", "1_000"],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    ["leading space", " 1"],
    ["trailing space", "1 "],
    ["trailing line break", "1\n"],
    ["leading tab", "\t1"],
    ["double zero", "00"],
    ["leading zero", "01"],
    ["seventeen digits", "12345678901234567"],
    ["very long digits", "9".repeat(100_000)],
    ["Arabic-Indic numerals", "\u0661\u0662"],
    ["full-width numerals", "\uff11\uff12"],
    ["superscript digit", "\u00b9"],
  ];
  test.each(rejected)("rejects %s", (_label, input) => {
    expect(parseTranscriptFromIndex(input)).toBeNull();
  });

  test("never partially consumes a malformed value", () => {
    // `parseInt` would return 12 and 1 for these; a cursor that is not wholly
    // valid must fall back to the retained window instead of a guessed index.
    for (const input of ["12junk", "1.5", "7 8", "3,4"]) {
      expect(parseTranscriptFromIndex(input)).toBeNull();
    }
  });

  test("round-trips every value the renderer can emit", () => {
    // The only emitter (`getAcpMessageWindow`) interpolates
    // `Math.max(0, Math.trunc(n))`, which is canonical decimal for every safe n.
    for (const value of [0, 1, 9, 10, 99, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(parseTranscriptFromIndex(String(Math.max(0, Math.trunc(value))))).toBe(value);
    }
  });
});
