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
 * An attached `docker run` lost the daemon while it waited for its container:
 * the daemon stopped or restarted underneath it. Engine 29.9 prints "Error
 * waiting for container: Canceled: grpc: the client connection is closing:
 * context canceled" for a daemon that shuts down gracefully and "error
 * waiting for container: unexpected EOF" for one that is killed, both with
 * exit 125 and no output from the container's command. Only connection-loss
 * wording counts; a daemon that answered (`Error response from daemon: …`) is
 * not an outage, even when its answer itself names one of those words (the
 * lookahead refuses the whole line). Without this, a copy helper cut off by a `systemctl restart
 * docker` read as files that failed verification: by the time the outage was
 * probed, systemd's socket activation held the probe until the new daemon
 * answered it (live C15 on GitHub's runners).
 */
const DAEMON_LOST_WHILE_WAITING =
  /error waiting for container: (?![^\n]*error response from daemon)[^\n]*\b(?:unexpected EOF|context canceled|client connection is closing|connection reset by peer|connection refused|broken pipe)\b/i;

/**
 * Only the daemon's own answer that a container path does not exist. A CLI
 * that reached no daemon also says "no such file or directory", so a looser
 * match would read a daemon outage as "nothing there".
 */
const DAEMON_PATH_NOT_FOUND = /error response from daemon: could not find the file/i;

/**
 * The daemon's archive path (`docker cp`, in or out, running or stopped)
 * could not remount a read-only bind: under rootless Docker, a bind whose
 * source filesystem is mounted `nosuid`/`nodev` carries flags a user
 * namespace cannot clear, and the daemon remounts it without them
 * (`remount-ro <rootfs>/<target>, flags: 0x1021: operation not permitted`,
 * Engine 29.9.2, to-do 7549). Start and `exec` keep the flags and work.
 */
const ARCHIVE_REMOUNT_REFUSED = /remount-ro .*operation not permitted/i;

/**
 * The daemon's archive path could not mount a container that is not running:
 * `failed to mount <data-root>/rootfs/overlayfs/<id>: … fstype: overlay, …
 * err: device or resource busy` (rootless Engine 29.9.2, containerd image
 * store, kernel 7.2.15, 2026-11-09; to-do 7549 task 2). Only the daemon's
 * own answer about that mount counts.
 */
const ARCHIVE_SNAPSHOT_BUSY =
  /error response from daemon: failed to mount [^\n]*device or resource busy/i;

export function isDockerCopyRemountRefused(text: string): boolean {
  return ARCHIVE_REMOUNT_REFUSED.test(text);
}

/** The daemon could not mount a stopped or created container's filesystem for a copy: it was busy. */
export function isDockerCopySnapshotBusy(text: string): boolean {
  return ARCHIVE_SNAPSHOT_BUSY.test(text);
}

/** The CLI reached no daemon, or lost the one it was waiting on. */
export function isDockerDaemonUnreachable(text: string): boolean {
  return DAEMON_UNREACHABLE.test(text) || DAEMON_LOST_WHILE_WAITING.test(text);
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
