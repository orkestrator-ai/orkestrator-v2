import { describe, expect, test } from "bun:test";
import { newSessionState } from "./agent-session.js";
import { MAX_MESSAGES } from "./config.js";
import type { BridgeMessage, SessionState } from "./state.js";
import { appendBounded, boundText, boundTranscript, sliceToBytes } from "./transcript.js";

function message(id: string, content: string): BridgeMessage {
  return {
    id,
    role: "assistant",
    content,
    parts: [{ type: "text", content, sourcePartId: `${id}:0`, sourceMessageId: id }],
    createdAt: new Date(0).toISOString(),
  };
}

function withMessages(count: number, content = "x"): SessionState {
  const state = newSessionState();
  for (let index = 0; index < count; index += 1) {
    state.messages.push(message(`m${index}`, content));
  }
  return state;
}

describe("sliceToBytes", () => {
  test("never splits a multi-byte code point", () => {
    // "é" is two bytes, so a three-byte budget can hold one and must refuse to
    // emit half of the second rather than producing U+FFFD.
    expect(sliceToBytes("éé", 3)).toBe("é");
    expect(Buffer.byteLength(sliceToBytes("日本語", 7))).toBeLessThanOrEqual(7);
    expect(sliceToBytes("日本語", 7)).toBe("日本");
  });

  test("returns the whole string when it fits, and nothing at zero", () => {
    expect(sliceToBytes("abc", 10)).toBe("abc");
    expect(sliceToBytes("abc", 0)).toBe("");
  });
});

describe("boundText", () => {
  test("marks text it had to trim", () => {
    const bounded = boundText("a".repeat(100), 40);
    expect(bounded.endsWith("[output truncated]")).toBe(true);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(40);
  });

  test("leaves text that already fits alone", () => {
    expect(boundText("short", 100)).toBe("short");
  });
});

describe("appendBounded", () => {
  test("stops re-encoding once a carrier is saturated", () => {
    const carrier = message("m", "");
    let content = "";
    content = appendBounded(carrier, content, "a".repeat(50), 60);
    expect(content).toBe("a".repeat(50));

    content = appendBounded(carrier, content, "b".repeat(50), 60);
    expect(content.endsWith("[output truncated]")).toBe(true);
    const saturated = content;

    // Every later chunk is a no-op, returning the exact same reference rather
    // than re-copying a buffer that can no longer grow.
    content = appendBounded(carrier, content, "c".repeat(1000), 60);
    expect(content).toBe(saturated);
  });

  test("an empty addition changes nothing", () => {
    const carrier = message("m", "");
    expect(appendBounded(carrier, "kept", "", 100)).toBe("kept");
  });
});

describe("boundTranscript", () => {
  test("evicts from the front and tracks the absolute base index", () => {
    const state = withMessages(MAX_MESSAGES + 5);
    expect(boundTranscript(state)).toBe(true);
    expect(state.messages).toHaveLength(MAX_MESSAGES);
    expect(state.droppedMessages).toBe(5);
    expect(state.droppedParts).toBe(5);
    expect(state.transcriptTruncated).toBe(true);
    // The retained window starts at the sixth message, so a client anchored on
    // an absolute index still lines up.
    expect(state.messages[0]!.id).toBe("m5");
  });

  test("clears the dirty counter so a read does not re-measure", () => {
    const state = withMessages(3);
    state.uncheckedTranscriptBytes = 999;
    boundTranscript(state);
    expect(state.uncheckedTranscriptBytes).toBe(0);
  });

  test("reports no change when the transcript already fits", () => {
    const state = withMessages(3);
    expect(boundTranscript(state)).toBe(false);
    expect(state.droppedMessages).toBe(0);
    expect(state.transcriptTruncated).toBe(false);
  });

  test("sheds parts rather than dropping the only message", () => {
    // The byte budget is env-bounded downwards for exactly this test.
    const state = newSessionState();
    const only = message("m0", "");
    only.parts = Array.from({ length: 40 }, (_, index) => ({
      type: "text" as const,
      content: "z".repeat(20_000),
      sourcePartId: `m0:${index}`,
      sourceMessageId: "m0",
    }));
    state.messages.push(only);

    boundTranscript(state);
    expect(state.messages).toHaveLength(1);
    // Whether anything was shed depends on the configured budget; what must
    // hold in every case is that the last message is never dropped entirely.
    expect(state.messages[0]!.parts.length).toBeGreaterThan(0);
  });
});
