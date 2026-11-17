/**
 * How long each of the host's CPUs has been awake, for the event-loop stall
 * monitor's host-sleep check (`event-loop-stall-monitor.ts`, `hostCpuTimes`).
 *
 * A CPU's time counters (user, system, idle, I/O wait and the rest) advance
 * only while the machine runs. While it sleeps nothing counts, whereas a
 * timer's lateness, measured on a monotonic clock that counts sleep (macOS's
 * `CLOCK_MONOTONIC` does), grows by the whole sleep. Comparing the two is what
 * tells a host that slept from a process that was held.
 *
 * Linux reads `/proc/stat` directly, because `os.cpus()` leaves I/O wait, soft
 * interrupts and steal out of its totals: a CPU waiting on a disk would look
 * like a CPU that was asleep, which is exactly the stall this must not hide.
 * Elsewhere `os.cpus()` already counts every state.
 */
import { readFileSync } from "node:fs";
import { cpus } from "node:os";

/** Linux reports `/proc/stat` in USER_HZ ticks, 100 a second on every supported kernel. */
const LINUX_TICK_MS = 10;

/**
 * Milliseconds each CPU has spent in any state since boot, one entry per
 * online CPU, or null when they cannot be read. Never throws.
 */
export function readHostCpuTimes(
  platform: NodeJS.Platform = process.platform,
  readProcStat: () => string = () => readFileSync("/proc/stat", "utf8"),
  readCpus: () => ReturnType<typeof cpus> = cpus,
): number[] | null {
  try {
    if (platform === "linux") return parseProcStat(readProcStat());
    const list = readCpus();
    if (list.length === 0) return null;
    return list.map(({ times }) => times.user + times.nice + times.sys + times.idle + times.irq);
  } catch {
    return null;
  }
}

/** Per-CPU totals from `/proc/stat`'s `cpuN` lines; the aggregate `cpu` line is skipped. */
export function parseProcStat(text: string): number[] | null {
  const totals: number[] = [];
  for (const line of text.split("\n")) {
    if (!/^cpu\d+ /.test(line)) continue;
    // user nice system idle iowait irq softirq steal; guest time is already in user.
    const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
    if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) return null;
    totals.push(fields.reduce((sum, value) => sum + value, 0) * LINUX_TICK_MS);
  }
  return totals.length > 0 ? totals : null;
}
