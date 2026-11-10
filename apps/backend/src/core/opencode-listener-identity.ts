/**
 * Which socket answers on a container's OpenCode port, as root sees it.
 *
 * OpenCode compares a plain password (HTTP Basic), so whatever answers on its
 * port reads the password from the backend's next request. A process running
 * as the agent's uid can kill the server and listen there itself, or start an
 * `opencode serve` of its own with a password it caught, and the backend would
 * keep using it. The bridges' signatures (`bridge-authority.ts`) need a
 * verifier inside the server, which OpenCode does not have.
 *
 * So on an `opencode-launch=1` image, once the server the backend launched has
 * answered the fresh password only it was given and loaded the plugin that
 * makes it non-dumpable, a root exec records the inode of the socket listening
 * on the port in root-only `/run/orkestrator-bridge`
 * ({@link recordOpenCodeListenerScript}). Every later read of the password
 * (`readContainerBridgeToken`) lists the port's listening sockets in the same
 * root exec, and the password is withheld unless that one socket is still the
 * only one ({@link judgeOpenCodeListener}). Anything else listening there had
 * to open a socket of its own, and a new socket has a new inode; the recorded
 * one cannot be taken out of a non-dumpable process.
 *
 * Sockets, not processes: the container's root has no `CAP_SYS_PTRACE`, so it
 * cannot read another uid's `/proc/<pid>/fd` and cannot tell which process
 * holds a socket. `/proc/net/tcp` is readable by anyone and lists each socket's
 * inode. A start replaces whatever listens with a new server and a new password,
 * which the old listener never sees. What remains is the race between the
 * check and the requests that follow it, narrowed by a re-check after a
 * refused connection or an unexpected answer (`opencode-listener-recheck.ts`);
 * see docs/architecture/agent-approvals.md.
 *
 * The 2.x server on an `opencode2-launch=1` image has its own record
 * (`opencode2-listener`) on its own port, by the same rules.
 */

/** The root-owned binary `orkestrator-bridge-launch opencode` runs. */
export const OPENCODE_CONTAINER_BINARY = "/opt/opencode/bin/opencode";
/** The root-owned 2.x binary `orkestrator-bridge-launch opencode2` runs. */
export const OPENCODE2_CONTAINER_BINARY = "/opt/opencode/bin/opencode2";

/** The record of the socket the backend's server listens on; root-only, beside the password. */
export const OPENCODE_LISTENER_RECORD = "/run/orkestrator-bridge/opencode-listener";
/** The same record for the 2.x server on an `opencode2-launch=1` image. */
export const OPENCODE2_LISTENER_RECORD = "/run/orkestrator-bridge/opencode2-listener";

/** Which of the container's two OpenCode servers a record, a port and a password belong to. */
export type OpenCodeServerKind = "opencode" | "opencode2";

export function openCodeListenerRecord(kind: OpenCodeServerKind): string {
  return kind === "opencode2" ? OPENCODE2_LISTENER_RECORD : OPENCODE_LISTENER_RECORD;
}

export interface OpenCodeListenerSnapshot {
  /** The recorded socket inode, or null when nothing was recorded. */
  record: string | null;
  /** The inode of each socket listening on the port. */
  sockets: string[];
}

export type OpenCodeListenerJudgement =
  /** The recorded socket is the only one listening. */
  | "ours"
  /** Another socket listens, nothing does, or the recorded one is gone. */
  | "replaced"
  /** No record: an older image, or a server an older backend started. */
  | "unrecorded";

/** Shell that sets `inodes` to the inodes of the TCP sockets listening on `port`. */
function listeningInodesScript(port: number): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  return `inodes=$(awk 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == ":${portHex}" { print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null)`;
}

/** Shell that prints `socket <inode>` for each TCP socket listening on `port`. */
export function listOpenCodeListenersScript(port: number): string {
  return [
    listeningInodesScript(port),
    `for inode in $inodes; do printf 'socket %s\\n' "$inode"; done`,
  ].join("\n");
}

/** Parse what {@link listOpenCodeListenersScript} printed, after an optional `record` line. */
export function parseOpenCodeListeners(output: string): OpenCodeListenerSnapshot {
  const snapshot: OpenCodeListenerSnapshot = { record: null, sockets: [] };
  const inode = (value: string | undefined) =>
    value && /^[1-9]\d{0,19}$/.test(value) ? value : null;
  for (const line of output.split("\n")) {
    const [kind, value] = line.trim().split(/\s+/);
    if (kind === "record") snapshot.record = inode(value);
    else if (kind === "socket") {
      const listening = inode(value);
      if (listening) snapshot.sockets.push(listening);
    }
  }
  return snapshot;
}

/** Whether the port is held by the recorded socket alone. */
export function judgeOpenCodeListener(
  snapshot: OpenCodeListenerSnapshot,
): OpenCodeListenerJudgement {
  if (!snapshot.record) return "unrecorded";
  return snapshot.sockets.length === 1 && snapshot.sockets[0] === snapshot.record
    ? "ours"
    : "replaced";
}

/**
 * Root shell that records the port's only listening socket and prints
 * `recorded`. No socket, or more than one, prints `refused` and leaves no
 * record, so the start fails rather than trust it.
 */
export function recordOpenCodeListenerScript(
  port: number,
  record: string = OPENCODE_LISTENER_RECORD,
): string {
  return [
    "set -eu",
    "umask 077",
    `rm -f ${record}`,
    listeningInodesScript(port),
    "set -- $inodes",
    `if [ "$#" -ne 1 ]; then echo refused; exit 0; fi`,
    `tmp=$(mktemp ${record}.XXXXXX)`,
    `printf '%s\\n' "$1" > "$tmp"`,
    `mv "$tmp" ${record}`,
    "echo recorded",
  ].join("\n");
}

/**
 * Shell, run as `node`, that stops every process of that uid holding a socket
 * listening on the port: the agent's uid can read the descriptors of its own
 * dumpable processes, which root here cannot. The port is OpenCode's, so what
 * holds it when the backend wants a new server is a stale server or an
 * imposter. A non-dumpable one is out of reach, and the start then fails.
 */
export function stopOpenCodeListenersScript(port: number): string {
  return [
    listeningInodesScript(port),
    "for inode in $inodes; do",
    `  for pid in $(find /proc/[0-9]*/fd -maxdepth 1 -lname "socket:\\[$inode\\]" 2>/dev/null | cut -d/ -f3 | sort -u); do`,
    '    kill "$pid" 2>/dev/null || true',
    "  done",
    "done",
  ].join("\n");
}
