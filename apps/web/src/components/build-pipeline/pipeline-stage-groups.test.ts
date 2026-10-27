import { describe, expect, test } from "bun:test";
import { REVIEW_PACKAGE_SESSION_LABEL } from "@orkestrator/protocol/build-pipeline";
import {
  pipelineStageItems,
  validationOutcome,
  validationStageSummary,
} from "./pipeline-stage-groups";
import { build, session, validationRun } from "./pipeline-test-fixture";

describe("pipelineStageItems", () => {
  test("places Tests right after the package preparation that discovered them", () => {
    const pipeline = build({
      phase: "reviewing",
      reviewers: [
        { agent: "claude", model: "opus" },
        { agent: "codex", model: "gpt" },
      ],
      sessions: [
        session("build", "build", 0),
        session("fix", "prep", 60, { label: REVIEW_PACKAGE_SESSION_LABEL }),
        session("review", "review-1", 240, { label: "Review 1" }),
      ],
      validationRun: validationRun(),
    });
    expect(pipelineStageItems(pipeline).map((item) => item.key)).toEqual([
      "build",
      "prep",
      "validation-validation-1",
      "review-1",
    ]);
  });

  test("puts Tests before the first review when no preparation session exists", () => {
    const pipeline = build({
      phase: "reviewing",
      sessions: [session("build", "build", 0), session("review", "review", 240)],
      validationRun: validationRun(),
    });
    expect(pipelineStageItems(pipeline).map((item) => item.key)).toEqual([
      "build",
      "validation-validation-1",
      "review",
    ]);
  });
});

describe("validationOutcome", () => {
  test("reads per-command results, not just the run's lifecycle", () => {
    expect(validationOutcome(validationRun())).toBe("passed");
    const failed = validationRun();
    failed.results[0]!.status = "failed";
    expect(validationOutcome(failed)).toBe("failed");
    expect(validationStageSummary(failed)).toBe("1 of 2 checks failed");
    expect(validationOutcome(validationRun({ status: "running" }))).toBe("running");
    expect(validationOutcome(validationRun({ status: "cancelled" }))).toBe("cancelled");
    const incomplete = validationRun();
    incomplete.results[1]!.status = "incomplete";
    expect(validationOutcome(incomplete)).toBe("incomplete");
  });
});
