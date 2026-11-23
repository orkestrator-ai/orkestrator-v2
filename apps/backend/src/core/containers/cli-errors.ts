import { CommandFailedError, runCommand } from "../shell.js";

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

/**
 * Exit statuses of a container stopped from outside: SIGTERM (143), then
 * SIGKILL (137) once its stop timeout passes.
 */
const STOPPED_FROM_OUTSIDE = new Set([137, 143]);

/** An attached `docker run` whose container was stopped by a signal it did not send itself. */
export function isDockerRunStoppedFromOutside(error: unknown): boolean {
  return (
    error instanceof CommandFailedError &&
    !error.timedOut &&
    error.exitCode !== null &&
    STOPPED_FROM_OUTSIDE.has(error.exitCode)
  );
}

/**
 * Read the helper's exit history after a signal-only copy failure. A daemon
 * shutting down can keep the attached run alive until the helper exits, so
 * the history request may be the first call to see the connection fail.
 * Empty history is indeterminate: the daemon retains a bounded event buffer.
 */
export async function dockerContainerExitEvidence(
  name: string,
  sinceMs: number,
  timeoutMs = 10_000,
): Promise<"recorded" | "unknown" | "daemon-unavailable"> {
  try {
    const { stdout } = await runCommand(
      "docker",
      [
        "events",
        "--since",
        String(Math.floor(sinceMs / 1000) - 5),
        "--until",
        String(Math.ceil(Date.now() / 1000)),
        "--filter",
        `container=${name}`,
        "--filter",
        "event=die",
        "--format",
        "{{.Action}}",
      ],
      { timeoutMs },
    );
    return stdout.split("\n").some((line) => line.trim() === "die") ? "recorded" : "unknown";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/permission denied|access denied/i.test(message) && isDockerDaemonUnreachable(message)) {
      return "daemon-unavailable";
    }
    return "unknown";
  }
}

/**
 * Which daemon start a call reached. Docker publishes no start time of its
 * own, but every daemon start deletes and recreates the default `bridge`
 * network when no container survives the restart (moby
 * `configureNetworking`, "Clear stale bridge network"), so that network's ID
 * and creation time change exactly when the daemon restarts. Live-restore
 * keeps it while containers survive; so does a daemon run with
 * `--bridge=none`, which has no such network and reads as `unknown`.
 */
export type DockerDaemonStart =
  { kind: "started"; marker: string } | { kind: "unreachable" } | { kind: "unknown" };

export async function dockerDaemonStart(timeoutMs = 10_000): Promise<DockerDaemonStart> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["network", "inspect", "bridge", "--format", "{{.Id}} {{.Created}}"],
      { timeoutMs },
    );
    const marker = stdout.trim();
    return /^[0-9a-f]{12,} \S/.test(marker) ? { kind: "started", marker } : { kind: "unknown" };
  } catch (error) {
    if (error instanceof CommandFailedError && error.timedOut) return { kind: "unreachable" };
    const message = error instanceof Error ? error.message : String(error);
    if (!/permission denied|access denied/i.test(message) && isDockerDaemonUnreachable(message)) {
      return { kind: "unreachable" };
    }
    return { kind: "unknown" };
  }
}

/**
 * Compares the daemon start read before a step with the one read after it.
 * `restarted` only when both reads named a start and they differ; a daemon
 * that does not answer afterwards is `unreachable`.
 */
export function dockerDaemonRestartBetween(
  before: DockerDaemonStart,
  after: DockerDaemonStart,
): "restarted" | "same" | "unreachable" | "unknown" {
  if (after.kind === "unreachable") return "unreachable";
  if (before.kind !== "started" || after.kind !== "started") return "unknown";
  return before.marker === after.marker ? "same" : "restarted";
}
