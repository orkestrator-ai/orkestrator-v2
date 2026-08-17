/**
 * Persistence key for a Multi Review reviewer transcript's scroll state.
 *
 * A tiny standalone module because both sides of the lazy boundary need it:
 * the reviewer tab (inside the lazily loaded review chunk) persists scroll
 * state under it, and the pane's error boundary (in the main bundle) clears
 * that state on a view failure. Importing the tab module for the key alone
 * would pull the whole review surface into the main bundle.
 */
export function multiReviewReviewerScrollKey(
  workflowId: string,
  reviewerId: string,
): string {
  return `multi-review:${workflowId}:reviewer:${reviewerId}`;
}
