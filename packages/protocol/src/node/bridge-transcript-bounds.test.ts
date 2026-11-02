import { describe, expect, test } from "bun:test";
import {
  createBridgeTranscriptBounds,
  type BridgeTranscriptState,
} from "./bridge-transcript-bounds";
import { StaleTranscriptSizeError } from "./transcript-budget";

interface Row {
  id: string;
  content: string;
  parts: Array<{ id: string; text: string }>;
}

interface State extends BridgeTranscriptState {
  messages: Row[];
}

function row(id: string, parts: number, size = 100): Row {
  return {
    id,
    content: "",
    parts: Array.from({ length: parts }, (_, index) => ({
      id: `${id}:${index}`,
      text: "x".repeat(size),
    })),
  };
}

function state(messages: Row[]): State {
  return {
    messages,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    uncheckedTranscriptBytes: 0,
    revision: 0,
  };
}

const LIMITS = {
  maxMessages: 10,
  maxPartsPerMessage: 4,
  maxTranscriptBytes: 2_000,
  streamIntervalBytes: 500,
};

describe("createBridgeTranscriptBounds", () => {
  test("bounds the transcript and notes retained rows that shed parts", () => {
    const bounds = createBridgeTranscriptBounds<State>(LIMITS);
    const session = state([row("a", 2), row("b", 6), row("c", 1)]);
    expect(bounds.boundTranscript(session)).toBe(true);
    // `b` lost two parts to the per-message cap and is no longer the newest.
    expect(session.messages.map((message) => message.parts.length)).toEqual([2, 4, 1]);
    expect(bounds.revisedRowIds(session)).toEqual(["b"]);
    expect(session.droppedParts).toBe(2);
  });

  test("a noted change to an older row is measured again", () => {
    const bounds = createBridgeTranscriptBounds<State>(LIMITS);
    const session = state([row("a", 1), row("b", 1)]);
    bounds.boundTranscript(session);
    // Grow the older row and note it; the bound must see the new size and
    // shed the front row rather than reuse the old measurement.
    session.messages[0]!.parts.push(...row("a2", 3, 700).parts);
    bounds.rowChanged(session, session.messages[0]!);
    expect(bounds.revisedRowIds(session)).toEqual(["a"]);
    session.uncheckedTranscriptBytes = 1;
    bounds.boundTranscriptForRead(session);
    expect(session.messages.map((message) => message.id)).toEqual(["b"]);
    expect(session.revision).toBe(2);
  });

  test("the newest row is never noted for readers, but is always measured", () => {
    const bounds = createBridgeTranscriptBounds<State>(LIMITS);
    const session = state([row("a", 1)]);
    bounds.noteRowRevised(session, "a");
    expect(bounds.revisedRowIds(session)).toBeUndefined();
  });

  test("a read with nothing charged does not measure", () => {
    const bounds = createBridgeTranscriptBounds<State>(LIMITS);
    const session = state([row("a", 1), row("b", 30)]);
    bounds.boundTranscriptForRead(session);
    expect(session.messages[1]!.parts).toHaveLength(30);
    bounds.chargeTranscript(session, 0);
    bounds.boundTranscriptForRead(session);
    expect(session.messages[1]!.parts).toHaveLength(30);
    bounds.chargeTranscript(session, 1);
    bounds.boundTranscriptForRead(session);
    expect(session.messages[1]!.parts).toHaveLength(4);
  });

  test("streamingBoundDue follows the structural limits and the charge interval", () => {
    const bounds = createBridgeTranscriptBounds<State>(LIMITS);
    const session = state([row("a", 4)]);
    expect(bounds.streamingBoundDue(session)).toBe(false);
    session.messages[0]!.parts.push(...row("x", 1).parts);
    expect(bounds.streamingBoundDue(session)).toBe(true);
    session.messages[0]!.parts.pop();
    bounds.chargeTranscript(session, 499);
    expect(bounds.streamingBoundDue(session)).toBe(false);
    bounds.chargeTranscript(session, 1);
    expect(bounds.streamingBoundDue(session)).toBe(true);
  });

  test("an older row changed without a note is caught under bun test", () => {
    const bounds = createBridgeTranscriptBounds<State>(LIMITS);
    const session = state([row("a", 1), row("b", 1)]);
    bounds.boundTranscript(session);
    session.messages[0]!.content = "silently changed";
    expect(() => bounds.boundTranscript(session)).toThrow(StaleTranscriptSizeError);
  });

  test("forgetRowSize and forgetRevisedRows make the next bound measure again", () => {
    const bounds = createBridgeTranscriptBounds<State>(LIMITS);
    const session = state([row("a", 1), row("b", 1)]);
    bounds.boundTranscript(session);
    session.messages[0]!.content = "rebuilt";
    bounds.forgetRowSize(session, session.messages[0]!);
    expect(bounds.revisedRowIds(session)).toBeUndefined();
    expect(() => bounds.boundTranscript(session)).not.toThrow();

    bounds.noteRowRevised(session, "a");
    session.messages[0]!.content = "replaced history";
    bounds.forgetRevisedRows(session);
    expect(bounds.revisedRowIds(session)).toBeUndefined();
    expect(() => bounds.boundTranscript(session)).not.toThrow();
  });
});
