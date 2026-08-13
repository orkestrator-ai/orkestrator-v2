import { describe, expect, test } from "bun:test";
import { normalizeNativeAgentMessages } from "./normalization";

describe("native agent message normalization", () => {
  test("normalizes ACP reasoning below the shared tab boundary", () => {
    const [message] = normalizeNativeAgentMessages("cursor", [{
      id: "message-1",
      role: "assistant",
      content: "Done",
      createdAt: "2026-08-13T12:00:00.000Z",
      parts: [
        { type: "reasoning", text: "Checking" },
        { type: "text", text: "Done" },
      ],
    }]);

    expect(message).toMatchObject({
      id: "message-1",
      role: "assistant",
      parts: [
        { type: "tool-group", parts: [{ type: "thinking", content: "Checking" }] },
        { type: "text", content: "Done" },
      ],
    });
  });

  test("normalizes already-native provider messages through the same entry point", () => {
    const source = {
      id: "message-2",
      role: "assistant" as const,
      content: "Hello",
      createdAt: "2026-08-13T12:00:00.000Z",
      parts: [{ type: "text" as const, content: "Hello" }],
    };
    expect(normalizeNativeAgentMessages("codex", [source])[0]).toMatchObject(source);
    expect(normalizeNativeAgentMessages("opencode", [source])[0]).toMatchObject(source);
  });
});

