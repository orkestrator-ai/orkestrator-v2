/**
 * Process ownership checks for startup recovery of files a killed backend
 * left behind (preview scratch, design browser profiles). A PID alone is not
 * an identity, and a directory is only safe to remove once no live process
 * still names it.
 */
import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";

/** A process's start time, so a later process reusing its PID is not mistaken for it. */
export function processStartIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return startTicks ? `${boot}:${startTicks}` : null;
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 4096,
      env: { ...process.env, LC_ALL: "C" },
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the process recorded as `pid` with start identity `start` still
 * runs. An identity that cannot be read is not evidence the process exited.
 */
export function isRecordedProcessAlive(
  pid: number,
  start: string | null,
  alive: (pid: number) => boolean = isProcessAlive,
  identity: (pid: number) => string | null = processStartIdentity,
): boolean {
  if (!alive(pid)) return false;
  if (!start) return true;
  const current = identity(pid);
  return current === null || current === start;
}

const COMMAND_LINES_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The command lines of every visible live process, newline-separated, or
 * `null` when they cannot be read (callers then treat every path as in use).
 * Processes of other users, or in another PID namespace, may be invisible.
 */
export async function readLiveCommandLines(): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const lines: string[] = [];
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          lines.push((await readFile(`/proc/${entry}/cmdline`, "utf8")).replaceAll("\0", " "));
        } catch {
          // Exited during the scan, or not readable.
        }
      }
      return lines.join("\n");
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-axww", "-o", "args="],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: COMMAND_LINES_MAX_BYTES,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}
