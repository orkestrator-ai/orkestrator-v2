import { describe, expect, test } from "bun:test";
import {
  REVIEW_VALIDATION_DISCOVERY_BRANCH_CLAUSE,
  REVIEW_VALIDATION_DISCOVERY_PROMPT_PREFIX,
  REVIEW_VALIDATION_DISCOVERY_PROMPT_SIGNATURE,
  STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION,
} from "@orkestrator/protocol/review-evidence-frames";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import type { NativeMessage } from "./native-message-types";
import { attachFixPromptEvidence } from "./fix-prompt-evidence";

function message(id: string, role: NativeMessage["role"], content: string): NativeMessage {
  return {
    id,
    role,
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-09-15T14:00:00.000Z",
  };
}

const PREPARATION_PROMPT = `${REVIEW_VALIDATION_DISCOVERY_PROMPT_PREFIX}"main"${REVIEW_VALIDATION_DISCOVERY_BRANCH_CLAUSE}\n\n${REVIEW_VALIDATION_DISCOVERY_PROMPT_SIGNATURE} Usually one batched inventory read`;

describe("attachFixPromptEvidence", () => {
  test("pins the durable report to the address prompt, not an earlier preparation turn", () => {
    const pinned = attachFixPromptEvidence(
      [
        message("prep", "user", PREPARATION_PROMPT),
        message("prep-reply", "assistant", "Inventory ready."),
        message("address", "user", STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION),
      ],
      TEST_STRUCTURED_REVIEW_REPORT,
    );

    expect(pinned.map((row) => ({ id: row.id, evidence: Boolean(row.promptEvidence) }))).toEqual([
      { id: "prep", evidence: false },
      { id: "prep-reply", evidence: false },
      { id: "address", evidence: true },
    ]);
    expect(pinned[2]?.promptEvidence).toBe(TEST_STRUCTURED_REVIEW_REPORT);
  });

  test("keeps the pin on the opening prompt when a later follow-up is present", () => {
    const pinned = attachFixPromptEvidence(
      [
        message("address", "user", STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION),
        message("reply", "assistant", "Working on it."),
        message("follow-up", "user", "Please also fix the tests."),
      ],
      TEST_STRUCTURED_REVIEW_REPORT,
    );

    expect(pinned[0]?.promptEvidence).toBe(TEST_STRUCTURED_REVIEW_REPORT);
    expect(pinned[2]?.promptEvidence).toBeUndefined();
  });

  test("does not pin onto a later follow-up when the opening prompt is outside the window", () => {
    const pinned = attachFixPromptEvidence(
      [message("follow-up", "user", "Please also fix the tests.")],
      TEST_STRUCTURED_REVIEW_REPORT,
    );

    expect(pinned[0]?.promptEvidence).toBeUndefined();
  });
});
