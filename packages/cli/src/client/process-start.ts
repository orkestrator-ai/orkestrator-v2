import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * When a process started, in epoch milliseconds, or null when it cannot be
 * read (no such process, an unsupported platform, unreadable `/proc`, `ps`
 * failing or printing something unexpected).
 *
 * A pid alone does not identify a process: once a backend exits, its pid can
 * be handed to a later process of the same user. Comparing this with the
 * `startedAt` the backend wrote into its descriptor tells the two apart.
 */
export type ProcessStartReader = (pid: number) => Promise<number | null>;

export interface ProcessStartSources {
  platform: NodeJS.Platform;
  readText(file: string): Promise<string>;
  /** Runs `ps` with these arguments; resolves its stdout, rejects on any failure. */
  runPs(args: string[]): Promise<string>;
}

// The kernel reports start times to user space in USER_HZ ticks, which is 100
// on every architecture Linux runs Node on (it is fixed by the ABI, not by
// the kernel's own CONFIG_HZ).
const LINUX_USER_HZ = 100;
const PS_TIMEOUT_MS = 2_000;

/** Only absolute paths, so a planted `ps` earlier on PATH is never run. */
const PS_PATH = "/bin/ps";

const defaultSources: ProcessStartSources = {
  platform: process.platform,
  readText: (file) => readFile(file, "utf8"),
  runPs: (args) =>
    new Promise((resolve, reject) => {
      execFile(
        PS_PATH,
        args,
        {
          encoding: "utf8",
          timeout: PS_TIMEOUT_MS,
          maxBuffer: 4096,
          // A fixed locale and UTC make `lstart` parseable without guessing.
          env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    }),
};

export function createProcessStartReader(
  sources: ProcessStartSources = defaultSources,
): ProcessStartReader {
  return async (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      if (sources.platform === "linux") return await linuxStartTime(pid, sources);
      if (sources.platform === "darwin") {
        return parsePsLstart(await sources.runPs(["-o", "lstart=", "-p", String(pid)]));
      }
    } catch {
      // Unreadable is reported as null; the caller decides what that means.
    }
    return null;
  };
}

export const readProcessStartTime: ProcessStartReader = createProcessStartReader();

async function linuxStartTime(pid: number, sources: ProcessStartSources): Promise<number | null> {
  const ticks = parseProcStatStartTicks(await sources.readText(`/proc/${pid}/stat`));
  const bootSeconds = parseProcStatBootTime(await sources.readText("/proc/stat"));
  if (ticks === null || bootSeconds === null) return null;
  return bootSeconds * 1000 + Math.round((ticks * 1000) / LINUX_USER_HZ);
}

/**
 * Field 22 (`starttime`) of `/proc/<pid>/stat`, in ticks since boot. The
 * command name (field 2) is parenthesised and may itself contain spaces or
 * parentheses, so fields are counted from the last `)`.
 */
export function parseProcStatStartTicks(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const value = stat
    .slice(close + 2)
    .split(" ")
    .at(19);
  if (!value || !/^\d+$/.test(value)) return null;
  const ticks = Number(value);
  return Number.isSafeInteger(ticks) ? ticks : null;
}

/** The `btime` line of `/proc/stat`: boot time in seconds since the epoch. */
export function parseProcStatBootTime(stat: string): number | null {
  const match = /^btime (\d+)$/m.exec(stat);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `ps -o lstart=` under `LC_ALL=C TZ=UTC0`, such as `Thu Nov  5 16:35:38 2026`.
 * Parsed by hand as UTC: `Date.parse` would read it in the local zone.
 */
export function parsePsLstart(output: string): number | null {
  const match = /^[A-Z][a-z]{2} +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
    output.trim(),
  );
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  const [day, hours, minutes, seconds, year] = match.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const time = Date.UTC(year, month, day, hours, minutes, seconds);
  return Number.isFinite(time) ? time : null;
}
