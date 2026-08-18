import { describe, expect, spyOn, test } from "bun:test";
import { marked } from "marked";
import { getNativeMessageSearchText, markdownToAgentSearchText } from "./native-message-search";
import type { NativeMessage } from "@/lib/chat/native-message-types";

describe("markdownToAgentSearchText", () => {
  test("returns the visible text across fragmented inline Markdown", () => {
    expect(
      markdownToAgentSearchText("# Heading\n\nA **bold** [link](https://example.com) and `code`."),
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

    expect(getNativeMessageSearchText(message)).toBe("First visible part\n\nSecond part");
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
    expect(
      getNativeMessageSearchText({
        ...base,
        id: "system-1",
        role: "system",
        content: "system content",
        parts: [{ type: "text", content: "**different**" }],
      }),
    ).toBe("system content");
    expect(
      getNativeMessageSearchText({
        ...base,
        id: "error-1",
        content: "error content",
        parts: [{ type: "text", content: "**different**" }],
      }),
    ).toBe("error content");
  });

  test("falls back to the original source when Markdown parsing throws", () => {
    const failingParser = (() => {
      throw new Error("parser extension failed");
    }) as unknown as typeof marked;
    const parseSpy = spyOn(marked, "parse").mockImplementationOnce(failingParser);
    try {
      expect(markdownToAgentSearchText("source **text**")).toBe("source **text**");
    } finally {
      parseSpy.mockRestore();
    }
  });
});

describe("getNativeMessageSearchText for folded JSON payloads", () => {
  const base: NativeMessage = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    createdAt: "2025-01-01T00:00:00.000Z",
    parts: [],
  };

  test("indexes a folded verdict by its collapsed row, not its source", () => {
    // NativeMessage folds this into a closed disclosure, which unmounts
    // everything below its trigger. Indexing the raw document would report
    // matches that find can count but can never highlight.
    const text = getNativeMessageSearchText({
      ...base,
      parts: [
        {
          type: "text",
          content: '{"complete":true,"rationale":"Tree clean."}',
        },
      ],
    });

    expect(text).toBe("Verification passedTree clean.");
    expect(text).not.toContain('"rationale"');
  });

  test("indexes a folded generic payload by its title and count", () => {
    expect(
      getNativeMessageSearchText({
        ...base,
        parts: [{ type: "text", content: '{"stageName":"verify"}' }],
      }),
    ).toBe("JSON payload1 field");
  });

  test("leaves an unfolded fenced block fully indexed", () => {
    // A fenced block of unrecognized JSON stays a code block, so every
    // character of it is still mounted and still findable.
    const text = getNativeMessageSearchText({
      ...base,
      parts: [
        {
          type: "text",
          content: '```json\n{"compilerOptions":{"strict":true}}\n```',
        },
      ],
    });

    expect(text).toContain("compilerOptions");
  });

  test("indexes a user's own JSON as written, because it is shown as written", () => {
    const text = getNativeMessageSearchText({
      ...base,
      id: "user-1",
      role: "user",
      parts: [
        {
          type: "text",
          content: '{"complete":true,"rationale":"Tree clean."}',
        },
      ],
    });

    expect(text).toContain('"rationale"');
  });

  test("folds a JSON-only legacy message that has no text parts", () => {
    expect(
      getNativeMessageSearchText({
        ...base,
        content: '{"complete":false,"rationale":"Unmet."}',
      }),
    ).toBe("Verification failedUnmet.");
  });

  test("keeps legacy user JSON from message.content indexed as written", () => {
    expect(
      getNativeMessageSearchText({
        ...base,
        id: "user-legacy",
        role: "user",
        content: '{"complete":true,"rationale":"Keep raw."}',
      }),
    ).toContain('"rationale"');
  });

  test("keeps a prose sibling part indexed alongside a folded one", () => {
    // The folded part contributes only its collapsed row, so the prose part's
    // occurrences keep the ordinals the DOM will actually produce for them.
    const text = getNativeMessageSearchText({
      ...base,
      parts: [
        { type: "text", content: '{"verify":"verify"}' },
        { type: "text", content: "Then verify the branch." },
      ],
    });

    expect(text.match(/verify/g) ?? []).toHaveLength(1);
    expect(text).toContain("Then verify the branch.");
  });
});
