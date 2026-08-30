import {
  isReviewPackage,
  type ReviewPackage,
  type ReviewPackageContext,
} from "@orkestrator/protocol/review-workflow";

/** Leaves at least half of the 32 MB pipeline snapshot budget for task and session state. */
export const MAX_PERSISTED_REVIEW_PACKAGE_BYTES = 16 * 1024 * 1024;

/**
 * Validates the identity-bearing shell returned by the environment-side package
 * generator and attaches the workflow-owned context.
 *
 * Git refs, diff bytes, file contents, hashes, and validation output all come
 * from the backend command. The model only supplies preparation metadata, so a
 * caller must never let it replace the expected package identity or context.
 */
export function normalizeGeneratedReviewPackage(
  value: unknown,
  expected: {
    id: string;
    round: number;
    targetBranch: string;
    context?: ReviewPackageContext;
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
    ...(expected.context ? { context: expected.context } : {}),
  };
  if (!isReviewPackage(normalized, expected.round)) {
    throw new Error("Review package failed runtime validation");
  }
  const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (bytes > MAX_PERSISTED_REVIEW_PACKAGE_BYTES) {
    throw new Error(
      `Review package is ${bytes} bytes and exceeds the ${MAX_PERSISTED_REVIEW_PACKAGE_BYTES}-byte persistence budget; reduce the committed change or validation output before retrying review`,
    );
  }
  return normalized;
}
