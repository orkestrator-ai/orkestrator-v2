import { CommandFailedError, GitRemoteTimeoutError } from "./shell.js";
import { parseContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";
import { sshConnectFailure, type SshConnectFailure } from "./git-ssh-transport.js";

const log = createLogger("environment");

export /**
 * Bounded, user-facing error text.
 *
 * A leaf: `commands-servers` needs only these from `commands-projects`, and
 * hosting them there made the two modules mutually dependent.
 */

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export function cleanupErrorMessage(error: unknown): string {
  if (error instanceof Error) return conciseError(error);
  if (typeof error === "string" && error.trim()) {
    return error.length > 500 ? `${error.slice(0, 500)}…` : error;
  }
  return "An unexpected error occurred";
}

/**
 * Every value this can return, so the persisted field is a closed set rather
 * than a bounded slice of child output. Nothing derived from a command,
 * a path, or a repository ever reaches it.
 */
export const ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES = {
  unknown: "Environment start failed. Check the backend logs and retry.",
  noLocalPath: "Project has no local path - cannot create a local worktree",
  setupScript: "Environment setup script failed.",
  timedOut: "Environment start timed out. Check the container runtime and retry.",
  runtimeUnavailable: "The container runtime is unavailable. Start it and retry.",
  imageUnavailable:
    "The environment image is unavailable. Provide or build the configured image and retry.",
  imageDownloadFailed:
    "The environment image could not be downloaded. Check your network connection, or build it with `mise run docker:build`, and retry.",
  diskFull: "The host has run out of disk space. Free space and retry.",
  initializationFailed:
    "The container did not finish initializing. Check the container logs, then retry.",
  initializationTimedOut:
    "The container did not finish initializing in time. Retry once it is ready.",
  containerRemovalFailed:
    "Docker did not remove the old container, so it was kept. Retry the reset once Docker is healthy.",
  gitSshAuthentication:
    "Git SSH authentication failed. Orkestrator can't enter a key passphrase, so a key authorized for this repository must be loaded in an SSH agent (ssh-add). If Orkestrator can't reach that agent, set its socket in Settings > General, then restart Orkestrator and retry.",
  baseBranchMissing:
    "The base branch does not exist on the git remote: it may have been deleted or renamed. Choose another base branch in the project settings, or recreate it on the remote, then retry.",
  gitRemoteTimedOut:
    "Timed out fetching from the git remote. Check your network connection and that your SSH agent has your key loaded (a passphrase-protected key must be added with ssh-add), then retry.",
} as const;

/**
 * The base branch an environment starts from does not exist on `origin`: it was
 * deleted or renamed there, or the project names a branch the remote never had.
 * Git's own "couldn't find remote ref" names neither the setting nor the fix.
 * The message names the branch for the caller; the persisted lifecycle error
 * is the fixed `baseBranchMissing` text.
 */
export class MissingRemoteBaseBranchError extends Error {
  constructor(readonly branch: string) {
    super(
      `Base branch "${branch}" does not exist on origin. It may have been deleted or renamed. ` +
        `Choose another base branch in the project settings, or recreate "${branch}" on the remote.`,
    );
    this.name = "MissingRemoteBaseBranchError";
  }
}

/**
 * The one lifecycle message that is not a fixed constant: a refused create has
 * to name the image, which the configured reference does without carrying a
 * path, credential or child output.
 */
export function imageWithoutStagedInputsMessage(image: string): string {
  return `The environment image ${image} is too old for new containers: it would need your whole agent home directories mounted into it. Nothing was created. Download a current image from Docker settings, or rebuild your custom image from the current Dockerfile, then retry.`;
}

const IMAGE_WITHOUT_STAGED_INPUTS =
  /ContainerLifecycleError:capability-unavailable: (The environment image \S+(?: \(\w+\))? is too old for new containers: .*)$/;

/**
 * OpenSSH could not open a connection to the remote, the usual sign of a
 * network that blocks outbound SSH. Names the host and port, which
 * `sshConnectFailure` restricts to hostname characters and a number, so no
 * path, credential or other child output reaches it.
 */
export function gitSshUnreachableMessage({ host, port }: SshConnectFailure): string {
  return `Couldn't reach the git remote over SSH (${host}, port ${port}). Your network may be blocking SSH. Retry on a network that allows it, or switch this project's remote to HTTPS.`;
}

const GIT_SSH_UNREACHABLE = /^Couldn't reach the git remote over SSH \([a-z0-9.-]+, port \d+\)\./;

/** Whether a lifecycle message is `gitSshUnreachableMessage`'s. */
export function isGitSshUnreachableMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && GIT_SSH_UNREACHABLE.test(message);
}

/**
 * Lifecycle messages that are about reaching the project's git remote, which
 * a failed start rethrows as-is so the immediate error says the same thing as
 * the persisted one.
 */
export function isGitRemoteLifecycleMessage(message: string): boolean {
  return (
    message === ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitSshAuthentication ||
    message === ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitRemoteTimedOut ||
    isGitSshUnreachableMessage(message)
  );
}

/** The manifest could not be read, which says nothing about the image's age. */
export function imageUnreadableMessage(image: string): string {
  return `Docker could not report what the environment image ${image} supports. Nothing was created. Check that Docker is running and retry.`;
}

/** OpenSSH's refusal once no key it could use was accepted, as Git relays it. */
export function isGitSshAuthenticationFailure(message: string): boolean {
  return /permission denied \((?:[^(),\s]+,\s*)*publickey(?:\s*,[^(),]+)*\)/i.test(message);
}

/**
 * Classifies a subprocess/storage failure into a message that is safe to
 * persist and render. Raw command errors can contain clone URLs, host paths,
 * environment variables, and child output, so the raw text never crosses this
 * boundary — the return value is one of the constants above, the image
 * refusal built by `imageWithoutStagedInputsMessage`, or the SSH connect
 * failure built by `gitSshUnreachableMessage`.
 *
 * Classification prefers `CommandFailedError`'s structured outcome over the
 * message. A timeout in particular is invisible in the text: `execFile` kills
 * the child, leaving only the generic "Command failed: <argv>".
 */
export function environmentLifecycleErrorMessage(error: unknown, causeDepth = 0): string {
  if (error instanceof Error && error.cause && causeDepth < 8) {
    const causeMessage = environmentLifecycleErrorMessage(error.cause, causeDepth + 1);
    if (causeMessage !== ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown) return causeMessage;
  }
  if (error instanceof MissingRemoteBaseBranchError) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.baseBranchMissing;
  }
  if (error instanceof CommandFailedError) {
    // Before the generic timeout: a stuck remote fetch is not a container problem.
    if (error instanceof GitRemoteTimeoutError) {
      return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitRemoteTimedOut;
    }
    if (error.timedOut) return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.timedOut;
    if (error.executableMissing) return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable;
  }

  const message = error instanceof Error ? error.message : "";
  // Before the authentication check: Git follows a refused connection with
  // "Could not read from remote repository", which says nothing about keys.
  const unreachable =
    sshConnectFailure(message) ??
    (error instanceof CommandFailedError ? sshConnectFailure(error.stderr) : null);
  if (unreachable) return gitSshUnreachableMessage(unreachable);
  const imageRefusal = IMAGE_WITHOUT_STAGED_INPUTS.exec(message)?.[1];
  if (imageRefusal) return imageRefusal;
  if (parseContainerLifecycleError(error)?.code === "not-ready") {
    return /did not complete in time/.test(message)
      ? ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.initializationTimedOut
      : ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.initializationFailed;
  }
  if (message === ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.noLocalPath) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.noLocalPath;
  }
  if (message === "Setup script failed") {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript;
  }
  if (isGitSshAuthenticationFailure(message)) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitSshAuthentication;
  }
  // Matched against what the Docker CLI actually emits, not a paraphrase.
  if (
    /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect|docker could not report what the environment image/i.test(
      message,
    )
  ) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable;
  }
  if (/no space left on device/i.test(message)) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.diskFull;
  }
  if (message.startsWith("Environment image download failed:")) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageDownloadFailed;
  }
  if (
    /unable to find image|pull access denied|manifest unknown|manifest for .* not found|no such image|repository does not exist/i.test(
      message,
    )
  ) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable;
  }
  return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown;
}

/**
 * The persisted message is a fixed category, so without this the cause of a
 * failed start survives nowhere and "check the backend logs" is a dead end.
 *
 * A failed command's output never reaches the log, so `reason` says what went
 * wrong, alongside the exit code and signal. docs/architecture/logging.md has
 * the list.
 */
export function logEnvironmentLifecycleFailure(
  operation: string,
  environmentId: string,
  error: unknown,
): void {
  log.error("lifecycle.failed", {
    operation,
    environmentId,
    summary: environmentLifecycleErrorMessage(error),
    ...classifyCommandFailure(error, { tools: ["docker", "git"] }),
    error: formatLogError(error),
  });
}
