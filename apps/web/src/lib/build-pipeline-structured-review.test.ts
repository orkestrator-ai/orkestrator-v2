import { describe, expect, test } from "bun:test";
import {
  ReviewContractValidationError,
} from "@orkestrator/protocol/structured-review";
import {
  readExistingValidatedBuildReview,
  readValidatedBuildReview,
  recoverExistingBuildReview,
  structuredReviewHasFindings,
} from "./build-pipeline-structured-review";
import type { PipelineSession } from "@/stores/buildPipelineStore";
import {
  TEST_LEGACY_STRUCTURED_REVIEW_REPORT,
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

  test("refuses to reuse a report the pipeline has already consumed", async () => {
    // The request id and the last review session are only guaranteed to belong
    // to the same round while the report is unconsumed. After an addressing
    // round the bridge still serves the old payload for the old id, so reusing
    // it here would skip the review the pipeline is actually waiting on.
    let called = false;
    const recovered = await readExistingValidatedBuildReview(
      {
        structuredReviewRequestId: "previous-round-request",
        structuredReview: TEST_STRUCTURED_REVIEW_REPORT,
        sessions: [
          reviewSession("review-round-1", "2026-07-27T14:50:00.000Z"),
          {
            phase: "fix",
            iteration: 1,
            sessionKey: "fix",
            sdkSessionId: "fix-session",
            status: "idle",
            startedAt: "2026-07-27T15:20:00.000Z",
            label: "Fix Session",
          },
        ],
      },
      async () => {
        called = true;
        return TEST_STRUCTURED_REVIEW_OUTPUT;
      },
    );

    expect(recovered).toBeNull();
    expect(called).toBe(false);
  });

  test("accepts a durable review written before notRun existed", async () => {
    const recovered = await readExistingValidatedBuildReview(
      {
        structuredReviewRequestId: "review-request",
        sessions: [reviewSession("review", "2026-07-27T15:01:24.778Z")],
      },
      async () => ({
        ok: true,
        provider: "claude",
        value: TEST_LEGACY_STRUCTURED_REVIEW_REPORT,
      }),
    );

    expect(recovered?.report.testResults).toEqual({
      total: 8_107,
      passed: 8_094,
      failed: 0,
      notRun: 13,
      failures: [],
    });
  });

  test("propagates a failed durable read so callers can fall back deliberately", async () => {
    const pipeline = {
      structuredReviewRequestId: "review-request",
      sessions: [reviewSession("review", "2026-07-27T15:01:24.778Z")],
    };

    await expect(readExistingValidatedBuildReview(pipeline, async () => null))
      .rejects.toThrow("without a structured review result");
    await expect(readExistingValidatedBuildReview(pipeline, async () => ({
      ok: false,
      provider: "codex",
      error: {
        code: "schema_retry_exhausted",
        message: "Schema retries exhausted",
        provider: "codex",
        retryable: true,
      },
    }))).rejects.toThrow("schema_retry_exhausted");
  });

  test("collapses every unusable outcome to null when recovering", async () => {
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const pipeline = {
        structuredReviewRequestId: "review-request",
        sessions: [reviewSession("review", "2026-07-27T15:01:24.778Z")],
      };

      expect(await recoverExistingBuildReview(
        pipeline,
        async () => null,
        "[Test]",
      )).toBeNull();
      expect(await recoverExistingBuildReview(
        pipeline,
        async () => { throw new Error("bridge unreachable"); },
        "[Test]",
      )).toBeNull();
      expect(await recoverExistingBuildReview(
        pipeline,
        async () => TEST_STRUCTURED_REVIEW_OUTPUT,
        "[Test]",
      )).toEqual({
        report: TEST_STRUCTURED_REVIEW_REPORT,
        session: expect.objectContaining({ sdkSessionId: "review-session" }),
      });

      expect(warnings).toHaveLength(2);
      expect(warnings[0]?.[0]).toContain("starting a fresh review");
    } finally {
      console.warn = warn;
    }
  });

  test("polls for a payload that lands a few frames after completion", async () => {
    let attempts = 0;
    const report = await readValidatedBuildReview(
      async () => {
        attempts += 1;
        return attempts < 3 ? null : TEST_STRUCTURED_REVIEW_OUTPUT;
      },
      { intervalMs: 0 },
    );

    expect(attempts).toBe(3);
    expect(report).toEqual(TEST_STRUCTURED_REVIEW_REPORT);
  });

  test("holds a live provider reply to the current contract", async () => {
    // The recovery read opts into the legacy shape; the normal completion read
    // must not, or a reply that silently dropped `notRun` would be accepted with
    // an invented count.
    await expect(readValidatedBuildReview(
      async () => ({
        ok: true,
        provider: "claude",
        value: TEST_LEGACY_STRUCTURED_REVIEW_REPORT,
      }),
      { attempts: 1, intervalMs: 0 },
    )).rejects.toBeInstanceOf(ReviewContractValidationError);
  });
});

function reviewSession(sessionKey: string, startedAt: string): PipelineSession {
  return {
    phase: "review",
    iteration: 0,
    sessionKey,
    sdkSessionId: "review-session",
    status: "idle",
    startedAt,
    label: "Review Session",
  };
}
