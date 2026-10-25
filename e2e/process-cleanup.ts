import { spawnSync, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Preserve the journey failure and every cleanup failure, while attempting all cleanups. */
export async function withCleanup(work: () => Promise<void>, cleanups: Array<() => Promise<void>>) {
  const errors: unknown[] = [];
  try {
    await work();
  } catch (error) {
    errors.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Journey and cleanup failures");
}

export function processAlive(pid: number): boolean {
  if (pid < 0) {
    // Group existence alone does not prove a live member remains. Enumerate
    // members, excluding zombies which cannot use the profile.
    const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: 5_000 });
    if (result.status !== 0) throw new Error("Could not enumerate owned process group");
    return result.stdout.split("\n").some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === -pid && state && !state.startsWith("Z");
    });
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export async function waitForStopped(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processAlive)) {
    if (Date.now() >= deadline) throw new Error("Owned processes did not exit");
    await delay(25);
  }
}

export function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    if (pid < 0 && (error as NodeJS.ErrnoException).code === "EPERM" && !processAlive(pid)) return;
    throw new Error(`Could not send ${signal} to owned process ${pid}`, { cause: error });
  }
}

/**
 * Detached process groups this process still has to stop. A spec's own
 * `finally` cannot be relied on: when a test times out Playwright abandons the
 * test body, so its `finally` never runs and a detached group keeps its port.
 */
const ownedGroups = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Only for children spawned with detached:true. Also handles an already-exited
 * leader. Ownership recorded by {@link ownProcessGroup} ends once the group is
 * confirmed stopped; a group that could not be stopped stays owned.
 */
export async function stopProcessGroup(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (!child.pid) return;
  const group = -child.pid;
  if (processAlive(group)) {
    signalProcess(group, "SIGTERM");
    try {
      await waitForStopped([group], timeoutMs);
    } catch {
      signalProcess(group, "SIGKILL");
      await waitForStopped([group], timeoutMs);
    }
  }
  // Let the runtime reap the leader as well as observing the group's live members.
  await waitForStopped([child.pid], timeoutMs);
  ownedGroups.delete(child);
}

/**
 * Record a child spawned with `detached: true` as owned until
 * {@link stopProcessGroup} has stopped it. Whatever is still owned is stopped
 * by {@link stopOwnedProcessGroups} (the Electron specs' worker fixture) and,
 * as a last resort, killed synchronously when this process exits.
 */
export function ownProcessGroup<T extends ChildProcess>(child: T): T {
  if (!child.pid) return child;
  ownedGroups.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", killOwnedProcessGroupsSync);
  }
  return child;
}

/** Process ids of the owned groups' leaders, in ownership order. */
export function ownedProcessGroupLeaders(): number[] {
  return [...ownedGroups].map((child) => child.pid!);
}

/**
 * SIGKILL every owned group. Synchronous because `exit` listeners cannot wait;
 * there is no graceful phase left at that point.
 */
export function killOwnedProcessGroupsSync(): void {
  for (const child of ownedGroups) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone: nothing left to stop.
    }
  }
  ownedGroups.clear();
}

/** Stop every owned group, attempting all of them and reporting each failure. */
export async function stopOwnedProcessGroups(timeoutMs = 5_000): Promise<void> {
  const errors: unknown[] = [];
  // Deleting the entry being visited (a stopped group) is safe during iteration.
  for (const child of ownedGroups) {
    try {
      await stopProcessGroup(child, timeoutMs);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Owned process groups did not stop");
}
