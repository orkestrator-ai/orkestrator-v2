import { describe, expect, test } from "bun:test";
import {
  getNativeMessageSearchText,
  markdownToAgentSearchText,
} from "./native-message-search";
import type { NativeMessage } from "@/lib/chat/native-message-types";

describe("markdownToAgentSearchText", () => {
  test("returns the visible text across fragmented inline Markdown", () => {
    expect(
      markdownToAgentSearchText(
        "# Heading\n\nA **bold** [link](https://example.com) and `code`.",
      ),
    ).toBe("Heading\nA bold link and code.");
  });

  test("keeps block, list, quote, and table text while omitting hidden sources", () => {
    const text = markdownToAgentSearchText(
      [
        "> quoted",
        "",
        "- one",
        "- two",
        "",
        "| A | B |",
        "| - | - |",
        "| C | D |",
        "",
        "![hidden alt](image.png)",
        "<button>raw html</button>",
      ].join("\n"),
    );

    expect(text).toContain("quoted");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("A\tB");
    expect(text).toContain("C\tD");
    expect(text).not.toContain("hidden alt");
  });
});

describe("getNativeMessageSearchText", () => {
  test("searches only rendered text parts and strips their Markdown", () => {
    const message: NativeMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "provider aggregate",
      createdAt: "2025-01-01T00:00:00.000Z",
      parts: [
        { type: "thinking", content: "private thought" },
        { type: "text", content: "First **visible** part" },
        { type: "tool-invocation", content: "tool metadata" },
        { type: "text", content: "Second [part](https://example.com)" },
      ],
    };

    expect(getNativeMessageSearchText(message)).toBe(
      "First visible part\n\nSecond part",
    );
  });

  test("uses raw content for system, error, and legacy messages", () => {
    const base: NativeMessage = {
      id: "legacy-1",
      role: "assistant",
      content: "legacy content",
      createdAt: "2025-01-01T00:00:00.000Z",
      parts: [],
    };
    expect(getNativeMessageSearchText(base)).toBe("legacy content");
    expect(getNativeMessageSearchText({
      ...base,
      id: "system-1",
      role: "system",
      content: "system content",
      parts: [{ type: "text", content: "**different**" }],
    })).toBe("system content");
    expect(getNativeMessageSearchText({
      ...base,
      id: "error-1",
      content: "error content",
      parts: [{ type: "text", content: "**different**" }],
    })).toBe("error content");
  });
});
