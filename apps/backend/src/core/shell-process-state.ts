import { readdirSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";

/**
 * What the kernel knows about a command's processes, for `runCommand`. Bun 1.4.4
 * can lose a child's exit on macOS, leaving it a zombie nothing reaps
 * (docs/tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md),
 * and a zombie still counts as a member of its process group. All of this is
 * synchronous and runs only once a command has outlived the common path.
 */
export type CommandExit = { code: number | null; signal: NodeJS.Signals | null };

export function decodeWaitStatus(status: number): CommandExit {
  const signalNumber = status & 0x7f;
  if (signalNumber === 0) return { code: (status >> 8) & 0xff, signal: null };
  const name = Object.entries(osConstants.signals).find(([, value]) => value === signalNumber)?.[0];
  return { code: null, signal: (name ?? "SIGKILL") as NodeJS.Signals };
}

/**
 * The exit of a macOS child that has died unreaped, read from `ps`'s `xstat`, the
 * wait status in hex. `undefined` while it runs, and whenever `ps` cannot say.
 */
export function readZombieExit(pid: number): CommandExit | undefined {
  try {
    const { stdout } = Bun.spawnSync(["/bin/ps", "-o", "stat=,xstat=", "-p", String(pid)]);
    const match = /^Z\S*\s+([0-9a-f]+)\s*$/i.exec(stdout.toString().trim());
    return match ? decodeWaitStatus(Number.parseInt(match[1]!, 16)) : undefined;
  } catch {
    return undefined;
  }
}

function isLiveMember(state: string | undefined, groupId: string | undefined, pgid: number) {
  return Number(groupId) === pgid && state !== undefined && !/^[ZX]/.test(state);
}

function linuxGroupHasLiveMember(pgid: number): boolean {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "latin1");
    } catch {
      continue; // It exited during the scan.
    }
    // The command name can hold spaces and parentheses, so count from the last ")".
    const [state, , groupId] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (isLiveMember(state, groupId, pgid)) return true;
  }
  return false;
}

function psGroupHasLiveMember(pgid: number): boolean {
  const { stdout, success } = Bun.spawnSync(["/bin/ps", "-A", "-o", "pgid=,stat="]);
  if (!success) return true;
  return stdout
    .toString()
    .split("\n")
    .some((line) => {
      const [groupId, state] = line.trim().split(/\s+/);
      return isLiveMember(state, groupId, pgid);
    });
}

/**
 * Whether anything still runs in a process group, not counting zombies: an orphan
 * under an init that does not reap stays one forever. An unknown answer is yes.
 */
export function groupHasLiveMember(pgid: number): boolean {
  try {
    return process.platform === "linux"
      ? linuxGroupHasLiveMember(pgid)
      : psGroupHasLiveMember(pgid);
  } catch {
    return true;
  }
}
