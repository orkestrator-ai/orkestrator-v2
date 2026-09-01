import {
  isReviewPackage,
  isReviewPackageReference,
  type ReviewPackage,
  type ReviewPackageReference,
} from "@orkestrator/protocol/review-workflow";
import { reviewPackageArtifactPath } from "@orkestrator/protocol/review-artifacts";
import { createHash } from "node:crypto";

/** Bounds one environment-local package file independently of snapshot storage. */
export const MAX_PERSISTED_REVIEW_PACKAGE_BYTES = 16 * 1024 * 1024;

/**
 * Validates the identity-bearing shell returned by the environment-side package
 * generator and strips any model-authored context.
 *
 * Git refs, diff bytes, file contents, hashes, and validation output all come
 * from the backend command. The model only supplies preparation metadata, so a
 * caller must never let it replace the expected package identity. Trusted
 * ticket/project context is delivered in the reviewer prompt and never stored
 * in the repository workspace.
 */
export function normalizeGeneratedReviewPackage(
  value: unknown,
  expected: {
    id: string;
    round: number;
    targetBranch: string;
    additionalLimitations?: string[];
  },
): ReviewPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Review package failed runtime validation");
  }
  const candidate = value as Partial<ReviewPackage>;
  if (
    candidate.id !== expected.id ||
    candidate.round !== expected.round ||
    candidate.targetBranch !== expected.targetBranch ||
    typeof candidate.preparedAt !== "string" ||
    typeof candidate.baseRef !== "string" ||
    typeof candidate.headRef !== "string" ||
    typeof candidate.completeDiff !== "string" ||
    !Array.isArray(candidate.changedFiles) ||
    !Array.isArray(candidate.validation) ||
    !Array.isArray(candidate.skippedFiles) ||
    !Array.isArray(candidate.uncommittedFiles) ||
    !Array.isArray(candidate.limitations)
  ) {
    throw new Error("Prepared package does not match the active review round");
  }
  // Context belongs to the workflow, not the generator. Drop any generated
  // value (including null) before attaching the trusted ticket snapshot.
  const { context: _generated, ...rest } = candidate;
  const normalized = {
    ...rest,
    limitations: [...candidate.limitations, ...(expected.additionalLimitations ?? [])],
  };
  if (!isReviewPackage(normalized, expected.round)) {
    throw new Error("Review package failed runtime validation");
  }
  // Enforce the budget against the exact bytes that will be written. Checking
  // compact JSON here and pretty JSON later made one named limit mean two
  // different things.
  reviewPackageFileContents(normalized);
  return normalized;
}

export function reviewPackageFileContents(reviewPackage: ReviewPackage): Buffer {
  const contents = Buffer.from(`${JSON.stringify(reviewPackage)}\n`, "utf8");
  if (contents.byteLength > MAX_PERSISTED_REVIEW_PACKAGE_BYTES) {
    throw new Error(
      `Review package is ${contents.byteLength} bytes and exceeds the ${MAX_PERSISTED_REVIEW_PACKAGE_BYTES}-byte file budget; reduce the committed change or validation output before retrying review`,
    );
  }
  return contents;
}

export function reviewPackageReference(
  reviewPackage: ReviewPackage,
  contents: Buffer,
): ReviewPackageReference {
  const sha256 = createHash("sha256").update(contents).digest("hex");
  return {
    kind: "file",
    id: reviewPackage.id,
    round: reviewPackage.round,
    preparedAt: reviewPackage.preparedAt,
    targetBranch: reviewPackage.targetBranch,
    baseRef: reviewPackage.baseRef,
    headRef: reviewPackage.headRef,
    filePath: reviewPackageArtifactPath(reviewPackage.id, sha256),
    sha256,
    bytes: contents.byteLength,
    changedFileCount: reviewPackage.changedFiles.length,
    diffCharacters: reviewPackage.completeDiff.length,
    limitations: [...reviewPackage.limitations],
  };
}

/** Validates the untyped command response before it becomes durable workflow state. */
export function parseReviewPackageReference(
  value: unknown,
  expected: { id: string; round: number; targetBranch: string },
): ReviewPackageReference {
  if (
    !isReviewPackageReference(value, expected.round) ||
    value.id !== expected.id ||
    value.targetBranch !== expected.targetBranch
  ) {
    throw new Error("Prepared package reference does not match the active review round");
  }
  return value;
}
