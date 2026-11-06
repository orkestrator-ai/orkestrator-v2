import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { runCommand } from "./shell.js";

export type ProcessTreeSignal = "SIGTERM" | "SIGKILL";

export type ProcessTreeChild = Pick<ChildProcessWithoutNullStreams, "pid" | "exitCode" | "kill"> & {
  /** Bun reports a signal with no name (e.g. a Linux real-time signal) by its number. */
  readonly signalCode: NodeJS.Signals | number | null;
};

export type ProcessTreeRuntime = {
  listDescendants: (rootPid: number) => Promise<number[]>;
  signalGroup: (rootPid: number, signal: ProcessTreeSignal) => void;
  signalPid: (pid: number, signal: ProcessTreeSignal) => void;
  signalChild: (child: ProcessTreeChild, signal: ProcessTreeSignal) => void;
  isPidRunning: (pid: number) => boolean;
  now: () => number;
  sleep: (timeoutMs: number) => Promise<void>;
};

export type TerminateProcessTreeOptions = {
  graceMs: number;
  killWaitMs: number;
  pollIntervalMs?: number;
  runtime?: ProcessTreeRuntime;
};

function processHasExited(child: ProcessTreeChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function parseProcessTable(output: string, rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants: number[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

export async function listDescendantProcessIds(rootPid: number): Promise<number[]> {
  if (process.platform === "win32") return [];
  const { stdout } = await runCommand("ps", ["-A", "-o", "pid=,ppid="], { timeoutMs: 2_000 });
  return parseProcessTable(stdout, rootPid);
}

function signalPid(pid: number, signal: ProcessTreeSignal): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process exited after the snapshot or is no longer signalable.
  }
}

const defaultRuntime: ProcessTreeRuntime = {
  listDescendants: listDescendantProcessIds,
  signalGroup: (rootPid, signal) => {
    if (process.platform === "win32") return;
    signalPid(-rootPid, signal);
  },
  signalPid,
  signalChild: (child, signal) => {
    try {
      child.kill(signal);
    } catch {
      // The direct child is already gone.
    }
  },
  isPidRunning: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
  now: Date.now,
  sleep: (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs)),
};

async function snapshotDescendants(
  rootPid: number | undefined,
  runtime: ProcessTreeRuntime,
): Promise<number[]> {
  if (!rootPid) return [];
  return runtime.listDescendants(rootPid).catch(() => []);
}

function signalTree(
  child: ProcessTreeChild,
  descendants: ReadonlySet<number>,
  signal: ProcessTreeSignal,
  runtime: ProcessTreeRuntime,
): void {
  const rootPid = child.pid;
  if (rootPid) runtime.signalGroup(rootPid, signal);
  // Signal deepest descendants first so a parent cannot orphan a child before
  // the child's PID has been targeted. The process-group signal covers the
  // common case; explicit PIDs also cover descendants that created new groups.
  for (const pid of [...descendants].reverse()) runtime.signalPid(pid, signal);
  runtime.signalChild(child, signal);
}

async function waitForTreeExit(
  child: ProcessTreeChild,
  descendants: ReadonlySet<number>,
  timeoutMs: number,
  pollIntervalMs: number,
  runtime: ProcessTreeRuntime,
): Promise<boolean> {
  const deadline = runtime.now() + Math.max(0, timeoutMs);
  while (true) {
    const childExited = processHasExited(child);
    const descendantsExited = [...descendants].every((pid) => !runtime.isPidRunning(pid));
    if (childExited && descendantsExited) return true;
    const remaining = deadline - runtime.now();
    if (remaining <= 0) return false;
    await runtime.sleep(Math.min(pollIntervalMs, remaining));
  }
}

/**
 * Terminates a backend-owned process tree. Descendant PIDs are snapshotted
 * before signalling so children that become reparented when the bridge exits
 * remain targetable, including descendants that created their own process group.
 */
export async function terminateProcessTree(
  child: ProcessTreeChild,
  options: TerminateProcessTreeOptions,
): Promise<boolean> {
  // A failed spawn (a missing executable, say) never gets a pid, and Bun leaves
  // `exitCode` null for it where Node reports a negative errno. There is nothing
  // to signal, so waiting out the grace period would only report a process that
  // never existed as one that would not die.
  if (child.pid === undefined) return true;

  const runtime = options.runtime ?? defaultRuntime;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 25);
  const descendants = new Set(await snapshotDescendants(child.pid, runtime));

  if (processHasExited(child) && descendants.size === 0) return true;

  signalTree(child, descendants, "SIGTERM", runtime);
  if (await waitForTreeExit(child, descendants, options.graceMs, pollIntervalMs, runtime)) {
    return true;
  }

  for (const pid of await snapshotDescendants(child.pid, runtime)) descendants.add(pid);
  signalTree(child, descendants, "SIGKILL", runtime);
  return waitForTreeExit(child, descendants, options.killWaitMs, pollIntervalMs, runtime);
}

/** Signals a process group; false only when no process is left in it. `0` probes. */
export type ProcessGroupSignaller = (pgid: number, signal: ProcessTreeSignal | 0) => boolean;

export type ReapProcessGroupOptions = {
  graceMs: number;
  killWaitMs: number;
  pollIntervalMs?: number;
  signalGroup?: ProcessGroupSignaller;
  now?: () => number;
  sleep?: (timeoutMs: number) => Promise<void>;
};

const signalGroupDefault: ProcessGroupSignaller = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    // EPERM still means the group has members, just not ones this user may signal.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/**
 * Stops what is left of a process group whose leader has already exited.
 *
 * `terminateProcessTree` finds descendants by parent pid, so it only works
 * while the leader is alive: once a bridge dies on its own, its agent CLI is
 * reparented and no snapshot can reach it, but it is still in the bridge's
 * group. Only call this for a group the caller created (a `detached` spawn).
 * A group with no members left answers ESRCH, and Linux does not reuse a pid
 * while it still names a live group, so an empty group is never mistaken for
 * someone else's process.
 */
export async function reapProcessGroup(
  pgid: number | undefined,
  options: ReapProcessGroupOptions,
): Promise<"empty" | "stopped" | "survived"> {
  if (!pgid || pgid <= 1 || process.platform === "win32") return "empty";
  const signal = options.signalGroup ?? signalGroupDefault;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((timeoutMs: number) => new Promise((resolve) => setTimeout(resolve, timeoutMs)));
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const drained = async (timeoutMs: number) => {
    const deadline = now() + Math.max(0, timeoutMs);
    while (signal(pgid, 0)) {
      const remaining = deadline - now();
      if (remaining <= 0) return false;
      await sleep(Math.min(pollIntervalMs, remaining));
    }
    return true;
  };
  if (!signal(pgid, "SIGTERM")) return "empty";
  if (await drained(options.graceMs)) return "stopped";
  if (!signal(pgid, "SIGKILL")) return "stopped";
  return (await drained(options.killWaitMs)) ? "stopped" : "survived";
}
