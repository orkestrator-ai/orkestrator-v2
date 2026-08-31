import type { ReviewPreparationResult } from "./looped-review-prompts.js";
import { reviewPackageArtifactPath } from "@orkestrator/protocol/review-artifacts";

export const TEST_REVIEW_PREPARATION: ReviewPreparationResult = {
  validation: [
    {
      command: "No validation configured in this test fixture",
      status: "skipped",
      exitCode: null,
      stdoutPath: null,
      stderrPath: null,
      durationMs: 0,
      limitation: "This test does not exercise validation artifact hydration.",
    },
  ],
  uncommittedFiles: [],
  limitations: ["This test does not exercise validation artifact hydration."],
};

/** Minimal command result for supervisor tests that do not exercise package hydration itself. */
export function testGeneratedReviewPackage(args: Record<string, unknown>): Record<string, unknown> {
  const head = "1".repeat(40);
  const id = String(args.packageId);
  const sha256 = "a".repeat(64);
  return {
    kind: "file",
    id,
    round: args.round,
    preparedAt: "2026-08-29T00:00:00.000Z",
    targetBranch: args.targetBranch,
    baseRef: "0".repeat(40),
    headRef: head,
    filePath: reviewPackageArtifactPath(id, sha256),
    sha256,
    bytes: 1_024,
    changedFileCount: 0,
    diffCharacters: 0,
    limitations: [
      ...TEST_REVIEW_PREPARATION.limitations,
      ...((args.additionalLimitations as string[] | undefined) ?? []),
    ],
  };
}
