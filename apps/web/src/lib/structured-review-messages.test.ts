import { describe, expect, test } from "bun:test";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import { hideRawStructuredReviewMessages } from "./structured-review-messages";

describe("hideRawStructuredReviewMessages", () => {
  test("hides validated raw report JSON while preserving tools and ordinary text", () => {
    const raw = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    const messages = hideRawStructuredReviewMessages([
      {
        id: "structured",
        role: "assistant",
        content: raw,
        parts: [{ type: "text", content: raw }],
        createdAt: "2026-07-25T00:00:00.000Z",
      },
      {
        id: "ordinary",
        role: "assistant",
        content: "Reviewing the diff",
        parts: [
          { type: "thinking", content: "Checking retries" },
          { type: "text", content: "Reviewing the diff" },
        ],
        createdAt: "2026-07-25T00:00:01.000Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("ordinary");
    expect(messages[0]?.parts).toHaveLength(2);
  });

  test("does not hide malformed or merely JSON-looking plaintext", () => {
    const messages = hideRawStructuredReviewMessages([{
      id: "incomplete",
      role: "assistant",
      content: "{\"reviewSummary\":\"not a complete report\"}",
      parts: [{
        type: "text",
        content: "{\"reviewSummary\":\"not a complete report\"}",
      }],
      createdAt: "2026-07-25T00:00:00.000Z",
    }]);

    expect(messages).toHaveLength(1);
  });
});
