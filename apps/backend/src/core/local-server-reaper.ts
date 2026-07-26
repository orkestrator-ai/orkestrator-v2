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
 *   - its command line must contain the marker for the recorded server kind
 *     (a recycled PID belonging to a stranger must never be signalled), and
 *   - it must actually be orphaned (`ppid == 1`). A bridge whose parent is
 *     still alive belongs to another live backend sharing this data dir, and
 *     killing it would break that instance.
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
  /** Substring that must appear in the process's command line. */
  marker: string;
}

const REAPABLE_SERVERS: readonly ReapableServer[] = [
  { kind: "opencode", pidField: "opencodePid", portField: "localOpencodePort", marker: "opencode" },
  { kind: "claude", pidField: "claudeBridgePid", portField: "localClaudePort", marker: "claude-bridge" },
  { kind: "codex", pidField: "codexBridgePid", portField: "localCodexPort", marker: "codex-bridge" },
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
  commandLine: string;
}

async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await runCommand(
      "ps",
      ["-p", String(pid), "-ww", "-o", "ppid=,command="],
      { timeoutMs: 5_000 },
    );
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (!line) return null;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) return null;
    return { parentPid: Number(match[1]), commandLine: match[2] ?? "" };
  } catch {
    // `ps -p` exits non-zero when the PID no longer exists.
    return null;
  }
}

function isPidAlive(pid: number): boolean {
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
function detachedProcessHandle(pid: number): {
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
  outcome: "reaped" | "cleared" | "kill-failed" | "skipped-live-owner";
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
      if (!identity || !identity.commandLine.includes(server.marker)) {
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
