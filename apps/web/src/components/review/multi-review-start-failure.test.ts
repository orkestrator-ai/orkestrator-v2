import { expect, test } from "bun:test";
import { reviewerStartFailureNotice } from "./multi-review-steps";

const failures = [
  { id: "a", name: "Reviewer 1", agent: "cursor", error: "  " },
  { id: "b", name: "Reviewer 2", agent: "claude", error: "Authentication failed" },
];
test("startup notice covers partial, all, single and empty panels and absent reasons", () => {
  expect(reviewerStartFailureNotice([], 3)).toBeNull();
  const partial = reviewerStartFailureNotice(failures, 3)!;
  expect(partial.headline).toBe(
    "2 of 3 reviewers could not start, so this review is missing their findings. The other reviewers carried on.",
  );
  expect(partial.reasons).toEqual([
    "Reviewer 1 · Cursor Agent: no reason was recorded",
    "Reviewer 2 · Claude Code: Authentication failed",
  ]);
  expect(reviewerStartFailureNotice(failures, 2)!.headline).toBe(
    "No reviewer could start, so this review has no reviewer reports.",
  );
  expect(reviewerStartFailureNotice(failures.slice(0, 1), 1)!.headline).toBe(
    "The reviewer (Cursor Agent) could not start, so this review has no reviewer report.",
  );
});
