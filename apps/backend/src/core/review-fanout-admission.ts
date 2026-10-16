/**
 * The admission queue as reviewers see it.
 *
 * `runBoundedTasks` admits pending reviewers a few at a time, so in a large
 * panel most wait for a slot. The runner projects the scheduler's queue onto
 * the reviewer records (`admissionState`, `queuePosition`) so the flow graph
 * can say "queued · #3 of 7". The fields are observations: they ride on the
 * pass's safety commits and its one observational flush, and never cost a
 * write of their own.
 */
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";

/** Drops a reviewer's admission-queue fields; true when there were any. */
export function clearReviewerAdmission(reviewer: ReviewerRecord): boolean {
  if (reviewer.admissionState === undefined && reviewer.queuePosition === undefined) return false;
  delete reviewer.admissionState;
  delete reviewer.queuePosition;
  return true;
}

/**
 * Projects the admission queue onto the reviewers. Those in `waiting` are
 * `queued` at their one-based place in it; any other pending reviewer is being
 * admitted; every reviewer that is no longer pending carries neither field.
 * Returns whether anything changed.
 */
export function projectReviewerAdmissionQueue(
  reviewers: readonly ReviewerRecord[],
  waiting: readonly ReviewerRecord[],
): boolean {
  const positions = new Map<ReviewerRecord, number>();
  waiting.forEach((reviewer, index) => positions.set(reviewer, index + 1));
  let changed = false;
  for (const reviewer of reviewers) {
    if (reviewer.status !== "pending") {
      changed = clearReviewerAdmission(reviewer) || changed;
      continue;
    }
    const position = positions.get(reviewer);
    if (position === undefined) {
      if (reviewer.admissionState !== "admitting" || reviewer.queuePosition !== undefined) {
        reviewer.admissionState = "admitting";
        delete reviewer.queuePosition;
        changed = true;
      }
    } else if (reviewer.admissionState !== "queued" || reviewer.queuePosition !== position) {
      reviewer.admissionState = "queued";
      reviewer.queuePosition = position;
      changed = true;
    }
  }
  return changed;
}

/**
 * Re-numbers the queued reviewers in their current order, after one left the
 * queue outside a review pass (stopped, or the workflow cancelled).
 */
export function compactReviewerAdmissionQueue(reviewers: readonly ReviewerRecord[]): boolean {
  const waiting = reviewers
    .filter((reviewer) => reviewer.status === "pending" && reviewer.admissionState === "queued")
    .sort(
      (left, right) =>
        (left.queuePosition ?? Number.MAX_SAFE_INTEGER) -
        (right.queuePosition ?? Number.MAX_SAFE_INTEGER),
    );
  let changed = false;
  for (const reviewer of reviewers) {
    if (reviewer.status !== "pending") changed = clearReviewerAdmission(reviewer) || changed;
  }
  waiting.forEach((reviewer, index) => {
    if (reviewer.queuePosition !== index + 1) {
      reviewer.queuePosition = index + 1;
      changed = true;
    }
  });
  return changed;
}
