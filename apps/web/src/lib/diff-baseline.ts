/**
 * Re-export of the shared baseline resolver.
 *
 * The definition lives in `@orkestrator/protocol/diff-stats` because the backend
 * computes the counts and the frontend labels them: two copies of the fallback
 * chain drifted once already, and a badge measured against a different ref than
 * the panel it opens is invisible until someone compares the numbers.
 */
export { FALLBACK_COMPARISON_REF, resolveComparisonRef } from "@orkestrator/protocol/diff-stats";
