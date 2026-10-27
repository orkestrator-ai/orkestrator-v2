/**
 * Trial values for this client's data-saving preference (todo 0052). They are
 * experiment values, kept together so a measured change edits one place. Each
 * applies only while the preference is on and only to this client's reads;
 * invalidations, explicit refreshes, resume and reconnect still read at once.
 */

/**
 * Backstop poll of a running, blocked, cancelling or recovering native view
 * (500 ms without data saving). Approvals, completion and errors arrive
 * through observation invalidations either way.
 */
export const DATA_SAVING_ACTIVE_PROJECTION_REFRESH_MS = 1_000;

/**
 * Quiet backoff of the open Files panel's 5 s poll on a watched worktree,
 * whose list and tree revisions are announced and re-read at once.
 */
export const FILES_PANEL_DATA_SAVING_BACKOFF_MS: readonly number[] = [10_000, 15_000, 30_000];

/** The same for an unwatched target (container, failed watcher, older backend): only the poll. */
export const FILES_PANEL_DATA_SAVING_UNWATCHED_BACKOFF_MS: readonly number[] = [10_000];

/** Quiet backoff of a reviewer tab's 4 s backstop poll; checkpoints still read at once. */
export const REVIEWER_DATA_SAVING_BACKOFF_MS: readonly number[] = [8_000, 15_000, 30_000];
