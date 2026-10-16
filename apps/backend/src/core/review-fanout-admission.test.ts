import { describe, expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import { isReviewerRecord } from "@orkestrator/protocol/review-fanout";
import {
  clearReviewerAdmission,
  compactReviewerAdmissionQueue,
  projectReviewerAdmissionQueue,
} from "./review-fanout-admission.js";

function reviewer(index: number, status: ReviewerRecord["status"] = "pending"): ReviewerRecord {
  return { id: `reviewer-${index + 1}`, agent: "claude", model: "opus", status };
}

const places = (reviewers: ReviewerRecord[]) =>
  reviewers.map((entry) =>
    entry.admissionState === "queued"
      ? `#${entry.queuePosition}`
      : (entry.admissionState ?? entry.status),
  );

describe("reviewer admission queue", () => {
  test("numbers the waiting reviewers and marks the rest of the pending ones admitting", () => {
    const reviewers = [reviewer(0), reviewer(1), reviewer(2), reviewer(3, "running")];
    expect(projectReviewerAdmissionQueue(reviewers, reviewers.slice(0, 3))).toBe(true);
    expect(places(reviewers)).toEqual(["#1", "#2", "#3", "running"]);
    expect(projectReviewerAdmissionQueue(reviewers, [reviewers[1]!, reviewers[2]!])).toBe(true);
    expect(places(reviewers)).toEqual(["admitting", "#1", "#2", "running"]);
    // Nothing moved, nothing to stage.
    expect(projectReviewerAdmissionQueue(reviewers, [reviewers[1]!, reviewers[2]!])).toBe(false);
    // A reviewer that left `pending` carries no queue fields.
    reviewers[0]!.status = "running";
    projectReviewerAdmissionQueue(reviewers, [reviewers[2]!]);
    expect(reviewers[0]).not.toHaveProperty("admissionState");
    expect(places(reviewers)).toEqual(["running", "admitting", "#1", "running"]);
    expect(reviewers.every(isReviewerRecord)).toBe(true);
  });

  test("moves the reviewers behind a stopped one up", () => {
    const reviewers = [reviewer(0), reviewer(1), reviewer(2), reviewer(3)];
    projectReviewerAdmissionQueue(reviewers, [reviewers[3]!, reviewers[1]!, reviewers[2]!]);
    expect(places(reviewers)).toEqual(["admitting", "#2", "#3", "#1"]);
    reviewers[1]!.status = "cancelled";
    expect(compactReviewerAdmissionQueue(reviewers)).toBe(true);
    expect(places(reviewers)).toEqual(["admitting", "cancelled", "#2", "#1"]);
    expect(compactReviewerAdmissionQueue(reviewers)).toBe(false);
  });

  test("clears the fields and reports whether there were any", () => {
    const entry: ReviewerRecord = { ...reviewer(0), admissionState: "queued", queuePosition: 2 };
    expect(clearReviewerAdmission(entry)).toBe(true);
    expect(entry).toEqual(reviewer(0));
    expect(clearReviewerAdmission(entry)).toBe(false);
  });

  test("the record validator bounds the fields", () => {
    expect(isReviewerRecord({ ...reviewer(0), admissionState: "admitting" })).toBe(true);
    expect(isReviewerRecord({ ...reviewer(0), admissionState: "waiting" })).toBe(false);
    expect(isReviewerRecord({ ...reviewer(0), admissionState: "queued", queuePosition: 0 })).toBe(
      false,
    );
    expect(isReviewerRecord({ ...reviewer(0), admissionState: "queued", queuePosition: 33 })).toBe(
      false,
    );
    expect(isReviewerRecord({ ...reviewer(0), admissionState: "queued", queuePosition: 1.5 })).toBe(
      false,
    );
  });
});
