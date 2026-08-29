import { describe, expect, test } from "bun:test";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import {
  hideMachineOutputText,
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
    const messages = showOnlyFinalStructuredReviewMessage(
      [
        {
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
        },
      ],
      true,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.parts.map((part) => part.content)).toEqual(["git diff --stat", final]);
  });

  test("hides every report until the backend accepts one", () => {
    const report = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    expect(
      showOnlyFinalStructuredReviewMessage(
        [
          {
            id: "review",
            role: "assistant",
            content: report,
            parts: [{ type: "text", content: report }],
            createdAt: "2026-08-07T22:00:00.000Z",
          },
        ],
        false,
      ),
    ).toEqual([]);
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
    const messages = showOnlyFinalStructuredReviewMessage(
      [
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
      ],
      true,
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe("review-2");
    expect(messages[0]?.parts.map((part) => part.content)).toEqual(["More investigation"]);
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
    const messages = showOnlyFinalVerificationMessage(
      [
        {
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
        },
      ],
      true,
    );

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
    const messages = showOnlyFinalVerificationMessage(
      [
        {
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
        },
      ],
      false,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.parts.map((part) => part.content)).toEqual(["bun test"]);
  });

  test("keeps a final verdict stored only in message content", () => {
    const messages = showOnlyFinalVerificationMessage(
      [
        {
          id: "verification",
          role: "assistant",
          content: final,
          parts: [],
          createdAt: "2026-08-07T22:00:00.000Z",
        },
      ],
      true,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(final);
  });

  test("extracts only the accepted final verdict from concatenated progress JSON", () => {
    const concatenated = `${checking}${testing}${final}`;
    const messages = showOnlyFinalVerificationMessage(
      [
        {
          id: "verification",
          role: "assistant",
          content: concatenated,
          parts: [
            { type: "text", content: "Running the full validation suite." },
            { type: "text", content: concatenated },
          ],
          createdAt: "2026-08-07T22:00:00.000Z",
        },
      ],
      true,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.parts.map((part) => part.content)).toEqual([
      "Running the full validation suite.",
      final,
    ]);
  });

  test("rebuilds mixed fallback content when an accepted sequence is replaced", () => {
    const prose = "Running the full validation suite.";
    const concatenated = `${checking}${testing}${final}`;
    const messages = showOnlyFinalVerificationMessage(
      [
        {
          id: "verification",
          role: "assistant",
          content: `${prose}${concatenated}`,
          parts: [
            { type: "text", content: prose },
            { type: "text", content: concatenated },
          ],
          createdAt: "2026-08-07T22:00:00.000Z",
        },
      ],
      true,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(`${prose}${final}`);
    expect(messages[0]?.parts.map((part) => part.content)).toEqual([prose, final]);
    expect(JSON.stringify(messages)).not.toContain("I am inspecting the committed diff.");
    expect(JSON.stringify(messages)).not.toContain("The branch is clean");
  });

  test("hides concatenated provisional verdicts while preserving prose updates", () => {
    const messages = hideMachineOutputText(
      showOnlyFinalVerificationMessage(
        [
          {
            id: "verification",
            role: "assistant",
            content: `${checking}${testing}`,
            parts: [
              { type: "text", content: "The full suite is still running." },
              { type: "text", content: `${checking}${testing}` },
            ],
            createdAt: "2026-08-07T22:00:00.000Z",
          },
        ],
        false,
      ),
      { retainPayloadKind: "verification" },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.parts.map((part) => part.content)).toEqual([
      "The full suite is still running.",
    ]);
  });
});

describe("hideMachineOutputText", () => {
  test("withholds a streaming JSON draft while keeping prose and tool rows", () => {
    // The exact shape a reviewer streams while composing its report: a JSON
    // document that has not closed yet, so nothing can validate or fold it.
    const draft = '{"reviewScope":{"targetBranch":"main","filesReviewed":["a.ts"';
    const messages = hideMachineOutputText([
      {
        id: "progress",
        role: "assistant",
        content: draft,
        parts: [
          { type: "text", content: "Reviewing the uncommitted changes." },
          {
            type: "tool-invocation",
            content: "git diff HEAD",
            toolName: "shell",
            toolState: "success",
          },
          { type: "text", content: draft },
        ],
        createdAt: "2026-08-17T13:00:00.000Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.parts.map((part) => part.content)).toEqual([
      "Reviewing the uncommitted changes.",
      "git diff HEAD",
    ]);
  });

  test("withholds a finished JSON document that validates as nothing", () => {
    const provisional = '{"reviewScope":{"targetBranch":"main"},"issues":[]}';
    expect(
      hideMachineOutputText([
        {
          id: "draft",
          role: "assistant",
          content: provisional,
          parts: [{ type: "text", content: provisional }],
          createdAt: "2026-08-17T13:00:00.000Z",
        },
      ]),
    ).toHaveLength(0);
  });

  test("keeps prose that merely contains or follows JSON", () => {
    const commentary = 'The config `{"strict":true}` is already covered by tests.';
    const messages = hideMachineOutputText([
      {
        id: "prose",
        role: "assistant",
        content: commentary,
        parts: [{ type: "text", content: commentary }],
        createdAt: "2026-08-17T13:00:00.000Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts.map((part) => part.content)).toEqual([commentary]);
  });

  test("removes machine output from concatenated fallback content", () => {
    const prose = "The full suite is still running.";
    const draft = '{"complete":false,"rationale":"Still running"';
    const messages = hideMachineOutputText([
      {
        id: "mixed",
        role: "assistant",
        content: `${prose}${draft}`,
        parts: [
          { type: "text", content: prose },
          { type: "text", content: draft },
        ],
        createdAt: "2026-08-17T13:00:00.000Z",
      },
    ]);

    expect(messages[0]?.content).toBe(prose);
    expect(messages[0]?.parts.map((part) => part.content)).toEqual([prose]);
  });

  test("never withholds the user's own text", () => {
    const prompt = '{"instruction":"review this"}';
    const messages = hideMachineOutputText([
      {
        id: "prompt",
        role: "user",
        content: prompt,
        parts: [{ type: "text", content: prompt }],
        createdAt: "2026-08-17T13:00:00.000Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(prompt);
  });

  test("returns the identical message when nothing is withheld", () => {
    const message = {
      id: "prose",
      role: "assistant" as const,
      content: "Validation complete.",
      parts: [{ type: "text" as const, content: "Validation complete." }],
      createdAt: "2026-08-17T13:00:00.000Z",
    };
    // Identity matters: the renderer memoizes on the message object.
    expect(hideMachineOutputText([message])[0]).toBe(message);
  });

  test("keeps a message whose only survivor is a reasoning part", () => {
    // Withholding the text must not take the whole row with it: the thinking
    // trace beside it is still the evidence that the reviewer is working.
    const draft = '{"issues":[{"title":"partial"';
    const messages = hideMachineOutputText([
      {
        id: "thinking",
        role: "assistant",
        content: draft,
        parts: [
          { type: "thinking", content: "Weighing whether this is a real bug." },
          { type: "text", content: draft },
        ],
        createdAt: "2026-08-17T13:00:00.000Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.parts.map((part) => part.type)).toEqual(["thinking"]);
  });

  test("retains the payload kind a preceding filter deliberately kept", () => {
    const accepted = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    const draft = '{"reviewScope":{"targetBranch":"main"},"issues":[]}';
    const messages = hideMachineOutputText(
      [
        {
          id: "draft",
          role: "assistant",
          content: draft,
          parts: [{ type: "text", content: draft }],
          createdAt: "2026-08-17T13:00:00.000Z",
        },
        {
          id: "accepted",
          role: "assistant",
          content: accepted,
          parts: [{ type: "text", content: accepted }],
          createdAt: "2026-08-17T13:01:00.000Z",
        },
      ],
      { retainPayloadKind: "structured-review" },
    );

    // The draft validates as nothing, so no filter owns it and it is withheld.
    // The accepted report is a structured-review payload that the preceding
    // `showOnlyFinalStructuredReviewMessage(…, true)` pass kept on purpose.
    expect(messages.map((message) => message.id)).toEqual(["accepted"]);
    expect(messages[0]?.content).toBe(accepted);
  });

  test("withholds a retained kind's payload when no filter claimed it", () => {
    const accepted = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    // Without the option — the Multi Review viewer, which passes showFinal
    // false, so nothing of that kind was meant to survive.
    expect(
      hideMachineOutputText([
        {
          id: "accepted",
          role: "assistant",
          content: accepted,
          parts: [{ type: "text", content: accepted }],
          createdAt: "2026-08-17T13:01:00.000Z",
        },
      ]),
    ).toHaveLength(0);
  });
});
