import { describe, expect, test } from "bun:test";
import {
  mergeAcpMessageWindow,
  type AcpMessage,
  type AcpMessageWindow,
} from "./acp-client";

function message(id: string, text: string): AcpMessage {
  return {
    id,
    role: "assistant",
    content: text,
    parts: [{ type: "text", text }],
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function window(
  baseIndex: number,
  messages: AcpMessage[],
  overrides: Partial<AcpMessageWindow> = {},
): AcpMessageWindow {
  return {
    messages,
    baseIndex,
    totalMessages: baseIndex + messages.length,
    revision: 1,
    status: "running",
    ...overrides,
  };
}

describe("mergeAcpMessageWindow", () => {
  test("replaces the mutating tail and keeps the finalized prefix", () => {
    const current = { messages: [message("a", "one"), message("b", "two")], baseIndex: 0 };
    const merged = mergeAcpMessageWindow(
      current,
      window(1, [message("b", "two and a half"), message("c", "three")]),
    );
    expect(merged.baseIndex).toBe(0);
    expect(merged.messages.map((entry) => entry.content))
      .toEqual(["one", "two and a half", "three"]);
  });

  test("takes the window outright when the bridge evicted history the client still held", () => {
    // The transcript bound dropped the client's leading messages, so its own
    // base is stale and the window is the only consistent view.
    const current = { messages: [message("a", "one"), message("b", "two")], baseIndex: 0 };
    const merged = mergeAcpMessageWindow(current, window(0, [message("z", "rebuilt")]));
    expect(merged).toEqual({
      messages: [message("z", "rebuilt")],
      baseIndex: 0,
    });
  });

  test("does not splice a gap when the window starts beyond what the client holds", () => {
    const current = { messages: [message("a", "one")], baseIndex: 0 };
    const merged = mergeAcpMessageWindow(current, window(5, [message("f", "six")]));
    expect(merged).toEqual({ messages: [message("f", "six")], baseIndex: 5 });
  });

  test("appends cleanly when the client is exactly caught up", () => {
    const current = { messages: [message("a", "one")], baseIndex: 3 };
    const merged = mergeAcpMessageWindow(current, window(3, [message("a", "one"), message("b", "two")]));
    expect(merged.baseIndex).toBe(3);
    expect(merged.messages.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  test("handles an empty client transcript", () => {
    const merged = mergeAcpMessageWindow(
      { messages: [], baseIndex: 0 },
      window(0, [message("a", "first")]),
    );
    expect(merged).toEqual({ messages: [message("a", "first")], baseIndex: 0 });
  });
});
