/**
 * When a matching `stat` may stand in for a file's content. Shared by captures
 * (`capture.ts`) and the untracked line counts of a diff scan
 * (`local-git-scan-caches.ts`), so both follow one rule.
 */

/**
 * How old a file's timestamps must be, at the moment it is read, before its
 * stat stamp is trusted to identify its content. Filesystem timestamps are
 * coarse (a kernel tick on Linux, two seconds on FAT), so a second write in
 * the same tick with the same size leaves the stamp unchanged; Git calls such
 * an entry "racily clean" and re-hashes it. A file younger than this is read
 * on every pass until it ages past the window.
 */
export const STAT_SETTLE_WINDOW_MS = 2_000;

export function statStamp(info: {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}): string {
  return `${info.size}:${Math.trunc(info.mtimeMs * 1000)}:${Math.trunc(info.ctimeMs * 1000)}:${info.ino}`;
}

/** Whether a stamp taken at `at` is old enough to be trusted later. */
export function statSettled(
  info: { mtimeMs: number; ctimeMs: number },
  at: number,
  windowMs = STAT_SETTLE_WINDOW_MS,
): boolean {
  return at - Math.max(info.mtimeMs, info.ctimeMs) >= windowMs;
}
