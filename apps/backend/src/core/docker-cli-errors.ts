import { CommandFailedError, runCommand } from "./shell.js";

/**
 * What a failed `docker` CLI call said, classified from its own wording.
 *
 * One table, so that the availability check, operation failure codes and
 * every copy step read the same text the same way.
 */

/**
 * The CLI reached no daemon. "connect: no such file or directory" is the
 * socket itself missing, which current CLIs report as "failed to connect to
 * the docker API at unix://…: dial unix …: connect: no such file or
 * directory" and older ones as "Cannot connect to the Docker daemon".
 */
const DAEMON_UNREACHABLE =
  /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect|failed to connect to the docker api|connect: no such file or directory/i;

/**
 * Only the daemon's own answer that a container path does not exist. A CLI
 * that reached no daemon also says "no such file or directory", so a looser
 * match would read a daemon outage as "nothing there".
 */
const DAEMON_PATH_NOT_FOUND = /error response from daemon: could not find the file/i;

export function isDockerDaemonUnreachable(text: string): boolean {
  return DAEMON_UNREACHABLE.test(text);
}

export function isDockerPathNotFound(text: string): boolean {
  return DAEMON_PATH_NOT_FOUND.test(text);
}

/**
 * Whether the daemon cannot be reached right now, asked directly. For a call
 * that failed without saying why in a recognisable way: a `docker cp` cut
 * off mid-stream reports its broken stream, not that the daemon went away
 * (live C15, 2026-10-26).
 * A daemon that answers, or a probe that failed for another reason, is not an
 * outage.
 */
export async function dockerDaemonUnreachableNow(timeoutMs = 10_000): Promise<boolean> {
  try {
    await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs });
    return false;
  } catch (error) {
    if (error instanceof CommandFailedError && error.timedOut) return true;
    return isDockerDaemonUnreachable(error instanceof Error ? error.message : String(error));
  }
}
