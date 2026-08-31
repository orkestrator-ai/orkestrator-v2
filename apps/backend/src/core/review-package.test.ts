import { describe, expect, test } from "bun:test";
import { isReviewPackage } from "@orkestrator/protocol/review-workflow";
import {
  MAX_PERSISTED_REVIEW_PACKAGE_BYTES,
  normalizeGeneratedReviewPackage,
  parseReviewPackageReference,
  reviewPackageFileContents,
  reviewPackageReference,
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
  test("drops generated workspace context and appends trusted limitations", () => {
    const normalized = normalizeGeneratedReviewPackage(
      generatedPackage({ context: { ticketTitle: "untrusted" } }),
      {
        id: "package-1",
        round: 1,
        targetBranch: "main",
        additionalLimitations: ["Ticket comments were truncated."],
      },
    );

    expect(normalized.context).toBeUndefined();
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

  test("projects file contents to a small, identity-bound durable reference", () => {
    const normalized = normalizeGeneratedReviewPackage(generatedPackage(), {
      id: "package-1",
      round: 1,
      targetBranch: "main",
    });
    const contents = reviewPackageFileContents(normalized);
    const reference = reviewPackageReference(normalized, contents);

    expect(reference).toMatchObject({
      kind: "file",
      id: "package-1",
      bytes: contents.byteLength,
      changedFileCount: 1,
      diffCharacters: 4,
    });
    expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(contents.toString("utf8")).toBe(`${JSON.stringify(normalized)}\n`);
    expect(reference.filePath).toBe(
      `.orkestrator/review-artifacts/package-1/review-package-${reference.sha256}.json`,
    );
    expect(JSON.stringify(reference).length).toBeLessThan(1_000);
    expect(
      parseReviewPackageReference(reference, {
        id: "package-1",
        round: 1,
        targetBranch: "main",
      }),
    ).toEqual(reference);
  });

  test("rejects references whose identity, branch, round, or content-addressed path differs", () => {
    const normalized = normalizeGeneratedReviewPackage(generatedPackage(), {
      id: "package-1",
      round: 1,
      targetBranch: "main",
    });
    const reference = reviewPackageReference(normalized, reviewPackageFileContents(normalized));
    for (const candidate of [
      { ...reference, id: "package-2" },
      { ...reference, round: 2 },
      { ...reference, targetBranch: "release" },
      { ...reference, filePath: ".orkestrator/review-artifacts/package-1/review-package.json" },
      normalized,
    ]) {
      expect(() =>
        parseReviewPackageReference(candidate, {
          id: "package-1",
          round: 1,
          targetBranch: "main",
        }),
      ).toThrow("does not match");
    }
  });
});
