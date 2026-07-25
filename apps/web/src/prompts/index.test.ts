import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REVIEW_INSTRUCTION,
  REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN,
  createAddressIssuesPrompt,
  createReviewPrompt,
} from "./index";

describe("prompt public exports", () => {
  test("exports the configurable shared review instruction contract", () => {
    expect(REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN).toBe("{{targetBranch}}");
    expect(DEFAULT_REVIEW_INSTRUCTION).toContain(REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN);
    expect(createReviewPrompt("develop", "Review {{targetBranch}}.")).toContain(
      'User review instruction (JSON string): "Review develop."',
    );
    expect(createAddressIssuesPrompt()).toContain("Stage only files that clearly belong");
  });
});
