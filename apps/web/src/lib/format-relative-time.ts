/**
 * Relative-time formatting shared by the session pickers.
 *
 * Previously copy-pasted into every resume dialog (native Claude, Codex,
 * OpenCode and Claude tmux), which is how they drifted apart on what counts as
 * "recent". Keep the thresholds here so all four agree.
 *
 * Note: `components/docker/docker-stats-format.ts` has its own, deliberately
 * different formatter for container uptime — it is not a duplicate of this one.
 */

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const WEEK_SECONDS = 7 * DAY_SECONDS;

/**
 * Format the age of `date` relative to `now`.
 *
 * Falls back to a locale date string once the age passes a week, and returns
 * "unknown" for a missing or unparseable input rather than rendering
 * "NaNm ago".
 */
export function formatRelativeTime(
  value: string | number | Date | null | undefined,
  now: Date = new Date(),
): string {
  const date = toDate(value);
  if (!date) return "unknown";

  const ageSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));

  if (ageSeconds < MINUTE_SECONDS) return "just now";
  if (ageSeconds < HOUR_SECONDS) {
    return `${Math.floor(ageSeconds / MINUTE_SECONDS)}m ago`;
  }
  if (ageSeconds < DAY_SECONDS) {
    return `${Math.floor(ageSeconds / HOUR_SECONDS)}h ago`;
  }
  if (ageSeconds < WEEK_SECONDS) {
    return `${Math.floor(ageSeconds / DAY_SECONDS)}d ago`;
  }
  return date.toLocaleDateString();
}

/**
 * Compact age labels for dense pickers (the project/environment search palette).
 *
 * Uses the same thresholds as `formatRelativeTime` so "4d" and "4d ago" never
 * disagree about when a day starts. Missing or unparseable input returns an
 * empty string so the caller can omit the age rather than render "unknown".
 */
export function formatCompactRelativeTime(
  value: string | number | Date | null | undefined,
  now: Date = new Date(),
): string {
  const date = toDate(value);
  if (!date) return "";

  const ageSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));

  if (ageSeconds < MINUTE_SECONDS) return "now";
  if (ageSeconds < HOUR_SECONDS) {
    return `${Math.floor(ageSeconds / MINUTE_SECONDS)}m`;
  }
  if (ageSeconds < DAY_SECONDS) {
    return `${Math.floor(ageSeconds / HOUR_SECONDS)}h`;
  }
  if (ageSeconds < WEEK_SECONDS) {
    return `${Math.floor(ageSeconds / DAY_SECONDS)}d`;
  }
  return date.toLocaleDateString();
}

/**
 * Same formatting, for the tmux backend's Unix-seconds timestamps.
 *
 * Kept as a named helper rather than making callers remember to multiply by
 * 1000 — the tmux dialog got this wrong-by-omission risk for free before.
 */
export function formatRelativeTimeFromUnixSeconds(
  unixSeconds: number | null | undefined,
  now: Date = new Date(),
): string {
  if (!unixSeconds) return "unknown";
  return formatRelativeTime(new Date(unixSeconds * 1000), now);
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
