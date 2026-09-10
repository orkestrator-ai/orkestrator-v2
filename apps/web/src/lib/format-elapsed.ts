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

/**
 * The same shape, with an hour unit once the value earns one.
 *
 * Background tasks and delegated agents routinely outlive the turn that
 * launched them, and `formatElapsed` reports those in minutes alone — "185m 3s"
 * is a number the reader has to divide before it means anything. Deliberately a
 * second function rather than a change to the first: the session timer and the
 * review tabs measure one turn, and minute-only output is the contract their
 * callers already read.
 *
 * Examples: "0s", "45s", "1m 30s", "59m 59s", "1h 0m 0s", "3h 5m 1s"
 */
export function formatElapsedWithHours(seconds: number): string {
  if (seconds < 3600) return formatElapsed(seconds);
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${mins}m ${secs}s`;
}
