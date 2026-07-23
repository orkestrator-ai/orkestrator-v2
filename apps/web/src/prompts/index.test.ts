import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  REVIEW_PROMPT_TARGET_BRANCH_TOKEN,
  createAddressIssuesPrompt,
  createReviewPrompt,
} from "./index";

describe("prompt public exports", () => {
  test("exports the configurable action-bar review prompt contract", () => {
    expect(REVIEW_PROMPT_TARGET_BRANCH_TOKEN).toBe("{{targetBranch}}");
    expect(DEFAULT_REVIEW_PROMPT_TEMPLATE).toContain(REVIEW_PROMPT_TARGET_BRANCH_TOKEN);
    expect(createReviewPrompt("develop", "Review {{targetBranch}}.")).toBe(
      "Review develop.",
    );
    expect(createAddressIssuesPrompt()).toContain("Stage only files that clearly belong");
  });
});
