import { describe, expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import { findMultiReviewFixReport, isMultiReviewFixTabId } from "./multi-review-fix-tab";

function workflow(overrides: Partial<MultiReviewWorkflow> = {}): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "interactive",
    reviewers: [],
    fixModel: { agent: "codex", model: "gpt-5.6" },
    consolidatedReport: TEST_STRUCTURED_REVIEW_REPORT,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    backendRevision: 1,
    ...overrides,
  } as MultiReviewWorkflow;
}

describe("isMultiReviewFixTabId", () => {
  test("matches the default, launch, and recorded fix tab identities", () => {
    expect(isMultiReviewFixTabId("multi-review-fix:multi-1", "multi-1")).toBe(true);
    expect(isMultiReviewFixTabId("multi-review-fix:multi-1:launch-1", "multi-1")).toBe(true);
    expect(isMultiReviewFixTabId("fix-tab-launch-1", "multi-1", "fix-tab-launch-1")).toBe(true);
  });

  test("does not treat a longer sibling workflow id as a prefix match", () => {
    expect(isMultiReviewFixTabId("multi-review-fix:multi-10", "multi-1")).toBe(false);
    expect(isMultiReviewFixTabId("multi-review-fix:multi-1", "multi-10")).toBe(false);
  });
});

describe("findMultiReviewFixReport", () => {
  test("returns the consolidated report for a Fix tab in the same environment", () => {
    expect(
      findMultiReviewFixReport([workflow()], "multi-review-fix:multi-1:launch-1", "env-1"),
    ).toBe(TEST_STRUCTURED_REVIEW_REPORT);
  });

  test("ignores a workflow from another environment or without a report", () => {
    expect(
      findMultiReviewFixReport(
        [workflow({ environmentId: "env-2" })],
        "multi-review-fix:multi-1",
        "env-1",
      ),
    ).toBeUndefined();
    expect(
      findMultiReviewFixReport(
        [workflow({ consolidatedReport: undefined })],
        "multi-review-fix:multi-1",
        "env-1",
      ),
    ).toBeUndefined();
  });

  test("ignores ordinary agent tabs", () => {
    expect(findMultiReviewFixReport([workflow()], "tab-review", "env-1")).toBeUndefined();
  });

  test("returns the consolidated report for a recorded fixTabId without the default prefix", () => {
    expect(
      findMultiReviewFixReport(
        [workflow({ fixTabId: "fix-tab-launch-1" })],
        "fix-tab-launch-1",
        "env-1",
      ),
    ).toBe(TEST_STRUCTURED_REVIEW_REPORT);
  });
});
