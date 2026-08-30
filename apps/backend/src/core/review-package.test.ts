import { describe, expect, test } from "bun:test";
import { isReviewPackage } from "@orkestrator/protocol/review-workflow";
import {
  MAX_PERSISTED_REVIEW_PACKAGE_BYTES,
  normalizeGeneratedReviewPackage,
} from "./review-package.js";

function generatedPackage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const head = "1".repeat(40);
  return {
    id: "package-1",
    round: 1,
    preparedAt: "2026-08-29T00:00:00.000Z",
    targetBranch: "main",
    baseRef: "0".repeat(40),
    headRef: head,
    commit: { sha: head, subject: "feat: package", committedFiles: ["src/app.ts"] },
    completeDiff: "diff",
    changedFiles: [
      {
        path: "src/app.ts",
        status: "M",
        content: "export {};",
        contentSha256: "a".repeat(64),
        omittedReason: null,
      },
    ],
    validation: [
      {
        command: "bun test",
        status: "passed",
        exitCode: 0,
        stdout: "passed",
        stderr: "",
        durationMs: 1,
      },
    ],
    skippedFiles: [],
    uncommittedFiles: [],
    limitations: [],
    ...overrides,
  };
}

describe("normalizeGeneratedReviewPackage", () => {
  test("replaces generated context with trusted context and appends trusted limitations", () => {
    const normalized = normalizeGeneratedReviewPackage(
      generatedPackage({ context: { ticketTitle: "untrusted" } }),
      {
        id: "package-1",
        round: 1,
        targetBranch: "main",
        context: { ticketTitle: "trusted" },
        additionalLimitations: ["Ticket comments were truncated."],
      },
    );

    expect(normalized.context).toEqual({ ticketTitle: "trusted" });
    expect(normalized.limitations).toEqual(["Ticket comments were truncated."]);
    expect(isReviewPackage(normalized, 1)).toBe(true);
  });

  test("rejects malformed shells and identity mismatches", () => {
    for (const value of [
      null,
      generatedPackage({ id: "wrong" }),
      generatedPackage({ round: 2 }),
      generatedPackage({ targetBranch: "other" }),
      generatedPackage({ commit: undefined }),
      generatedPackage({ changedFiles: "not-an-array" }),
      generatedPackage({ validation: [{ command: "bun test" }] }),
    ]) {
      expect(() =>
        normalizeGeneratedReviewPackage(value, {
          id: "package-1",
          round: 1,
          targetBranch: "main",
        }),
      ).toThrow();
    }
  });

  test("rejects evidence above the dedicated persistence budget", () => {
    expect(() =>
      normalizeGeneratedReviewPackage(
        generatedPackage({ completeDiff: "x".repeat(MAX_PERSISTED_REVIEW_PACKAGE_BYTES) }),
        { id: "package-1", round: 1, targetBranch: "main" },
      ),
    ).toThrow("exceeds");
  });
});
