import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { getClaudeSourceMessageId } from "@/lib/chat/native-message-adapters";
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

  test("splits Claude assistant text blocks into separate display rows", () => {
    // Claude is the one platform whose normalizer is not one-message-in,
    // one-message-out; routing it through the shared entry point must keep
    // that fan-out rather than collapsing the transcript.
    const rows = normalizeNativeAgentMessages("claude", [{
      id: "message-3",
      role: "assistant",
      content: "FirstSecond",
      timestamp: "2026-08-13T12:00:00.000Z",
      parts: [
        { type: "text", content: "First", timestamp: "2026-08-13T12:00:00.000Z" },
        {
          type: "tool-invocation",
          toolName: "Bash",
          timestamp: "2026-08-13T12:01:00.000Z",
        },
        // Past the two-minute grouping window, so this becomes its own row.
        { type: "text", content: "Second", timestamp: "2026-08-13T12:05:00.000Z" },
      ],
    }]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id)).toEqual([
      "message-3",
      "message-3:text-block:2",
    ]);
    expect(rows.map((row) => getClaudeSourceMessageId(row.id)))
      .toEqual(["message-3", "message-3"]);
  });

  test("normalizes Grok through the same ACP path as Cursor", () => {
    const source = [{
      id: "message-3",
      role: "assistant" as const,
      content: "Built",
      createdAt: "2026-08-13T12:00:00.000Z",
      parts: [
        { type: "reasoning" as const, text: "Planning" },
        { type: "text" as const, text: "Built" },
      ],
    }];

    expect(normalizeNativeAgentMessages("grok", source))
      .toEqual(normalizeNativeAgentMessages("cursor", source));
  });

  test("returns an empty transcript for every platform", () => {
    for (const platform of AGENT_PLATFORMS) {
      expect(normalizeNativeAgentMessages(platform, [])).toEqual([]);
    }
  });

  test("caches by ACP message identity so re-renders reuse the same object", () => {
    // The tab re-normalizes on every store tick; a fresh object per tick would
    // defeat the memoized message rendering below the shared chat shell.
    const message = {
      id: "message-4",
      role: "assistant" as const,
      content: "Done",
      createdAt: "2026-08-13T12:00:00.000Z",
      parts: [{ type: "text" as const, text: "Done" }],
    };

    expect(normalizeNativeAgentMessages("cursor", [message])[0])
      .toBe(normalizeNativeAgentMessages("cursor", [message])[0]);
  });
});

