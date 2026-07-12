/**
 * Format a number of seconds into a human-readable elapsed time string.
 *
 * Examples: "0s", "45s", "1m 30s", "12m 5s"
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}
