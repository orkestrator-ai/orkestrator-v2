import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Identity = { pid: number; parent: number; stamp: string };

async function processes(): Promise<Identity[]> {
  if (process.platform === "win32") return [];
  const { stdout } = await exec("ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,command="], {
    timeout: 2_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), stamp: match[3]! }] : [];
  });
}

/** How long an agent tree gets to exit on SIGTERM before it is killed. */
export const DEFAULT_TERM_GRACE_MS = 2_000;

/**
 * `ACP_TERM_GRACE_MS` shortens the grace for tests that close a TERM-resistant
 * descendant on purpose. It can only shorten it: anything unset, invalid or
 * below 10 ms keeps the default, and a value above the default is capped at it.
 */
export function termGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.ACP_TERM_GRACE_MS);
  return env.ACP_TERM_GRACE_MS !== undefined && Number.isSafeInteger(parsed) && parsed >= 10
    ? Math.min(DEFAULT_TERM_GRACE_MS, parsed)
    : DEFAULT_TERM_GRACE_MS;
}

/** Close one agent without signalling the bridge's shared process group. */
export async function terminateAcpProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // Capture ownership while the leader still parents its tree. Keep identity
  // (start time and exact command) so a recycled PID is never signalled later.
  const table = await processes().catch(() => []);
  const owned = new Map<number, Identity>();
  const parents = new Set([child.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of table) {
      if (parents.has(entry.parent) && !parents.has(entry.pid)) {
        owned.set(entry.pid, entry);
        parents.add(entry.pid);
        changed = true;
      }
    }
  }
  const signal = (kind: "SIGTERM" | "SIGKILL", table: Identity[]) => {
    const current = new Map(table.map((entry) => [entry.pid, entry]));
    for (const entry of Array.from(owned.values()).reverse()) {
      if (current.get(entry.pid)?.stamp !== entry.stamp) continue;
      try {
        process.kill(entry.pid, kind);
      } catch {
        // Already gone.
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(kind);
      } catch {
        /* Already gone. */
      }
    }
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (
        (child.exitCode !== null || child.signalCode !== null) &&
        !Array.from(owned.keys()).some(alive)
      )
        return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  signal("SIGTERM", table);
  // The leader can exit first. Its exit must not cancel escalation for an MCP
  // server or terminal that ignored SIGTERM and has since been reparented.
  if (await wait(termGraceMs())) return;
  signal("SIGKILL", await processes().catch(() => []));
  await wait(1_000);
}
