/**
 * Reaps local bridge processes orphaned by a previous backend instance.
 *
 * Bridges are spawned detached and tracked only in the backend's in-memory
 * process table, so a backend that dies without running its shutdown path
 * (force quit, crash, SIGKILL) leaves them running. The PIDs persisted on each
 * environment record were previously write-only; this module is what finally
 * reads them. It runs once, during backend init and before the gateway accepts
 * commands, so it can never race a bridge this backend spawned itself.
 *
 * A recorded PID is killed only when it can be positively identified:
 *
 *   - its command line must contain *every* marker for the recorded server
 *     kind (a recycled PID belonging to a stranger must never be signalled),
 *   - it must actually be orphaned (`ppid == 1`). A bridge whose parent is
 *     still alive belongs to another live backend sharing this data dir, and
 *     killing it would break that instance, and
 *   - it must be its own process-group leader (`pgid == pid`). Termination
 *     signals the group, so a PID that leads no group would spray SIGKILL
 *     across an unrelated group. Every bridge is spawned `detached`, which
 *     makes it a group leader, so this only ever rejects a misidentification.
 *
 * Each check independently prefers a false negative (a leaked process survives
 * until the next startup) over a false positive (killing someone else's work).
 *
 * Stale records are cleared in every case except a kill that failed, so a
 * later startup can retry it.
 */
import { runCommand } from "./shell.js";
import { terminateProcessTree } from "./process-tree.js";
import type { Environment } from "./models.js";

export type LocalServerReapKind = "opencode" | "claude" | "codex";

interface ReapableServer {
  kind: LocalServerReapKind;
  pidField: "opencodePid" | "claudeBridgePid" | "codexBridgePid";
  portField: "localOpencodePort" | "localClaudePort" | "localCodexPort";
  /**
   * Substrings that must *all* appear in the process's command line.
   *
   * These mirror what `startLocalServerUnlocked` actually spawns:
   *   opencode → `<binary> serve --port N --hostname 127.0.0.1`
   *   claude   → `<bun> <…>/claude-bridge/dist/index.js`
   *   codex    → `<bun> <…>/codex-bridge/dist/index.js`
   *
   * A bare `"opencode"` was too weak on its own: it matches a hand-started
   * `opencode` in any mode, or any command line that merely mentions the word,
   * which is exactly the stranger a recycled PID would land on.
   */
  markers: readonly string[];
}

const REAPABLE_SERVERS: readonly ReapableServer[] = [
  {
    kind: "opencode",
    pidField: "opencodePid",
    portField: "localOpencodePort",
    markers: ["opencode", "serve", "--hostname"],
  },
  {
    kind: "claude",
    pidField: "claudeBridgePid",
    portField: "localClaudePort",
    markers: ["claude-bridge", "dist/index.js"],
  },
  {
    kind: "codex",
    pidField: "codexBridgePid",
    portField: "localCodexPort",
    markers: ["codex-bridge", "dist/index.js"],
  },
];

/**
 * Orphans get a shorter grace than an owned shutdown: their descendants are
 * explicitly SIGKILLed by `terminateProcessTree` afterwards either way, and a
 * crashed-app restart should not sit behind an 8-second drain per bridge.
 */
const REAP_GRACE_MS = 3_000;
const REAP_KILL_WAIT_MS = 1_000;

export interface ProcessIdentity {
  parentPid: number;
  processGroupId: number;
  commandLine: string;
}

/**
 * Parses one `ps -o ppid=,pgid=,command=` row.
 *
 * Exported for tests: the shape of this output is the reaper's only evidence
 * about a process it is about to signal, so a parsing slip here is what turns
 * a stranger into a target.
 */
export function parseProcessIdentity(stdout: string): ProcessIdentity | null {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  // `command` is last and may contain anything, including whitespace runs.
  const match = /^(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
  if (!match) return null;
  const parentPid = Number(match[1]);
  const processGroupId = Number(match[2]);
  if (!Number.isInteger(parentPid) || !Number.isInteger(processGroupId)) return null;
  return { parentPid, processGroupId, commandLine: match[3] ?? "" };
}

async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await runCommand(
      "ps",
      ["-p", String(pid), "-ww", "-o", "ppid=,pgid=,command="],
      { timeoutMs: 5_000 },
    );
    return parseProcessIdentity(stdout);
  } catch {
    // `ps -p` exits non-zero when the PID no longer exists.
    return null;
  }
}

/**
 * EPERM means the process exists but belongs to another user: alive, and not
 * ours. Reporting it dead would let the caller treat someone else's live
 * process as a stale record.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A handle over a bare PID that `terminateProcessTree` can drive. There is no
 * ChildProcess for an orphan, so exit status is derived by probing liveness.
 */
export function detachedProcessHandle(pid: number): {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
} {
  return {
    pid,
    get exitCode(): number | null {
      return isPidAlive(pid) ? null : 0;
    },
    signalCode: null,
    kill: (signal?: NodeJS.Signals | number) => {
      try {
        process.kill(pid, signal ?? "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface ReapedLocalServer {
  environmentId: string;
  kind: LocalServerReapKind;
  pid: number;
  outcome:
    | "reaped"
    | "cleared"
    | "kill-failed"
    | "skipped-live-owner"
    | "skipped-not-group-leader";
}

export interface ReapOrphanedLocalServersOptions {
  storage: {
    loadEnvironments: () => Promise<Environment[]>;
    updateEnvironment: (
      environmentId: string,
      fields: Partial<Environment>,
    ) => Promise<unknown>;
  };
  /** Injected in tests. */
  readIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  terminate?: typeof terminateProcessTree;
  log?: (message: string) => void;
}

export async function reapOrphanedLocalServers(
  options: ReapOrphanedLocalServersOptions,
): Promise<ReapedLocalServer[]> {
  const readIdentity = options.readIdentity ?? readProcessIdentity;
  const terminate = options.terminate ?? terminateProcessTree;
  const log = options.log ?? ((message) => console.warn(message));
  const environments = await options.storage.loadEnvironments();

  const results = await Promise.all(environments.map(async (environment) => {
    const reaped: ReapedLocalServer[] = [];
    for (const server of REAPABLE_SERVERS) {
      const pid = environment[server.pidField];
      if (typeof pid !== "number" || !Number.isInteger(pid)) continue;

      const record = (outcome: ReapedLocalServer["outcome"]): void => {
        reaped.push({ environmentId: environment.id, kind: server.kind, pid, outcome });
      };
      const clearRecord = () =>
        options.storage
          .updateEnvironment(environment.id, {
            [server.pidField]: null,
            [server.portField]: null,
          })
          .catch(() => undefined);

      // Our own PID or an init-range PID can never be a bridge we spawned.
      if (pid <= 1 || pid === process.pid) {
        await clearRecord();
        record("cleared");
        continue;
      }

      const identity = await readIdentity(pid);
      const matchesKind = identity !== null
        && server.markers.every((marker) => identity.commandLine.includes(marker));
      if (!matchesKind) {
        // Dead, or a recycled PID now owned by a stranger. Either way the
        // record is stale and must not be trusted again.
        await clearRecord();
        record("cleared");
        continue;
      }

      if (identity.parentPid > 1 && isPidAlive(identity.parentPid)) {
        // Still parented to a live process: another backend instance sharing
        // this data dir owns it. Not ours to kill, not stale to clear.
        record("skipped-live-owner");
        continue;
      }

      if (identity.processGroupId !== pid) {
        // Termination signals the process *group*. A PID that does not lead its
        // own group cannot be a bridge we spawned (`detached` makes them group
        // leaders), and signalling `-pid` would hit an unrelated group. Keep the
        // record: clearing it would hide the anomaly from the next startup.
        log(
          `[backend] Refusing to reap ${server.kind} pid ${pid}: it leads no process group (pgid ${identity.processGroupId})`,
        );
        record("skipped-not-group-leader");
        continue;
      }

      log(
        `[backend] Reaping orphaned ${server.kind} server pid ${pid} for environment ${environment.id}`,
      );
      const exited = await terminate(detachedProcessHandle(pid), {
        graceMs: REAP_GRACE_MS,
        killWaitMs: REAP_KILL_WAIT_MS,
      });
      if (!exited) {
        // Keep the record so the next startup retries this exact process.
        log(`[backend] Orphaned ${server.kind} server pid ${pid} did not exit`);
        record("kill-failed");
        continue;
      }
      await clearRecord();
      record("reaped");
    }
    return reaped;
  }));

  return results.flat();
}
