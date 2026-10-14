import { describe, expect, test } from "bun:test";

import {
  LAST_ASSISTANT_TEXT_READ_LIMIT,
  lastAssistantText,
  missingWorkflowResultMessage,
  workflowResultReminderPrompt,
} from "./workflow-result-missing.js";

const BASE = {
  subject: "The consolidation model",
  resultLabel: "consolidated report",
  toolName: "submit_consolidated_review",
};

describe("missingWorkflowResultMessage", () => {
  test("names a result pasted as JSON text instead of submitted", () => {
    expect(
      missingWorkflowResultMessage({
        ...BASE,
        submission: "preparing",
        finalText: '```json\n{"reviewScope":{"targetBranch":"main"}}\n```',
      }),
    ).toBe(
      "The consolidation model replied with its consolidated report as text instead of calling submit_consolidated_review",
    );
  });

  test("names a turn that never called its submit tool", () => {
    expect(
      missingWorkflowResultMessage({ ...BASE, submission: "preparing", finalText: "Done." }),
    ).toBe(
      "The consolidation model finished without calling submit_consolidated_review to submit its consolidated report",
    );
    expect(missingWorkflowResultMessage({ ...BASE, submission: undefined })).toContain(
      "finished without calling submit_consolidated_review",
    );
  });

  test("names a submission that was rejected and never corrected", () => {
    expect(
      missingWorkflowResultMessage({ ...BASE, submission: "correcting", finalText: "{}" }),
    ).toBe(
      "The consolidation model stopped before submit_consolidated_review accepted its consolidated report; its last submission was rejected",
    );
  });
});

describe("workflowResultReminderPrompt", () => {
  const REMINDER = { resultLabel: "structured report", toolName: "submit_review_report" };

  test("tells a model that blamed the tool that its arguments were malformed", () => {
    const prompt = workflowResultReminderPrompt({ ...REMINDER, submission: "preparing" });
    expect(prompt).toContain("No call to `submit_review_report` was accepted.");
    expect(prompt).toContain("do not repeat it");
    expect(prompt).toContain("The result tools are working.");
    expect(prompt).toContain("Failed to parse arguments string as JSON object");
    expect(prompt).toContain("one extra `}`");
    expect(prompt).toContain("Never shorten the report");
    expect(prompt).toContain("never call a tool named `invalid`");
    expect(prompt).toContain("The earlier resultKey is closed.");
  });

  test("names a report pasted as reply text", () => {
    expect(
      workflowResultReminderPrompt({ ...REMINDER, submission: "preparing", finalText: '{"a":1}' }),
    ).toContain("You wrote the structured report as reply text.");
  });

  test("names a rejected submission ahead of pasted text", () => {
    expect(
      workflowResultReminderPrompt({ ...REMINDER, submission: "correcting", finalText: "{}" }),
    ).toContain("Your last submission was rejected.");
  });

  test("fits the durable continuation-prompt bound", () => {
    for (const submission of ["preparing", "correcting", undefined] as const) {
      const prompt = workflowResultReminderPrompt({ ...REMINDER, submission, finalText: "{}" });
      expect(prompt.length).toBeLessThan(4_096);
    }
  });
});

describe("lastAssistantText", () => {
  test("detects pasted JSON in the raw OpenCode provider envelope", () => {
    const messages = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "earlier" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: '```json\n{"issues":[' },
          { type: "tool", tool: "invalid", state: { error: "JSON Parse error" } },
          null,
          { type: "text", text: 42 },
          { type: "text", text: "]}\n```" },
        ],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ];
    const finalText = lastAssistantText(messages);
    expect(finalText).toBe('```json\n{"issues":[\n]}\n```');
    expect(missingWorkflowResultMessage({ ...BASE, submission: "preparing", finalText })).toContain(
      "as text instead of calling submit_consolidated_review",
    );
    expect(
      workflowResultReminderPrompt({
        resultLabel: "structured report",
        toolName: "submit_review_report",
        submission: "preparing",
        finalText,
      }),
    ).toContain("You wrote the structured report as reply text.");
  });

  test("joins the text parts of the last assistant message", () => {
    expect(
      lastAssistantText([
        { role: "assistant", parts: [{ type: "text", content: "earlier" }] },
        { role: "user", parts: [{ type: "text", content: "prompt" }] },
        {
          role: "assistant",
          parts: [
            { type: "text", content: "{" },
            { type: "tool-invocation", toolName: "bash" },
            { type: "text", content: "}" },
          ],
        },
      ]),
    ).toBe("{\n}");
  });

  test("walks back over the turn's tool-only rows to its reply text", () => {
    // A row is one model response: the reply, then steps that only called tools.
    const turn = [
      { role: "user", parts: [{ type: "text", content: "review it" }] },
      { role: "assistant", parts: [{ type: "text", content: '{"issues":[]}' }] },
      { role: "assistant", content: "", parts: [{ type: "tool-invocation", toolName: "bash" }] },
      { role: "assistant", content: "", parts: [{ type: "tool-invocation", toolName: "read" }] },
    ];
    expect(lastAssistantText(turn)).toBe('{"issues":[]}');
    expect(
      lastAssistantText([
        { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash" }] },
      ]),
    ).toBe("done");
  });

  test("never reports an earlier turn's reply as this turn's", () => {
    expect(
      lastAssistantText([
        { role: "assistant", parts: [{ type: "text", content: "earlier turn" }] },
        { role: "user", parts: [{ type: "text", content: "prompt" }] },
        { role: "assistant", content: "", parts: [{ type: "tool-invocation", toolName: "bash" }] },
      ]),
    ).toBe("");
  });

  test("falls back to message content and tolerates malformed entries", () => {
    expect(lastAssistantText([null, { role: "assistant", content: "plain" }])).toBe("plain");
    expect(lastAssistantText([{ role: "user", content: "only a prompt" }])).toBeUndefined();
    expect(lastAssistantText(undefined)).toBeUndefined();
  });
});

test("the production read bound finds same-turn JSON behind seventeen tool-only responses", () => {
  const transcript = [
    { role: "user", content: "review" },
    { role: "assistant", content: '{"issues":[]}' },
    ...Array.from({ length: 17 }, () => ({
      role: "assistant",
      content: "",
      parts: [{ type: "tool-invocation", toolName: "read" }],
    })),
  ];
  const finalText = lastAssistantText(transcript.slice(-LAST_ASSISTANT_TEXT_READ_LIMIT));
  expect(finalText).toBe('{"issues":[]}');
  expect(
    workflowResultReminderPrompt({
      resultLabel: "report",
      toolName: "submit_review_report",
      submission: "preparing",
      finalText,
    }),
  ).toContain("You wrote the report as reply text");
});
