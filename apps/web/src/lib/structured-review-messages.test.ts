import { describe, expect, test } from "bun:test";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import {
  hideRawStructuredReviewMessages,
  showOnlyFinalVerificationMessage,
} from "./structured-review-messages";

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

describe("showOnlyFinalVerificationMessage", () => {
  const checking = JSON.stringify({
    complete: false,
    rationale: "I am inspecting the committed diff.",
  });
  const testing = JSON.stringify({
    complete: false,
    rationale: "The branch is clean; I am running tests now.",
  });
  const final = JSON.stringify({
    complete: true,
    rationale: "All acceptance criteria and validation checks passed.",
  });

  test("keeps only the final verdict after a completed tool-using turn", () => {
    const messages = showOnlyFinalVerificationMessage([{
      id: "verification",
      role: "assistant",
      content: final,
      parts: [
        { type: "text", content: checking },
        {
          type: "tool-invocation",
          content: "bun test",
          toolName: "bash",
          toolState: "success",
        },
        { type: "text", content: testing },
        {
          type: "tool-invocation",
          content: "bun run build",
          toolName: "bash",
          toolState: "success",
        },
        { type: "text", content: final },
      ],
      createdAt: "2026-08-07T22:00:00.000Z",
    }], true);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts.map((part) => part.content)).toEqual([
      "bun test",
      "bun run build",
      final,
    ]);
    // `content` duplicates Codex's last text part and must not create a second
    // copy path if that part is later reshaped by another renderer.
    expect(messages[0]?.content).toBe("");
  });

  test("hides every provisional verdict while the stage is running", () => {
    const messages = showOnlyFinalVerificationMessage([{
      id: "verification",
      role: "assistant",
      content: testing,
      parts: [
        { type: "text", content: checking },
        {
          type: "tool-invocation",
          content: "bun test",
          toolName: "bash",
          toolState: "pending",
        },
        { type: "text", content: testing },
      ],
      createdAt: "2026-08-07T22:00:00.000Z",
    }], false);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.parts.map((part) => part.content)).toEqual(["bun test"]);
  });

  test("keeps a final verdict stored only in message content", () => {
    const messages = showOnlyFinalVerificationMessage([{
      id: "verification",
      role: "assistant",
      content: final,
      parts: [],
      createdAt: "2026-08-07T22:00:00.000Z",
    }], true);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(final);
  });
});
