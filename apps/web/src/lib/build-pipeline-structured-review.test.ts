import { describe, expect, test } from "bun:test";
import {
  ReviewContractValidationError,
} from "@orkestrator/protocol/structured-review";
import {
  readValidatedBuildReview,
  structuredReviewHasFindings,
} from "./build-pipeline-structured-review";
import {
  TEST_STRUCTURED_REVIEW_OUTPUT,
  TEST_STRUCTURED_REVIEW_REPORT,
} from "@/components/build-pipeline/structured-review-test-fixture";

describe("build pipeline structured reviews", () => {
  test("accepts and classifies a complete authoritative report", async () => {
    const report = await readValidatedBuildReview(
      async () => TEST_STRUCTURED_REVIEW_OUTPUT,
    );

    expect(report).toEqual(TEST_STRUCTURED_REVIEW_REPORT);
    expect(structuredReviewHasFindings(report)).toBe(true);
    expect(structuredReviewHasFindings({
      ...report,
      issues: [],
      testCoverageGaps: [],
    })).toBe(false);
  });

  test("rejects incomplete payloads instead of treating them as plaintext", async () => {
    await expect(readValidatedBuildReview(async () => ({
      ok: true,
      provider: "claude",
      value: { reviewSummary: "looks fine" },
    }))).rejects.toBeInstanceOf(ReviewContractValidationError);
  });

  test("surfaces typed provider failures and missing structured results", async () => {
    await expect(readValidatedBuildReview(async () => ({
      ok: false,
      provider: "codex",
      error: {
        code: "schema_retry_exhausted",
        message: "Schema retries exhausted",
        provider: "codex",
        retryable: true,
      },
    }))).rejects.toThrow("schema_retry_exhausted");

    await expect(readValidatedBuildReview(
      async () => null,
      { attempts: 1, intervalMs: 0 },
    )).rejects.toThrow("without a structured review result");
  });
});
