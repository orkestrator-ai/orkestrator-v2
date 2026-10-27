/**
 * Process-tree inspection and termination for owned preview workers.
 *
 * Playwright launches Chromium in its own process group, so killing the
 * worker's group is not enough; the supervisor enumerates descendants (and
 * the groups they lead) from `ps`, signals all of them, and verifies they are
 * gone before releasing capacity.
 */
import { execFile } from "node:child_process";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  rssKiB: number;
  zombie: boolean;
  /** Full command line; only listed when asked for (`listProcesses({ commands: true })`). */
  command?: string;
}

const PS_TIMEOUT_MS = 2_000;

export function listProcesses(options: { commands?: boolean } = {}): Promise<ProcessEntry[]> {
  const commands = options.commands === true;
  return new Promise((resolve) => {
    execFile(
      "ps",
      // `-ww` lifts the column limit so a long command line is not cut short.
      commands
        ? ["-A", "-ww", "-o", "pid=,ppid=,pgid=,rss=,stat=,command="]
        : ["-A", "-o", "pid=,ppid=,pgid=,rss=,stat="],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const entries: ProcessEntry[] = [];
        for (const line of stdout.split("\n")) {
          // Only the fixed ps columns are whitespace-delimited. The command
          // contains literal paths, whose internal whitespace must survive.
          const columns = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:[ \t]+(.*))?$/.exec(line);
          if (!columns) continue;
          const [pid, ppid, pgid, rss] = columns
            .slice(1, 5)
            .map((value) => Number.parseInt(value, 10));
          if (
            !pid ||
            ppid === undefined ||
            pgid === undefined ||
            rss === undefined ||
            [pid, ppid, pgid, rss].some(Number.isNaN)
          )
            continue;
          entries.push({
            pid,
            ppid,
            pgid,
            rssKiB: rss,
            zombie: (columns[5] ?? "").startsWith("Z"),
            ...(commands ? { command: columns[6] ?? "" } : {}),
          });
        }
        resolve(entries);
      },
    );
  });
}

/** Descendants of `roots` (inclusive), plus members of process groups led by any of them. */
export function collectTree(
  entries: readonly ProcessEntry[],
  roots: readonly number[],
): ProcessEntry[] {
  const byParent = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const list = byParent.get(entry.ppid) ?? [];
    list.push(entry);
    byParent.set(entry.ppid, list);
  }
  const found = new Map<number, ProcessEntry>();
  const queue = entries.filter((entry) => roots.includes(entry.pid));
  while (queue.length) {
    const entry = queue.shift()!;
    if (found.has(entry.pid)) continue;
    found.set(entry.pid, entry);
    queue.push(...(byParent.get(entry.pid) ?? []));
  }
  const leaders = new Set(
    Array.from(found.values())
      .filter((entry) => entry.pgid === entry.pid)
      .map((entry) => entry.pid),
  );
  for (const root of roots) leaders.add(root);
  for (const entry of entries) {
    if (leaders.has(entry.pgid) && !found.has(entry.pid) && entry.pgid > 1) {
      found.set(entry.pid, entry);
    }
  }
  return Array.from(found.values());
}

export function isAlive(pid: number, entries?: readonly ProcessEntry[]): boolean {
  if (entries) {
    const entry = entries.find((candidate) => candidate.pid === pid);
    return Boolean(entry && !entry.zombie);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone.
  }
}

export interface TreeKillReport {
  /** Every pid observed in the tree. */
  pids: number[];
  /** True when none of them remain alive (zombies count as exited). */
  verified: boolean;
}

/**
 * SIGKILL the tree rooted at `roots` (and groups those processes lead),
 * re-scanning until nothing remains or `verifyMs` elapses.
 *
 * `marker` is a string only an owned process can carry on its command line
 * (a job's private scratch path). Playwright starts Chromium in its own
 * process group, so a worker killed while it is still launching the browser
 * (before the supervisor has learnt the browser's pid) orphans it outside
 * both the tree and the owned groups; it then keeps writing its profile into
 * the scratch after the scratch was removed (0247). Processes carrying the
 * marker, with their trees, are owned too. The supervisor must put the marker
 * on the worker's argv before it can fork: a pre-exec child inherits that argv,
 * then the browser carries the marker in its profile argument after exec.
 * Two empty scans guard process-list churn; they cannot establish ownership
 * of a pre-exec child whose worker was launched without the marker.
 */
export async function killTree(
  roots: readonly number[],
  groups: readonly number[],
  verifyMs = 3_000,
  marker?: string,
): Promise<TreeKillReport> {
  // Only the original roots, the owned process groups and processes carrying
  // the marker are ever scanned: a recycled pid of an unrelated process is
  // never adopted as a new root.
  const ownedGroups = Array.from(new Set(groups.filter((group) => group > 1)));
  // ps renders tabs rather than emitting them literally: BSD uses an octal
  // escape, procps uses '?'. Keep the raw marker as well (literal backslashes
  // in paths must not be decoded or normalized).
  const renderedMarker = marker?.replace(/\t/g, process.platform === "darwin" ? "\\011" : "?");
  const owned = (entries: readonly ProcessEntry[]) => {
    const marked = marker
      ? entries
          .filter(
            (entry) =>
              entry.command?.includes(marker) ||
              (renderedMarker && entry.command?.includes(renderedMarker)),
          )
          .map((entry) => entry.pid)
      : [];
    const tree = new Map(
      collectTree(entries, [...roots, ...marked]).map((entry) => [entry.pid, entry]),
    );
    for (const entry of entries) if (ownedGroups.includes(entry.pgid)) tree.set(entry.pid, entry);
    return Array.from(tree.values());
  };
  const seen = new Set<number>();
  const deadline = Date.now() + verifyMs;
  let verified = false;
  let emptyScans = 0;
  for (;;) {
    const entries = await listProcesses({ commands: marker !== undefined });
    const remaining = owned(entries).filter((entry) => !entry.zombie);
    for (const entry of remaining) seen.add(entry.pid);
    for (const group of ownedGroups) signal(-group, "SIGKILL");
    for (const entry of remaining) signal(entry.pid, "SIGKILL");
    if (remaining.length === 0 && entries.length > 0) {
      emptyScans += 1;
      if (!marker || emptyScans >= 2) {
        verified = true;
        break;
      }
    } else emptyScans = 0;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { pids: Array.from(seen), verified };
}

/**
 * Resident memory of the tree, in bytes: the total and the largest process.
 * RSS counts shared pages (frameworks, shared memory) once per process, so
 * the total over-states real use for multi-process Chromium; callers apply
 * the hard limit to the largest process and a looser bound to the total.
 */
export async function treeResidentBytes(
  roots: readonly number[],
): Promise<{ total: number; largest: number }> {
  const entries = await listProcesses();
  let total = 0;
  let largest = 0;
  for (const entry of collectTree(entries, roots)) {
    const bytes = entry.rssKiB * 1024;
    total += bytes;
    largest = Math.max(largest, bytes);
  }
  return { total, largest };
}
