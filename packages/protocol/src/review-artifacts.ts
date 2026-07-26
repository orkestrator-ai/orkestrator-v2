/**
 * The deterministic on-disk layout of a looped-review round's validation
 * evidence.
 *
 * Both halves of the contract are derived from here on purpose. The preparation
 * prompt tells the agent exactly where to write each artifact, and the backend
 * recomputes the same paths to decide whether to trust what the agent reported.
 * When the two descriptions drifted apart, a round failed on paths that named
 * the right files.
 */

export const REVIEW_ARTIFACT_ROOT = ".orkestrator/review-artifacts";

export function reviewArtifactDirectory(packageId: string): string {
  return `${REVIEW_ARTIFACT_ROOT}/${packageId}`;
}

/**
 * The ordinal is the entry's 1-based position in the returned `validation`
 * array, counting skipped commands, so entry N always uses ordinal N. Numbering
 * by execution order instead would shift every artifact after a skipped command.
 */
export function reviewValidationArtifactOrdinal(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function reviewValidationArtifactPaths(
  packageId: string,
  index: number,
): { stdoutPath: string; stderrPath: string } {
  const directory = reviewArtifactDirectory(packageId);
  const ordinal = reviewValidationArtifactOrdinal(index);
  return {
    stdoutPath: `${directory}/validation-${ordinal}.stdout.txt`,
    stderrPath: `${directory}/validation-${ordinal}.stderr.txt`,
  };
}
