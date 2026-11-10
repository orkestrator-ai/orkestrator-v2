import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { isDockerCopyRemountRefused, isDockerDaemonUnreachable } from "./docker-cli-errors.js";
import { CommandFailedError, runCommand } from "./shell.js";

/**
 * `docker cp` refused because the container has a read-only bind the daemon
 * cannot remount (to-do 7549 task 1). Under rootless Docker, once a
 * container has a read-only bind whose source filesystem is mounted `nosuid`
 * or `nodev` (a separately mounted `/home`, a tmpfs), every `docker cp` into
 * or out of it fails, running or stopped, because the daemon's archive path
 * remounts the bind without the flags its user namespace may not clear.
 * Start and `exec` still work.
 *
 * The CLI hides the daemon's answer for a copy into a directory (`… must be a
 * directory`, `no such directory`), because its first request, a stat of the
 * destination, fails the same way. {@link classifyDockerCopyFailure} asks the
 * daemon once more with a copy out of a path that cannot exist: a daemon that
 * can mount the container answers "Could not find the file", one that cannot
 * repeats the remount refusal.
 */

/** A path no container has; reading it costs the daemon one mount and a stat. */
export const COPY_PROBE_ABSENT_PATH = "/.orkestrator-copy-probe-absent";
const PROBE_TIMEOUT_MS = 10_000;

export const COPY_REFUSED_REMEDY =
  "Under rootless Docker this happens when a read-only bind's source (Orkestrator's data directory) is on a filesystem mounted nosuid or nodev, flags a user namespace cannot clear and Docker's copy path does not keep: keep Orkestrator's data directory on a filesystem mounted without them, or run Docker rootful.";

function messageOf(error: unknown): string {
  if (error instanceof CommandFailedError) return `${error.message}\n${error.stderr}`;
  return error instanceof Error ? error.message : String(error);
}

const COPY_REFUSED_NAME = "DockerCopyRefusedError";

/** The typed `unsupported-topology` error for a refused copy of `what`. */
export function dockerCopyRefusedError(what: string): Error {
  const error = new Error(
    formatContainerLifecycleError(
      "unsupported-topology",
      `Docker refused to copy ${what} (operation not permitted while remounting a read-only bind). ${COPY_REFUSED_REMEDY}`,
    ),
  );
  error.name = COPY_REFUSED_NAME;
  return error;
}

/** Whether `error` came from {@link dockerCopyRefusedError}. */
export function isDockerCopyRefusedError(error: unknown): boolean {
  return error instanceof Error && error.name === COPY_REFUSED_NAME;
}

/**
 * Whether the daemon refuses every copy for this container, asked directly.
 * Anything but the remount refusal (the expected "could not find", an
 * outage, a timeout) is not evidence of it.
 */
export async function dockerCopyRefusedNow(
  containerId: string,
  run: typeof runCommand = runCommand,
): Promise<boolean> {
  try {
    await run("docker", ["cp", `${containerId}:${COPY_PROBE_ABSENT_PATH}`, "-"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return false;
  } catch (error) {
    return isDockerCopyRemountRefused(messageOf(error));
  }
}

/**
 * The error to raise for a failed `docker cp` of `what` with `containerId`:
 * the typed refusal when the daemon's remount refused it (said so, or says
 * so when asked), otherwise `error` unchanged. A timeout or an outage is
 * never probed: neither is a refusal.
 */
export async function classifyDockerCopyFailure(
  containerId: string,
  error: unknown,
  what: string,
  run: typeof runCommand = runCommand,
): Promise<unknown> {
  const message = messageOf(error);
  if (isDockerCopyRemountRefused(message)) return dockerCopyRefusedError(what);
  if (error instanceof CommandFailedError && (error.timedOut || error.executableMissing)) {
    return error;
  }
  if (isDockerDaemonUnreachable(message)) return error;
  return (await dockerCopyRefusedNow(containerId, run)) ? dockerCopyRefusedError(what) : error;
}
