import { CONTAINER_ROOT_PATH, CONTAINER_ROOT_USER_ARGS } from "./container-scripts.js";
import { runCommand } from "./shell.js";

/**
 * Whether the socket listening on a container bridge's port is the one the
 * bridge the backend started opened (to-do 7250).
 *
 * The bridge shares the agent's uid, so an agent's background process can kill
 * it and start a bridge of its own on the same port from the verifier and the
 * public key, neither of which is secret. That bridge accepts the token the
 * backend reads from root's file, and every later session would run in a
 * process the agent controls. So once a bridge it launched answers, the
 * backend records the port's listening socket in a root-only file, and before
 * it hands out a running bridge's token it compares the port's socket with
 * that record. A different socket is refused, and the next start replaces it.
 *
 * The record names the socket, not the process: root in a container has no
 * `CAP_SYS_PTRACE`, so it cannot read another uid's `/proc/<pid>/fd` to map a
 * socket to its pid. `ss -e` reads the socket's inode and its cookie over
 * `sock_diag`, which needs no privilege; the kernel never reuses a cookie
 * while it runs, and a process cannot obtain the bridge's socket (the bridge
 * is non-dumpable, so `pidfd_getfd` is refused, and it opens it close-on-exec).
 *
 * A bridge is recorded only once it answers, so a process that replaced it
 * before then would be recorded instead. The launcher
 * (`docker/orkestrator-bridge-launch.sh`) reports the session it started the
 * bridge in, and a new process cannot join a session: the record is written
 * only while a `bun` in that session is alive. A bridge that exits on a port
 * someone else already holds leaves none. An image whose launcher reports
 * nothing, and a `verifier` image, go without that check.
 */

/** What a record holds before the bridge it was written for answers. */
export const PENDING_LISTENER_RECORD = "pending";

/** One listening socket on the port, as `ss -e` reports it. */
export interface BridgeListenerSocket {
  inode: string;
  cookie: string;
  uid: number;
}

export interface BridgeListenerScan {
  /** False when the scan could not run, so an empty result says nothing. */
  complete: boolean;
  /** The record's content, or null when there is no record. */
  record: string | null;
  sockets: BridgeListenerSocket[];
  /** Whether a `bun` was alive in the launch session asked about. */
  launchSessionAlive: boolean;
}

export type BridgeListenerRefusal =
  "different-socket" | "several-sockets" | "pending" | "scan-incomplete";

export type BridgeListenerVerdict =
  | { kind: "trusted" }
  /** Nothing listens: no token can reach a process there. */
  | { kind: "idle" }
  /** A bridge from before records: one socket, recorded now. */
  | { kind: "unrecorded"; identity: string }
  | { kind: "refused"; reason: BridgeListenerRefusal };

export type BridgeListenerRecordRefusal =
  "scan-incomplete" | "no-listener" | "several-sockets" | "launch-exited";

const SCAN_COMPLETE = "listener-scan-complete";
const LAUNCH_ALIVE = "listener-launch-alive";

/** A socket's identity as a record holds it: `<inode>:<cookie>`. */
export function bridgeListenerIdentity(socket: Pick<BridgeListenerSocket, "inode" | "cookie">) {
  return `${socket.inode}:${socket.cookie}`;
}

function checkedPort(port: number): number {
  if (!Number.isInteger(port) || port <= 0 || port > 0xffff) {
    throw new Error("A bridge port must be a TCP port number");
  }
  return port;
}

function quoted(path: string): string {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(path)) throw new Error("Unexpected listener record path");
  return `'${path}'`;
}

/** `ss` listing the port's listening TCP sockets, IPv4 and IPv6, with inode and cookie. */
function listeningSocketsCommand(port: number): string {
  return `ss -Hltne 'sport = :${checkedPort(port)}'`;
}

/**
 * Lines to append to a root script: the record, the port's listening sockets,
 * whether a `bun` is alive in `launchSession`, then a line saying the scan
 * finished. Nothing says it finished when `ss` could not run.
 */
export function bridgeListenerScanScript(
  port: number,
  recordFile: string,
  launchSession?: number,
): string {
  const session =
    launchSession === undefined
      ? ""
      : `
  # A process's session is field 6 of /proc/<pid>/stat, counted after its name.
  if cat /proc/[0-9]*/stat 2>/dev/null | awk -v session=${checkedSession(launchSession)} '
    { line = $0; name = line; sub(/^[0-9]+ \\(/, "", name); sub(/\\) [^)]*$/, "", name)
      sub(/^.*\\) /, "", line); split(line, field, " ")
      if (name == "bun" && field[4] == session) found = 1 }
    END { exit found ? 0 : 1 }'; then printf '${LAUNCH_ALIVE}\\n'; fi`;
  return `if [ -f ${quoted(recordFile)} ]; then printf 'listener-record %s\\n' "$(head -c 128 ${quoted(recordFile)} | tr -d ' \\n')"; fi
if command -v ss >/dev/null 2>&1 && sockets=$(${listeningSocketsCommand(port)}); then
  printf '%s\\n' "$sockets" | sed -n 's/^./listener-socket &/p'${session}
  printf '${SCAN_COMPLETE}\\n'
fi`;
}

function checkedSession(session: number): number {
  if (!Number.isSafeInteger(session) || session <= 1) throw new Error("Unexpected launch session");
  return session;
}

/** The scan's lines, from output that may carry other lines before them. */
export function parseBridgeListenerScan(output: string): BridgeListenerScan {
  const scan: BridgeListenerScan = {
    complete: false,
    record: null,
    sockets: [],
    launchSessionAlive: false,
  };
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === SCAN_COMPLETE) scan.complete = true;
    else if (trimmed === LAUNCH_ALIVE) scan.launchSessionAlive = true;
    else if (trimmed.startsWith("listener-record ")) scan.record = trimmed.slice(16).trim();
    else if (trimmed === "listener-record") scan.record = "";
    else if (trimmed.startsWith("listener-socket ")) {
      const inode = /(?:^|\s)ino:(\d+)(?:\s|$)/.exec(trimmed)?.[1];
      const cookie = /(?:^|\s)sk:([0-9a-f]+)(?:\s|$)/.exec(trimmed)?.[1];
      const uid = /(?:^|\s)uid:(\d+)(?:\s|$)/.exec(trimmed)?.[1];
      // A socket that cannot be identified cannot be vouched for.
      scan.sockets.push({ inode: inode ?? "", cookie: cookie ?? "", uid: uid ? Number(uid) : -1 });
    }
  }
  return scan;
}

/** The one socket listening on the port, or why there is not one. */
function soleSocket(scan: BridgeListenerScan): BridgeListenerSocket | "several-sockets" {
  const identities = new Set(scan.sockets.map(bridgeListenerIdentity));
  return identities.size === 1 ? scan.sockets[0]! : "several-sockets";
}

function identified(socket: BridgeListenerSocket): boolean {
  return socket.inode !== "" && socket.cookie !== "";
}

/** Whether a running bridge's token may be handed out. */
export function judgeBridgeListener(scan: BridgeListenerScan): BridgeListenerVerdict {
  if (!scan.complete || !scan.sockets.every(identified)) {
    return { kind: "refused", reason: "scan-incomplete" };
  }
  if (scan.sockets.length === 0) return { kind: "idle" };
  const socket = soleSocket(scan);
  if (typeof socket === "string") return { kind: "refused", reason: socket };
  const identity = bridgeListenerIdentity(socket);
  if (scan.record === null) return { kind: "unrecorded", identity };
  if (scan.record === PENDING_LISTENER_RECORD) return { kind: "refused", reason: "pending" };
  return scan.record === identity
    ? { kind: "trusted" }
    : { kind: "refused", reason: "different-socket" };
}

/**
 * The identity to record for a bridge that was just launched and answers, or
 * why the socket cannot be its own. `launchSession` is the session the
 * launcher reported, when it reported one.
 */
export function bridgeListenerToRecord(
  scan: BridgeListenerScan,
  launchSession?: number,
): { identity: string } | { refused: BridgeListenerRecordRefusal } {
  if (!scan.complete || !scan.sockets.every(identified)) return { refused: "scan-incomplete" };
  if (scan.sockets.length === 0) return { refused: "no-listener" };
  const socket = soleSocket(scan);
  if (typeof socket === "string") return { refused: socket };
  if (launchSession !== undefined && !scan.launchSessionAlive) return { refused: "launch-exited" };
  return { identity: bridgeListenerIdentity(socket) };
}

/** Root lines writing `value` to the record, atomically. */
export function writeBridgeListenerRecordCommand(recordFile: string, value: string): string {
  if (value !== PENDING_LISTENER_RECORD && !/^\d+:[0-9a-f]+$/.test(value)) {
    throw new Error("Unexpected listener record");
  }
  const file = quoted(recordFile);
  return `record_tmp=$(mktemp ${file}.XXXXXX) && printf '%s\\n' '${value}' > "$record_tmp" && mv "$record_tmp" ${file}`;
}

async function rootExec(containerId: string, script: string): Promise<string> {
  const { stdout } = await runCommand(
    "docker",
    ["exec", ...CONTAINER_ROOT_USER_ARGS, containerId, "sh", "-c", script],
    { timeoutMs: 30_000 },
  );
  return stdout;
}

export async function writeContainerBridgeListenerRecord(
  containerId: string,
  recordFile: string,
  value: string,
): Promise<void> {
  await rootExec(
    containerId,
    `set -eu\numask 077\n${writeBridgeListenerRecordCommand(recordFile, value)}`,
  );
}

/**
 * Record the socket now listening on a bridge's port as the bridge just
 * launched. Records nothing, and says why, when it cannot be that bridge's.
 */
export async function recordContainerBridgeListener(
  containerId: string,
  port: number,
  recordFile: string,
  launchSession?: number,
): Promise<{ refused?: BridgeListenerRecordRefusal }> {
  const scan = parseBridgeListenerScan(
    await rootExec(containerId, bridgeListenerScanScript(port, recordFile, launchSession)),
  );
  const result = bridgeListenerToRecord(scan, launchSession);
  if ("refused" in result) return { refused: result.refused };
  await writeContainerBridgeListenerRecord(containerId, recordFile, result.identity);
  return {};
}

/**
 * Stop what listens on a bridge's port, whatever its command line: a process
 * the agent's uid started there need not match the pattern the backend stops
 * bridges by. It runs as `node` without a login shell. A process that made
 * itself non-dumpable (the bridge's own code does) hides its descriptors from
 * `node` and from root alike, so it is stopped only by that pattern; the start
 * after this then fails rather than trusting it. One still there after three
 * seconds of SIGTERM is killed, if its start time shows it is the same process.
 */
export function stopBridgeListenerScript(port: number): string {
  return `inodes=$(${listeningSocketsCommand(port)} 2>/dev/null | sed -n 's/.*[[:space:]]ino:\\([0-9][0-9]*\\)[[:space:]].*/\\1/p' | sort -u)
targets=""
for inode in $inodes; do
  for fd_dir in $(find /proc/[0-9]*/fd -maxdepth 1 -lname "socket:\\[$inode\\]" -printf '%h\\n' 2>/dev/null | sort -u); do
    pid=\${fd_dir#/proc/}
    pid=\${pid%/fd}
    stat=$(cat "/proc/$pid/stat" 2>/dev/null) || continue
    set -- \${stat##*")"}
    targets="$targets $pid:\${20}"
  done
done
[ -n "$targets" ] || exit 0
alive() {
  stat=$(cat "/proc/\${1%%:*}/stat" 2>/dev/null) || return 1
  set -- "$1" \${stat##*")"}
  [ "\${1#*:}" = "\${21}" ]
}
for target in $targets; do kill -TERM "\${target%%:*}" 2>/dev/null || true; done
attempt=0
while [ "$attempt" -lt 30 ]; do
  remaining=""
  for target in $targets; do if alive "$target"; then remaining="$remaining $target"; fi; done
  [ -n "$remaining" ] || exit 0
  sleep 0.1
  attempt=$((attempt + 1))
done
for target in $remaining; do if alive "$target"; then kill -KILL "\${target%%:*}" 2>/dev/null || true; fi; done
exit 0`;
}

export async function stopContainerBridgeListener(containerId: string, port: number) {
  await runCommand(
    "docker",
    [
      "exec",
      "--user",
      "node",
      "--workdir",
      "/",
      "--env",
      `PATH=${CONTAINER_ROOT_PATH}`,
      containerId,
      "sh",
      "-c",
      stopBridgeListenerScript(port),
    ],
    { timeoutMs: 30_000 },
  );
}
