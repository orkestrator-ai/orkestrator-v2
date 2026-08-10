import { describe, expect, test } from "bun:test";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import {
  showOnlyFinalStructuredReviewMessage,
  showOnlyFinalVerificationMessage,
} from "./structured-review-messages";

describe("showOnlyFinalStructuredReviewMessage", () => {
  test("keeps only an accepted historical review's final report", () => {
    const provisional = JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      verdict: { ready: "no", reasoning: "Review is still running." },
    });
    const final = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    const messages = showOnlyFinalStructuredReviewMessage([{
      id: "review",
      role: "assistant",
      content: final,
      parts: [
        { type: "text", content: provisional },
        {
          type: "tool-invocation",
          content: "git diff --stat",
          toolName: "shell",
          toolState: "success",
        },
        { type: "text", content: final },
      ],
      createdAt: "2026-08-07T22:00:00.000Z",
    }], true);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.parts.map((part) => part.content)).toEqual([
      "git diff --stat",
      final,
    ]);
  });

  test("hides every report until the backend accepts one", () => {
    const report = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    expect(showOnlyFinalStructuredReviewMessage([{
      id: "review",
      role: "assistant",
      content: report,
      parts: [{ type: "text", content: report }],
      createdAt: "2026-08-07T22:00:00.000Z",
    }], false)).toEqual([]);
  });

  test("keeps only the final report across multiple assistant messages", () => {
    const first = JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      verdict: { ready: "no", reasoning: "First pass." },
    });
    const second = JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      verdict: { ready: "no", reasoning: "Second pass after tooling." },
    });
    const final = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    const messages = showOnlyFinalStructuredReviewMessage([
      {
        id: "review-1",
        role: "assistant",
        content: "",
        parts: [{ type: "text", content: first }],
        createdAt: "2026-08-07T21:00:00.000Z",
      },
      {
        id: "review-2",
        role: "assistant",
        content: "",
        parts: [
          { type: "text", content: second },
          { type: "text", content: "More investigation" },
        ],
        createdAt: "2026-08-07T22:00:00.000Z",
      },
      {
        id: "review-3",
        role: "assistant",
        content: final,
        parts: [{ type: "text", content: final }],
        createdAt: "2026-08-07T23:00:00.000Z",
      },
    ], true);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe("review-2");
    expect(messages[0]?.parts.map((part) => part.content)).toEqual([
      "More investigation",
    ]);
    expect(messages[1]?.id).toBe("review-3");
    expect(messages[1]?.content).toBe("");
    expect(messages[1]?.parts.map((part) => part.content)).toEqual([final]);
    expect(JSON.stringify(messages)).not.toContain("First pass.");
    expect(JSON.stringify(messages)).not.toContain("Second pass.");
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
