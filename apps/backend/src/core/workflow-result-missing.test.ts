import { describe, expect, test } from "bun:test";

import { lastAssistantText, missingWorkflowResultMessage } from "./workflow-result-missing.js";

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

describe("lastAssistantText", () => {
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

  test("falls back to message content and tolerates malformed entries", () => {
    expect(lastAssistantText([null, { role: "assistant", content: "plain" }])).toBe("plain");
    expect(lastAssistantText([{ role: "user", content: "only a prompt" }])).toBeUndefined();
    expect(lastAssistantText(undefined)).toBeUndefined();
  });
});
