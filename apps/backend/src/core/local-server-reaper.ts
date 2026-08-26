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
 *   - its command line must contain every marker of one of the marker sets for
 *     the recorded server kind (a recycled PID belonging to a stranger must
 *     never be signalled),
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
 * Confirmed stale records are cleared. Records whose identity cannot be read,
 * whose process group is unsafe, or whose kill failed are retained so a later
 * startup can retry without losing attribution.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "./shell.js";
import { terminateProcessTree } from "./process-tree.js";
import {
  isMissingTmuxSessionError,
  parseTmuxSessionNames,
  RUNTIME_ROOT_PREFIX,
  selectReapableTmuxSessions,
} from "./tmux.js";
import type { Environment } from "./models.js";

export type LocalServerReapKind = "opencode" | "claude" | "codex" | "cursor" | "grok" | "pi";

/**
 * claude-tmux is deliberately *not* in `REAPABLE_SERVERS`.
 *
 * Every entry in that table is a process this backend spawned itself, detached,
 * whose PID it recorded on the environment. tmux mode spawns nothing of the
 * kind: it asks the user's (or the container's) already-running tmux *server* to
 * create a session. There is no child of ours, no PID to record, and no process
 * group that is ours to signal — the tmux server belongs to the login session
 * and may be hosting the user's own unrelated work. Signalling it by PID would
 * be exactly the false positive the pid-based checks exist to prevent.
 *
 * The equivalent evidence for tmux mode is the runtime root: tmux mode creates
 * `${RUNTIME_ROOT_PREFIX}/<dataDirHash>/<environmentId>` on the host for every
 * *local* environment it starts (a container environment's root lives inside
 * the container and dies with it) and removes it on a clean stop. A root left
 * behind for an environment that no longer exists is therefore the same signal
 * a stale PID record is, and the corresponding sessions are addressed by tmux
 * session *name* rather than by PID.
 *
 * Roots belonging to environments that still exist are left completely alone.
 * Their sessions may well be orphans of a crashed backend, but they are also
 * exactly what a user returning to that environment expects to find running,
 * and `claude_tmux_start` already kills a stale session before relaunching.
 */
export interface ReapedClaudeTmuxRuntime {
  environmentId: string;
  outcome: "reaped" | "kept-live-environment" | "retry-pending";
  killedSessions: string[];
}

export interface ReapOrphanedClaudeTmuxRuntimesOptions {
  storage: { loadEnvironments: () => Promise<Environment[]> };
  /** Injected in tests so the sweep never touches the real shared root. */
  runtimeRootPrefix?: string;
  listRuntimeRoots?: (prefix: string) => Promise<string[]>;
  listTmuxSessions?: () => Promise<string[]>;
  killTmuxSession?: (sessionName: string) => Promise<void>;
  removeRuntimeRoot?: (rootPath: string) => Promise<void>;
  log?: (message: string) => void;
}

/** Directory names directly under the runtime root prefix, one per environment. */
async function readRuntimeRoots(prefix: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(prefix, { withFileTypes: true });
    return (
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        // A name that is not a plain path segment cannot be an environment id and
        // must never be joined onto the prefix and removed recursively.
        .filter((name) => name.length > 0 && name !== "." && name !== ".." && !name.includes("/"))
    );
  } catch {
    // The prefix does not exist: tmux mode has never run on this host.
    return [];
  }
}

async function readHostTmuxSessions(): Promise<string[]> {
  try {
    const { stdout } = await runCommand("tmux", ["list-sessions", "-F", "#{session_name}"], {
      timeoutMs: 5_000,
    });
    return parseTmuxSessionNames(stdout);
  } catch (error) {
    const message = String(error);
    if (
      /no server running/i.test(message) ||
      /failed to connect to server/i.test(message) ||
      /no sessions/i.test(message)
    ) {
      return [];
    }
    // A timeout, missing executable, or other unexpected failure says nothing
    // about whether a detached tmux server still owns sessions. Preserve the
    // runtime roots so a later startup can retry with the same attribution.
    throw error;
  }
}

/**
 * Sweeps claude-tmux runtime roots left behind for environments that no longer
 * exist, killing the tmux sessions those environments owned.
 *
 * Runs at startup alongside `reapOrphanedLocalServers`, and like it prefers a
 * false negative: anything it cannot positively attribute to a deleted
 * environment is left for the next startup.
 */
export async function reapOrphanedClaudeTmuxRuntimes(
  options: ReapOrphanedClaudeTmuxRuntimesOptions,
): Promise<ReapedClaudeTmuxRuntime[]> {
  const prefix = options.runtimeRootPrefix ?? RUNTIME_ROOT_PREFIX;
  const listRuntimeRoots = options.listRuntimeRoots ?? readRuntimeRoots;
  const listTmuxSessions = options.listTmuxSessions ?? readHostTmuxSessions;
  const killTmuxSession =
    options.killTmuxSession ??
    (async (sessionName: string) => {
      try {
        await runCommand("tmux", ["kill-session", "-t", sessionName], { timeoutMs: 5_000 });
      } catch (error) {
        if (!isMissingTmuxSessionError(error)) throw error;
      }
    });
  const removeRuntimeRoot =
    options.removeRuntimeRoot ??
    ((rootPath: string) => fs.rm(rootPath, { recursive: true, force: true }));
  const log = options.log ?? ((message) => console.warn(message));

  const roots = await listRuntimeRoots(prefix);
  if (roots.length === 0) return [];

  const environmentIds = (await options.storage.loadEnvironments()).map(
    (environment) => environment.id,
  );
  const surviving = new Set(environmentIds);
  const orphans = roots.filter((environmentId) => !surviving.has(environmentId));
  const kept: ReapedClaudeTmuxRuntime[] = roots
    .filter((environmentId) => surviving.has(environmentId))
    .map((environmentId) => ({
      environmentId,
      outcome: "kept-live-environment" as const,
      killedSessions: [],
    }));
  if (orphans.length === 0) return kept;

  // One listing for the whole sweep: the tmux server is shared, so re-listing
  // per orphan would only add round trips.
  let sessionNames: string[];
  try {
    sessionNames = await listTmuxSessions();
  } catch (error) {
    log(`[backend] Failed to list orphaned claude-tmux sessions: ${String(error)}`);
    return [
      ...orphans.map((environmentId) => ({
        environmentId,
        outcome: "retry-pending" as const,
        killedSessions: [],
      })),
      ...kept,
    ];
  }

  const reaped: ReapedClaudeTmuxRuntime[] = [];
  for (const environmentId of orphans) {
    const targets = selectReapableTmuxSessions({
      names: sessionNames,
      environmentId,
      survivingEnvironmentIds: environmentIds,
    });
    const killedSessions: string[] = [];
    let killFailed = false;
    for (const sessionName of targets) {
      try {
        await killTmuxSession(sessionName);
        killedSessions.push(sessionName);
      } catch (error) {
        if (isMissingTmuxSessionError(error)) {
          // The session exited after the shared listing. The desired state is
          // already reached, so allow the durable attribution root to go.
          killedSessions.push(sessionName);
          continue;
        }
        killFailed = true;
        log(`[backend] Failed to kill orphaned tmux session ${sessionName}: ${String(error)}`);
      }
    }
    if (killedSessions.length > 0) {
      log(
        `[backend] Reaped ${killedSessions.length} orphaned claude-tmux session(s) for deleted environment ${environmentId}`,
      );
    }
    if (killFailed) {
      // The root is the only durable evidence connecting the remaining session
      // name to this deleted environment. Removing it would make the leak
      // impossible to find on the next startup.
      reaped.push({ environmentId, outcome: "retry-pending", killedSessions });
      continue;
    }
    try {
      await removeRuntimeRoot(path.join(prefix, environmentId));
      reaped.push({ environmentId, outcome: "reaped", killedSessions });
    } catch (error) {
      log(
        `[backend] Failed to remove claude-tmux runtime root for ${environmentId}: ${String(error)}`,
      );
      reaped.push({ environmentId, outcome: "retry-pending", killedSessions });
    }
  }

  return [...reaped, ...kept];
}

interface ReapableServer {
  kind: LocalServerReapKind;
  pidField:
    | "opencodePid"
    | "claudeBridgePid"
    | "codexBridgePid"
    | "cursorBridgePid"
    | "grokBridgePid"
    | "piBridgePid";
  portField:
    | "localOpencodePort"
    | "localClaudePort"
    | "localCodexPort"
    | "localCursorPort"
    | "localGrokPort"
    | "localPiPort";
  /**
   * Alternative marker sets. A process matches when *every* substring in *any
   * one* set appears in its command line.
   *
   * These mirror what `startLocalServerUnlocked` actually spawns — the bridge
   * entrypoint is an absolute path (`path.join(bridgeDir, "dist", "index.js")`),
   * so the bridge's directory name is part of the command line:
   *   opencode → `<binary> serve --port N --hostname 127.0.0.1`
   *   claude   → `<bun> <…>/claude-bridge/dist/index.js`
   *   codex    → `<bun> <…>/codex-bridge/dist/index.js`
   *   pi       → `<bun> <…>/pi-bridge/dist/index.js`
   *   grok     → `<bun> <…>/acp-bridge/dist/index.js`
   *   cursor   → `<bun> <…>/cursor-bridge/dist/index.js`
   *
   * A bare `"opencode"` was too weak on its own: it matches a hand-started
   * `opencode` in any mode, or any command line that merely mentions the word,
   * which is exactly the stranger a recycled PID would land on.
   *
   */
  markerSets: readonly (readonly string[])[];
}

const REAPABLE_SERVERS: readonly ReapableServer[] = [
  {
    kind: "opencode",
    pidField: "opencodePid",
    portField: "localOpencodePort",
    markerSets: [["opencode", "serve", "--hostname"]],
  },
  {
    kind: "claude",
    pidField: "claudeBridgePid",
    portField: "localClaudePort",
    markerSets: [["claude-bridge", "dist/index.js"]],
  },
  {
    kind: "codex",
    pidField: "codexBridgePid",
    portField: "localCodexPort",
    markerSets: [["codex-bridge", "dist/index.js"]],
  },
  {
    kind: "cursor",
    pidField: "cursorBridgePid",
    portField: "localCursorPort",
    markerSets: [["cursor-bridge", "dist/index.js"]],
  },
  {
    kind: "grok",
    pidField: "grokBridgePid",
    portField: "localGrokPort",
    markerSets: [["acp-bridge", "dist/index.js"]],
  },
  {
    kind: "pi",
    pidField: "piBridgePid",
    portField: "localPiPort",
    markerSets: [["pi-bridge", "dist/index.js"]],
  },
];

/** True when every marker of at least one set appears in the command line. */
function matchesMarkers(markerSets: readonly (readonly string[])[], commandLine: string): boolean {
  return markerSets.some((markers) => markers.every((marker) => commandLine.includes(marker)));
}

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
  } catch (error) {
    // `ps -p` exits non-zero when the PID no longer exists. A timeout, missing
    // executable, or transient spawn failure is different: if the PID is still
    // alive, preserve its record so a later startup can identify it safely.
    if (!isPidAlive(pid)) return null;
    throw error;
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
    | "skipped-not-group-leader"
    | "skipped-unreadable";
}

export interface ReapOrphanedLocalServersOptions {
  storage: {
    loadEnvironments: () => Promise<Environment[]>;
    updateEnvironment: (environmentId: string, fields: Partial<Environment>) => Promise<unknown>;
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

  const results = await Promise.all(
    environments.map(async (environment) => {
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

        let identity: ProcessIdentity | null;
        try {
          identity = await readIdentity(pid);
        } catch (error) {
          log(
            `[backend] Unable to identify ${server.kind} pid ${pid}; preserving its record: ${String(error)}`,
          );
          record("skipped-unreadable");
          continue;
        }
        if (identity === null || !matchesMarkers(server.markerSets, identity.commandLine)) {
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
    }),
  );

  return results.flat();
}
