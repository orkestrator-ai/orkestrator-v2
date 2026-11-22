/**
 * Whether a backend run ended because its host stopped (a power loss, a freeze
 * or a forced restart) rather than on its own. Shared by the backend's own
 * `previous-run` line (`health-summary.ts`) and self-improvement's reading of a
 * bundle's health rows (`self-improvement/signals.ts`), so both draw the line in
 * the same place. Pure: no I/O.
 *
 * A boot time is the wall clock less the host's uptime, so it moves when the
 * clock is stepped. Two boot times this close together are read as one boot
 * seen through a stepped clock (NTP correcting a drifted clock after a boot
 * moves it by seconds to minutes), not as a restart.
 */
export const SAME_BOOT_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * True when one of `laterBootTimes` is after the run's last row (`lastAt`), and
 * is not the run's own boot (`runBootAt`, when it recorded one) seen through a
 * stepped clock.
 *
 * Most errors leave a host restart counted as a crash: a clock stepped back
 * after the boot, or a run lost within the tolerance of its own boot. The
 * reverse needs the clock stepped forward on the same boot, after the run's
 * last row, by more than the tolerance (or, for a run that recorded no boot
 * time, by more than the time from the boot to that row).
 */
export function hostRestartedAfter(
  lastAt: number,
  runBootAt: number | null | undefined,
  laterBootTimes: Iterable<number | null | undefined>,
): boolean {
  for (const bootAt of laterBootTimes) {
    if (typeof bootAt !== "number" || !Number.isFinite(bootAt) || bootAt <= lastAt) continue;
    if (typeof runBootAt === "number" && Math.abs(bootAt - runBootAt) < SAME_BOOT_TOLERANCE_MS) {
      continue;
    }
    return true;
  }
  return false;
}
