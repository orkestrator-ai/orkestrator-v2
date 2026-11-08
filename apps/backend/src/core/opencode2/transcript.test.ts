import { describe, expect, test } from "bun:test";
import { normalizeOpenCode2Message, normalizeOpenCode2Transcript } from "./transcript.js";
import type { OpenCode2Message } from "./types.js";

describe("normalizeOpenCode2Transcript", () => {
  test("user and assistant rows become shared rows; boundaries and unknown kinds are dropped", () => {
    const rows = normalizeOpenCode2Transcript([
      { id: "u1", type: "user", text: "hello", time: { created: 1_700_000_000_000 } },
      {
        id: "a1",
        type: "assistant",
        model: { providerID: "openrouter", id: "anthropic/claude" },
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "reasoning", text: "   " },
          { type: "text", text: "Hi" },
          {
            type: "tool",
            id: "t1",
            name: "shell",
            state: { status: "completed", input: { a: 1 } },
          },
          { type: "tool", id: "t2", name: "edit", state: { status: "running" } },
          { type: "future-kind", text: "?" } as never,
        ],
        time: { created: 1_700_000_000_001 },
      },
      { id: "i1", type: "idle", outcome: "succeeded", time: { created: 2 } } as OpenCode2Message,
      { id: "s1", type: "synthetic", time: { created: 3 } },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "u1",
      role: "user",
      content: "hello",
      parts: [{ type: "text", content: "hello" }],
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(rows[1]).toMatchObject({
      id: "a1",
      role: "assistant",
      content: "Hi",
      modelId: "openrouter/anthropic/claude",
      parts: [
        { type: "thinking", content: "thinking" },
        { type: "text", content: "Hi" },
        { type: "tool-invocation", toolName: "shell", toolArgs: { a: 1 }, toolState: "success" },
        { type: "tool-invocation", toolName: "edit", toolState: "pending" },
      ],
    });
  });

  test("a row without a usable time or content degrades instead of throwing", () => {
    expect(
      normalizeOpenCode2Message({ id: "a", type: "assistant", time: {} } as OpenCode2Message),
    ).toBeNull();
    expect(
      normalizeOpenCode2Message({ id: "u", type: "user", text: "x" } as OpenCode2Message),
    ).toMatchObject({ createdAt: "1970-01-01T00:00:00.000Z" });
  });

  test("oversized tool input is not inlined", () => {
    const [row] = normalizeOpenCode2Transcript([
      {
        id: "a",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "t",
            name: "write",
            state: { status: "running", input: { body: "x".repeat(20_000) } },
          },
        ],
        time: { created: 1 },
      },
    ]);
    expect((row!.parts as Array<Record<string, unknown>>)[0]!.toolArgs).toBeUndefined();
  });
});
