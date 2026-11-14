/**
 * Pure helpers for `failed-turn-bell-live.spec.ts` (to-do 5160 task 4): which
 * platforms and cases a run selects, and which process of the profile's
 * backend tree is a platform's bridge. Nothing here runs at import time or
 * signals a process.
 */

export const BELL_PLATFORMS = ["claude", "codex", "pi", "opencode"] as const;
export type BellPlatform = (typeof BELL_PLATFORMS)[number];

/**
 * - `refused`: a turn the loopback model refuses (401) rings `agent_failed`,
 *   and opening the environment shows "Agent stopped with an error".
 * - `stop`: a held turn stopped by the user never rings `agent_failed`; it
 *   rings `agent_finished`, as `native-agent-failed-turn-attention.test.ts`
 *   pins for every bridge (only a goal's own Stop rings nothing).
 * - `bridge-kill`: a held turn whose bridge is killed rings `agent_failed`.
 * - `restart`: a held turn across a killed and restarted backend (its local
 *   bridge goes with it) rings `agent_failed`.
 */
export const BELL_CASES = ["refused", "stop", "bridge-kill", "restart"] as const;
export type BellCase = (typeof BELL_CASES)[number];

function selection<T extends string>(
  value: string | undefined,
  known: readonly T[],
  what: string,
): T[] {
  if (!value?.trim()) return [...known];
  const picked = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = picked.filter((entry) => !known.includes(entry as T));
  if (unknown.length) throw new Error(`unknown ${what}: ${unknown.join(", ")}`);
  // Keep the documented order whatever order the list was given in.
  return known.filter((entry) => picked.includes(entry));
}

export function bellPlatforms(value: string | undefined): BellPlatform[] {
  return selection(value, BELL_PLATFORMS, "platform");
}

export function bellCases(value: string | undefined): BellCase[] {
  return selection(value, BELL_CASES, "case");
}

export type ProcessRow = { pid: number; ppid: number; command: string };

/** `ps -ww -o pid=,ppid=,command=` output, one row per line. */
export function parseProcessRows(output: string): ProcessRow[] {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
}

/** Every process below `root`, breadth first. */
export function descendantsOf(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const found: ProcessRow[] = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const row of rows) {
      if (row.ppid === parent) {
        found.push(row);
        queue.push(row.pid);
      }
    }
  }
  return found;
}

/**
 * The PID the backend logged for an environment's bridge
 * (`[local-server] bridge.started key=<platform>:<environmentId> pid=<pid>`),
 * the latest one when it was restarted. Several environments' bridges run
 * under one backend, so the log, not the process table, says whose it is.
 */
export function loggedBridgePid(
  log: string,
  platform: BellPlatform,
  environmentId: string,
): number | undefined {
  const key = `${platform}:${environmentId}`;
  let found: number | undefined;
  for (const match of log.matchAll(/bridge\.started key=(\S+) pid=(\d+)/g)) {
    if (match[1] === key) found = Number(match[2]);
  }
  return found;
}

/**
 * The row for `pid`, only when it is a bridge of this checkout (OpenCode: an
 * `opencode serve` process) below the profile's backend. Bridges run under a
 * `/bin/sh -c` lifetime wrapper that only forwards signals, so a wrapper is
 * never accepted in the bridge's place.
 */
export function bridgeProcess(
  rows: readonly ProcessRow[],
  backendPid: number,
  platform: BellPlatform,
  repositoryRoot: string,
  pid: number,
): ProcessRow | undefined {
  const row = descendantsOf(rows, backendPid).find((candidate) => candidate.pid === pid);
  if (!row || /^(\/usr)?\/bin\/sh\b/.test(row.command)) return undefined;
  if (platform === "opencode") {
    return /\bopencode2?\b/.test(row.command) && /\bserve\b/.test(row.command) ? row : undefined;
  }
  return row.command.includes(`${repositoryRoot}/bridges/${platform}-bridge/`) ? row : undefined;
}

/** What a case expects of the environment's bell once its turn has ended. */
export function expectedUnread(kind: BellCase): "agent_failed" | "agent_finished" {
  return kind === "stop" ? "agent_finished" : "agent_failed";
}

/** The toast title `environmentUnreadToast.tsx` shows for each expected reason. */
export const TOAST_TITLES = {
  agent_failed: "Agent stopped with an error",
  agent_finished: "Agent finished",
} as const;
