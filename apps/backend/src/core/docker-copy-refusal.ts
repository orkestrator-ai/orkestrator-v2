import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { createLogger } from "@orkestrator/protocol/logger";
import {
  isDockerCopyRemountRefused,
  isDockerCopySnapshotBusy,
  isDockerDaemonUnreachable,
} from "./docker-cli-errors.js";
import { CommandFailedError, runCommand } from "./shell.js";

const log = createLogger("docker");

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

/**
 * Pauses before retrying a copy into a container the daemon could not mount
 * because its filesystem was busy (to-do 7549 task 2), one per retry. On
 * 2026-11-09 a one-layer container accepted the second copy; the 78-layer
 * environment image refused three in a row, also 5 s apart, and the cause was
 * not established. The pauses cover the transient case; a container still
 * busy after them fails with {@link dockerCopyBusyError}.
 */
export const COPY_BUSY_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

const COPY_BUSY_NAME = "DockerCopyBusyError";

/** The typed error for a copy of `what` the daemon kept refusing as busy. */
export function dockerCopyBusyError(what: string): Error {
  const error = new Error(
    formatContainerLifecycleError(
      "unsupported-topology",
      `Docker could not mount the new container's filesystem to copy ${what} (device or resource busy), ${COPY_BUSY_RETRY_DELAYS_MS.length + 1} times in a row. This has been seen only under rootless Docker; try again, and if it keeps happening run Docker rootful.`,
    ),
  );
  error.name = COPY_BUSY_NAME;
  return error;
}

/** Whether `error` came from {@link dockerCopyBusyError}. */
export function isDockerCopyBusyError(error: unknown): boolean {
  return error instanceof Error && error.name === COPY_BUSY_NAME;
}

/**
 * Runs one `docker cp` into a created or stopped container, retrying it after
 * {@link COPY_BUSY_RETRY_DELAYS_MS} while the daemon answers that the
 * container's filesystem is busy. Any other failure is classified as
 * {@link classifyDockerCopyFailure} does; a copy still busy after the retries
 * is {@link dockerCopyBusyError}. The copy is a whole archive or directory
 * the daemon either extracted or refused before extracting (it failed to
 * mount), so repeating it is safe.
 */
export async function copyIntoContainer(
  containerId: string,
  args: string[],
  options: Parameters<typeof runCommand>[2],
  what: string,
  deps: { run?: typeof runCommand; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const run = deps.run ?? runCommand;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let retry = 0; ; retry += 1) {
    try {
      await run("docker", args, options);
      if (retry > 0) {
        log.info("copy-in.snapshot-busy-recovered", {
          container: containerId.slice(0, 12),
          retries: retry,
        });
      }
      return;
    } catch (error) {
      if (!isDockerCopySnapshotBusy(messageOf(error))) {
        throw await classifyDockerCopyFailure(containerId, error, what, run);
      }
      if (retry >= COPY_BUSY_RETRY_DELAYS_MS.length) {
        log.warn("copy-in.snapshot-busy", {
          container: containerId.slice(0, 12),
          attempts: retry + 1,
        });
        throw dockerCopyBusyError(what);
      }
      log.warn("copy-in.snapshot-busy-retrying", {
        container: containerId.slice(0, 12),
        retry: retry + 1,
      });
      await sleep(COPY_BUSY_RETRY_DELAYS_MS[retry]!);
    }
  }
}
