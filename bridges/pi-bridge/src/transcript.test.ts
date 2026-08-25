/**
 * The transcript bounds.
 *
 * Every one of these is a memory bound on a long-running process, so what is
 * being pinned is not "text gets shorter" but that saturation is recorded,
 * eviction counts what it evicted, and a cut never lands inside a UTF-8
 * sequence.
 */
import { describe, expect, test } from "bun:test";
import { newSessionState } from "./agent-session.js";
import { MAX_MESSAGES, MAX_PARTS_PER_MESSAGE } from "./config.js";
import {
  appendBounded,
  boundText,
  boundTranscript,
  boundTranscriptForRead,
  chargeTranscript,
  sliceToBytes,
} from "./transcript.js";
import type { BridgeMessage, BridgeMessagePart, SessionState } from "./state.js";

function message(id: string, parts: BridgeMessagePart[] = []): BridgeMessage {
  return { id, role: "assistant", content: "", parts, createdAt: "2026-01-01T00:00:00Z" };
}

function textPart(content: string): BridgeMessagePart {
  return { type: "text", content } as BridgeMessagePart;
}

function seed(messages: BridgeMessage[]): SessionState {
  const state = newSessionState();
  state.messages = messages;
  return state;
}

describe("sliceToBytes", () => {
  test("returns the whole string when it already fits", () => {
    expect(sliceToBytes("hello", 10)).toBe("hello");
    expect(sliceToBytes("hello", 5)).toBe("hello");
  });

  test("returns nothing for a non-positive budget", () => {
    expect(sliceToBytes("hello", 0)).toBe("");
    expect(sliceToBytes("hello", -1)).toBe("");
  });

  test("never cuts inside a multi-byte code point", () => {
    // "é" is two bytes, so a three-byte budget has room for one and a half.
    // Half a code point decodes as U+FFFD, which is worse than one fewer.
    expect(sliceToBytes("éé", 3)).toBe("é");
    expect(sliceToBytes("éé", 4)).toBe("éé");
    // Four-byte emoji, cut at every offset inside it.
    for (const limit of [1, 2, 3]) {
      expect(sliceToBytes("🙂", limit)).toBe("");
    }
    expect(sliceToBytes("🙂", 4)).toBe("🙂");
    expect(sliceToBytes("a🙂", 5)).toBe("a🙂");
    expect(sliceToBytes("a🙂", 4)).toBe("a");
  });
});

describe("boundText", () => {
  test("leaves a string inside its budget alone", () => {
    expect(boundText("hello", 100)).toBe("hello");
  });

  test("marks a string it trimmed", () => {
    const bounded = boundText("x".repeat(500), 100);
    expect(bounded.endsWith("[output truncated]")).toBe(true);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(100);
  });

  test("still marks a budget too small for any content", () => {
    expect(boundText("x".repeat(50), 5)).toBe("\n\n[output truncated]");
  });
});

describe("appendBounded", () => {
  test("appends while there is room", () => {
    const part = textPart("");
    expect(appendBounded(part, "a", "b", 100)).toBe("ab");
  });

  test("ignores an empty addition", () => {
    const part = textPart("");
    expect(appendBounded(part, "abc", "", 100)).toBe("abc");
  });

  test("truncates once and then refuses further appends to the same carrier", () => {
    const part = textPart("");
    const first = appendBounded(part, "", "x".repeat(200), 64);
    expect(first.endsWith("[output truncated]")).toBe(true);

    // Saturation is recorded on the carrier, so the rest of a streaming turn
    // costs a lookup rather than a re-encode of the whole part.
    expect(appendBounded(part, first, "more text", 64)).toBe(first);
  });

  test("marks a carrier that was already at its budget without doubling the notice", () => {
    const part = textPart("");
    const full = "y".repeat(64);
    const bounded = appendBounded(part, full, "more", 64);
    expect(bounded).toBe(`${full}\n\n[output truncated]`);
  });
});

describe("boundTranscript", () => {
  test("reports no change for a transcript already inside every bound", () => {
    const state = seed([message("m1", [textPart("hi")])]);
    expect(boundTranscript(state)).toBe(false);
    expect(state.transcriptTruncated).toBe(false);
    expect(state.droppedMessages).toBe(0);
  });

  test("evicts oldest messages and counts what it dropped", () => {
    const messages = Array.from({ length: MAX_MESSAGES + 5 }, (_, index) =>
      message(`m${index}`, [textPart("x")]),
    );
    const state = seed(messages);

    expect(boundTranscript(state)).toBe(true);
    expect(state.messages).toHaveLength(MAX_MESSAGES);
    // Counted, because `baseIndex` is what anchors an incremental read: an
    // eviction that did not count itself would shift the window silently.
    expect(state.droppedMessages).toBe(5);
    expect(state.droppedParts).toBe(5);
    expect(state.transcriptTruncated).toBe(true);
    expect(state.messages[0]!.id).toBe("m5");
  });

  test("sheds a single message's parts from the front", () => {
    const parts = Array.from({ length: MAX_PARTS_PER_MESSAGE + 3 }, (_, index) =>
      textPart(`part-${index}`),
    );
    const state = seed([message("m1", parts)]);

    expect(boundTranscript(state)).toBe(true);
    expect(state.messages[0]!.parts).toHaveLength(MAX_PARTS_PER_MESSAGE);
    expect(state.droppedParts).toBe(3);
    // The newest output is what the user is watching, so the front goes.
    expect((state.messages[0]!.parts[0] as { content: string }).content).toBe("part-3");
  });

  test("keeps at least one message however large it is", () => {
    // A single turn can exceed the whole budget on its own; dropping it would
    // leave the tab with nothing at all.
    const state = seed([message("m1", [textPart("x".repeat(40 * 1024 * 1024))])]);
    boundTranscript(state);
    expect(state.messages).toHaveLength(1);
  });

  test("clears the dirty counter so a second pass is free", () => {
    const state = seed([message("m1", [textPart("hi")])]);
    chargeTranscript(state, 1_000);
    expect(state.uncheckedTranscriptBytes).toBe(1_000);
    boundTranscript(state);
    expect(state.uncheckedTranscriptBytes).toBe(0);
  });
});

describe("boundTranscriptForRead", () => {
  test("does nothing when nothing was appended since the last pass", () => {
    const state = seed(
      Array.from({ length: MAX_MESSAGES + 2 }, (_, index) => message(`m${index}`)),
    );
    state.uncheckedTranscriptBytes = 0;

    // Deliberately skipped: an unconditional bound would make every poll of a
    // large idle session serialize the whole transcript.
    boundTranscriptForRead(state);
    expect(state.messages).toHaveLength(MAX_MESSAGES + 2);
  });

  test("bounds and bumps the revision once something was charged", () => {
    const state = seed(
      Array.from({ length: MAX_MESSAGES + 2 }, (_, index) => message(`m${index}`)),
    );
    const before = state.revision;
    chargeTranscript(state, 10);

    boundTranscriptForRead(state);
    expect(state.messages).toHaveLength(MAX_MESSAGES);
    expect(state.revision).toBe(before + 1);
  });

  test("ignores a non-positive charge", () => {
    const state = seed([message("m1")]);
    chargeTranscript(state, 0);
    chargeTranscript(state, -5);
    expect(state.uncheckedTranscriptBytes).toBe(0);
  });
});
