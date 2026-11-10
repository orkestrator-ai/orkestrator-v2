import type { ExecOutput } from "./tmux-shared.js";

/**
 * Narrows the tmux process census behind `confirmTmuxSessionGone`.
 *
 * When tmux cannot reach its socket, a server may still be alive with its
 * socket file deleted, so the census treated every tmux process as a possible
 * owner. On a Linux host that runs other tmux servers (another worktree's
 * private socket, a container's tmux) that made every unreachable socket look
 * contested, and a local environment move failed with `claude-tmux cleanup
 * incomplete` whenever one happened to be running (to-do 7020 task 1).
 *
 * On Linux the kernel still knows the answer. A listening Unix socket keeps
 * its bound path in `/proc/net/unix` after the file is unlinked, and that table
 * covers every process in the reader's network namespace. A process can serve
 * the socket only if it shares the namespace and the path is listed, or lives
 * in another namespace and sees the socket's directory as the same directory.
 * Anything this probe cannot establish (no `/proc`, an unreadable process, a
 * malformed answer) keeps the process as a possible owner.
 */

/** The socket path in a tmux "no server" diagnostic, when it names one. */
export function tmuxSocketPathFromMessage(value: unknown): string | undefined {
  const message = String(value);
  const match =
    /error connecting to (\/.*?) \((?:no such file or directory|connection refused)\)/i.exec(
      message,
    ) ?? /no server running on (\/[^\r\n]*)/i.exec(message);
  const socketPath = match?.[1]?.trim();
  if (!socketPath || /[\0\r\n]/.test(socketPath)) return undefined;
  return socketPath;
}

/**
 * Runs as `sh -c PROBE sh SOCKET PID...`; arguments are never interpolated
 * into the script. Prints `listed`, `self`, then one `pid` line per process:
 * `pid <pid> gone`, or `pid <pid> <netns|?> <same|differs|?>` where the last
 * field compares the process's view of the socket's nearest existing
 * directory with ours.
 */
export const TMUX_SOCKET_OWNER_PROBE = [
  "export LC_ALL=C",
  "socket=$1",
  "shift",
  "case $socket in /*) ;; *) exit 3 ;; esac",
  "self=$(readlink /proc/self/ns/net) || exit 3",
  'matches=$(grep -F -e " $socket" /proc/net/unix)',
  "case $? in 0) ;; 1) matches= ;; *) exit 3 ;; esac",
  "listed=no",
  "while IFS= read -r line; do",
  '  case $line in *" $socket") listed=yes ;; esac',
  "done <<EOF",
  "$matches",
  "EOF",
  'dir=${socket%/*}; [ -n "$dir" ] || dir=/',
  'while [ ! -d "$dir" ]; do dir=${dir%/*}; [ -n "$dir" ] || dir=/; done',
  'mine=$(stat -L -c %d:%i -- "$dir") || exit 3',
  'echo "listed $listed"',
  'echo "self $self"',
  'for pid in "$@"; do',
  '  case $pid in ""|*[!0-9]*) exit 3 ;; esac',
  '  if [ ! -d "/proc/$pid" ]; then echo "pid $pid gone"; continue; fi',
  '  net=$(readlink "/proc/$pid/ns/net" 2>/dev/null) || net="?"',
  '  view="?"',
  '  if stat -L -c %d:%i -- "/proc/$pid/root/" >/dev/null 2>&1; then',
  '    if theirs=$(stat -L -c %d:%i -- "/proc/$pid/root$dir" 2>&1); then',
  '      if [ "$theirs" = "$mine" ]; then view=same; else view=differs; fi',
  "    else",
  "      # Only a directory that does not exist there is a different directory.",
  '      case $theirs in *"No such file or directory"*) view=differs ;; esac',
  "    fi",
  "  fi",
  '  echo "pid $pid $net $view"',
  "done",
].join("\n");

/**
 * Whether none of `pids` can be the tmux server listening on `socketPath`.
 * False whenever that cannot be shown.
 */
export async function noProcessServesTmuxSocket(
  socketPath: string,
  pids: readonly string[],
  exec: (args: string[]) => Promise<ExecOutput>,
): Promise<boolean> {
  if (pids.length === 0) return true;
  let output: ExecOutput;
  try {
    output = await exec(["sh", "-c", TMUX_SOCKET_OWNER_PROBE, "sh", socketPath, ...pids]);
  } catch {
    return false;
  }
  if (output.status !== 0) return false;
  const lines = output.stdout.split("\n").filter((line) => line.length > 0);
  const listed = /^listed (yes|no)$/.exec(lines[0] ?? "")?.[1];
  const self = /^self (\S+)$/.exec(lines[1] ?? "")?.[1];
  if (!listed || !self || self === "?") return false;
  // A live socket with this exact path in our namespace: something serves it.
  if (listed === "yes") return false;
  const verdicts = new Map<string, string[]>();
  for (const line of lines.slice(2)) {
    const fields = line.split(" ");
    if (fields[0] !== "pid" || !fields[1]) return false;
    verdicts.set(fields[1], fields.slice(2));
  }
  return pids.every((pid) => {
    const verdict = verdicts.get(pid);
    if (!verdict) return false;
    if (verdict.length === 1 && verdict[0] === "gone") return true;
    if (verdict.length !== 2) return false;
    const [net, view] = verdict;
    // Same namespace: its listening sockets are in the table we searched.
    if (net === self) return true;
    // Another namespace that sees a different directory where the socket lives.
    return view === "differs";
  });
}
