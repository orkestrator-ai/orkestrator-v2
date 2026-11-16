/**
 * Pure helpers for `failed-turn-bell-live.spec.ts` (to-do 5160 (retired) task 4): which
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

/**
 * Where the bell environment runs (`ORKESTRATOR_AGENT_TEST_BELL_ENVIRONMENT`).
 * `container` is to-do 5160 (retired) task 6: a container's bridge outlives a backend
 * restart, so the restarted backend must read the turn's end from the bridge.
 */
export type BellEnvironment = "local" | "container";

/** A container run covers native Claude only, the platform its fake serves. */
export const CONTAINER_BELL_PLATFORMS = ["claude"] as const satisfies readonly BellPlatform[];
/** `bridge-kill` signals a host process, so a container run cannot select it. */
export const CONTAINER_BELL_CASES = [
  "refused",
  "stop",
  "restart",
] as const satisfies readonly BellCase[];

export function bellEnvironment(value: string | undefined): BellEnvironment {
  const picked = value?.trim() || "local";
  if (picked !== "local" && picked !== "container") {
    throw new Error(`unknown bell environment: ${picked}`);
  }
  return picked;
}

/**
 * The platforms and cases a run selects. A local run defaults to all of
 * them; a container run defaults to Claude's `restart` case, the one only a
 * container can show, and refuses what it cannot run.
 */
export function bellSelection(
  environment: BellEnvironment,
  platforms: string | undefined,
  cases: string | undefined,
): { platforms: BellPlatform[]; cases: BellCase[] } {
  if (environment === "local") {
    return { platforms: bellPlatforms(platforms), cases: bellCases(cases) };
  }
  const pickedPlatforms = platforms?.trim() ? bellPlatforms(platforms) : ["claude" as const];
  const pickedCases = cases?.trim() ? bellCases(cases) : ["restart" as const];
  const platformAllowed = (entry: BellPlatform) =>
    (CONTAINER_BELL_PLATFORMS as readonly BellPlatform[]).includes(entry);
  const caseAllowed = (entry: BellCase) =>
    (CONTAINER_BELL_CASES as readonly BellCase[]).includes(entry);
  const badPlatforms = pickedPlatforms.filter((entry) => !platformAllowed(entry));
  if (badPlatforms.length) {
    throw new Error(`a container bell run cannot cover: ${badPlatforms.join(", ")}`);
  }
  const badCases = pickedCases.filter((entry) => !caseAllowed(entry));
  if (badCases.length) {
    throw new Error(`a container bell run cannot run: ${badCases.join(", ")}`);
  }
  return { platforms: pickedPlatforms, cases: pickedCases };
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

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

/**
 * The profile's Claude `settings.json` for a `claude-tmux` refused-login run
 * (to-do 5160 (retired) task 7): the loopback model's address and a bearer token rather
 * than an API key, because an interactive CLI stops at a "use this API key?"
 * question for `ANTHROPIC_API_KEY` and asks nothing for a token. Every other
 * key the file holds (hooks above all) is kept.
 */
export function refusedLoginTmuxSettings(earlier: unknown, origin: string): JsonObject {
  const settings = asObject(earlier);
  const { ANTHROPIC_API_KEY: _apiKey, ...env } = asObject(settings.env) as Record<string, string>;
  return {
    ...settings,
    env: {
      ...env,
      ANTHROPIC_BASE_URL: origin,
      ANTHROPIC_AUTH_TOKEN: "fixture-only-not-a-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    skipDangerousModePermissionPrompt: true,
  };
}

/**
 * The profile's Claude `.claude.json` with the first-run screens an
 * interactive CLI would stop at already answered: onboarding, the bypass
 * consent and the trust question for `worktreePath`. Every other key is kept.
 */
export function onboardedClaudeState(earlier: unknown, worktreePath: string): JsonObject {
  const state = asObject(earlier);
  const projects = asObject(state.projects);
  return {
    ...state,
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      ...projects,
      [worktreePath]: { ...asObject(projects[worktreePath]), hasTrustDialogAccepted: true },
    },
  };
}

/** `RegistryWriterLeaseBusyError`'s message (`registry-writer-lease.ts`). */
const WRITER_LEASE_BUSY =
  "Another Orkestrator backend is managing this data directory's containers";

/**
 * Stop and delete the environments a run created. A backend restarted while
 * the crashed one's writer lease is still fresh refuses every container
 * change until it wins that lease late (up to about a minute; to-do 5160 (retired)
 * task 3), so a refusal naming the lease is retried until `timeoutMs`. Any
 * other failure is not retried. Returns the ids it could not delete, never
 * throws: the caller reports them instead of leaving a container behind
 * unnoticed, as the first container run did on 2026-11-16.
 */
export async function removeEnvironments(
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>,
  environmentIds: readonly string[],
  options: { timeoutMs?: number; retryMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Array<{ environmentId: string; error: string }>> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retryMs = options.retryMs ?? 5_000;
  let budget = options.timeoutMs ?? 120_000;
  const failures: Array<{ environmentId: string; error: string }> = [];
  for (const environmentId of environmentIds) {
    for (;;) {
      try {
        await invoke("stop_environment", { environmentId }).catch(() => undefined);
        await invoke("delete_environment", { environmentId });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(WRITER_LEASE_BUSY) && budget > 0) {
          budget -= retryMs;
          await sleep(retryMs);
          continue;
        }
        failures.push({ environmentId, error: message.slice(0, 200) });
        break;
      }
    }
  }
  return failures;
}
