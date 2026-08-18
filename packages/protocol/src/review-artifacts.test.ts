import { describe, expect, test } from "bun:test";

import {
  REVIEW_ARTIFACT_ROOT,
  reviewArtifactDirectory,
  reviewValidationArtifactOrdinal,
  reviewValidationArtifactPaths,
} from "./review-artifacts";

describe("review artifact paths", () => {
  test("anchors every package directory under the Git-excluded root", () => {
    expect(REVIEW_ARTIFACT_ROOT).toBe(".orkestrator/review-artifacts");
    expect(reviewArtifactDirectory("package-1")).toBe(".orkestrator/review-artifacts/package-1");
    expect(reviewArtifactDirectory("review-package-abc-r2")).toBe(
      ".orkestrator/review-artifacts/review-package-abc-r2",
    );
  });

  test("numbers ordinals by array position, not by execution order", () => {
    // A skipped command still consumes its ordinal, which is why the ordinal is
    // derived from the index rather than from a running count of executions.
    expect(reviewValidationArtifactOrdinal(0)).toBe("01");
    expect(reviewValidationArtifactOrdinal(1)).toBe("02");
    expect(reviewValidationArtifactOrdinal(8)).toBe("09");
    expect(reviewValidationArtifactOrdinal(9)).toBe("10");
    expect(reviewValidationArtifactOrdinal(98)).toBe("99");
  });

  test("widens past two digits rather than wrapping at one hundred entries", () => {
    expect(reviewValidationArtifactOrdinal(99)).toBe("100");
    expect(reviewValidationArtifactPaths("package-1", 99).stdoutPath).toBe(
      ".orkestrator/review-artifacts/package-1/validation-100.stdout.txt",
    );
  });

  test("pairs stdout and stderr on the same ordinal", () => {
    expect(reviewValidationArtifactPaths("package-1", 0)).toEqual({
      stdoutPath: ".orkestrator/review-artifacts/package-1/validation-01.stdout.txt",
      stderrPath: ".orkestrator/review-artifacts/package-1/validation-01.stderr.txt",
    });
    expect(reviewValidationArtifactPaths("package-2", 2)).toEqual({
      stdoutPath: ".orkestrator/review-artifacts/package-2/validation-03.stdout.txt",
      stderrPath: ".orkestrator/review-artifacts/package-2/validation-03.stderr.txt",
    });
  });
});
