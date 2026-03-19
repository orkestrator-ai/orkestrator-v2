import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import type { ClaudeMessage as ClaudeMessageType } from "../../../src/lib/claude-client";

mock.module("@/lib/tauri", () => ({
  openInBrowser: async () => {},
  readFileBase64: async () => "",
}));

mock.module("sonner", () => ({
  toast: {
    success: () => {},
    error: () => {},
  },
}));

import { ClaudeMessage } from "../../../src/components/claude/ClaudeMessage";

describe("ClaudeMessage", () => {
  test("renders single newlines as visible line breaks in user text", () => {
    const message: ClaudeMessageType = {
      id: "msg-line-breaks",
      role: "user",
      content: "First line\nSecond line\nThird line",
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "First line\nSecond line\nThird line" },
      ],
    };

    const { container } = render(<ClaudeMessage message={message} />);
    const lineBreaks = container.querySelectorAll("br");

    expect(container.textContent).toContain("First line");
    expect(container.textContent).toContain("Second line");
    expect(container.textContent).toContain("Third line");
    expect(lineBreaks).toHaveLength(2);
  });
});
