import { describe, expect, test } from "bun:test";
import {
  ReviewContractValidationError,
} from "@orkestrator/protocol/structured-review";
import {
  readExistingValidatedBuildReview,
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

  test("reuses the latest durable review instead of starting the review again", async () => {
    const calls: Array<{ sessionId: string; requestId: string }> = [];
    const recovered = await readExistingValidatedBuildReview(
      {
        structuredReviewRequestId: "review-request",
        sessions: [
          {
            phase: "build",
            iteration: 0,
            sessionKey: "build",
            sdkSessionId: "build-session",
            status: "idle",
            startedAt: "2026-07-27T14:37:11.633Z",
            label: "Build Session",
          },
          {
            phase: "review",
            iteration: 0,
            sessionKey: "review-old",
            sdkSessionId: "review-old-session",
            status: "idle",
            startedAt: "2026-07-27T14:50:00.000Z",
            label: "Review Session",
          },
          {
            phase: "review",
            iteration: 1,
            sessionKey: "review-latest",
            sdkSessionId: "review-latest-session",
            status: "idle",
            startedAt: "2026-07-27T15:01:24.778Z",
            label: "Review Session",
          },
        ],
      },
      async (sessionId, requestId) => {
        calls.push({ sessionId, requestId });
        return TEST_STRUCTURED_REVIEW_OUTPUT;
      },
    );

    expect(calls).toEqual([{
      sessionId: "review-latest-session",
      requestId: "review-request",
    }]);
    expect(recovered).toEqual({
      report: TEST_STRUCTURED_REVIEW_REPORT,
      session: expect.objectContaining({
        sdkSessionId: "review-latest-session",
      }),
    });
  });

  test("does not attempt recovery without both a review session and request ID", async () => {
    expect(await readExistingValidatedBuildReview(
      { sessions: [], structuredReviewRequestId: "review-request" },
      async () => TEST_STRUCTURED_REVIEW_OUTPUT,
    )).toBeNull();
    expect(await readExistingValidatedBuildReview(
      {
        sessions: [{
          phase: "review",
          iteration: 0,
          sessionKey: "review",
          sdkSessionId: "review-session",
          status: "idle",
          startedAt: "2026-07-27T15:01:24.778Z",
          label: "Review Session",
        }],
      },
      async () => TEST_STRUCTURED_REVIEW_OUTPUT,
    )).toBeNull();
  });
});
