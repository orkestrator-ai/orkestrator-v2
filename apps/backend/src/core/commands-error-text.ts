import { CommandFailedError } from "./commands-dependencies.js";

export const LIFECYCLE_LOG_DETAIL_MAX_CHARS = 500;

/**
 * Bounded, user-facing error text.
 *
 * A leaf: `commands-servers` needs only these from `commands-projects`, and
 * hosting them there made the two modules mutually dependent.
 */

export function conciseError(error: unknown): string {
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
  imageUnavailable: "The environment image is unavailable. Rebuild it and retry.",
  diskFull: "The host has run out of disk space. Free space and retry.",
  gitSshAuthentication:
    "Git SSH authentication failed. Check that your SSH agent has a key authorized for this repository, or configure its socket in Settings > General, then restart Orkestrator and retry.",
} as const;

/**
 * Classifies a subprocess/storage failure into a message that is safe to
 * persist and render. Raw command errors can contain clone URLs, host paths,
 * environment variables, and child output, so the raw text never crosses this
 * boundary — the return value is always one of the constants above.
 *
 * Classification prefers `CommandFailedError`'s structured outcome over the
 * message. A timeout in particular is invisible in the text: `execFile` kills
 * the child, leaving only the generic "Command failed: <argv>".
 */
export function environmentLifecycleErrorMessage(error: unknown): string {
  if (error instanceof CommandFailedError) {
    if (error.timedOut) return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.timedOut;
    if (error.executableMissing) return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable;
  }

  const message = error instanceof Error ? error.message : "";
  if (message === ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.noLocalPath) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.noLocalPath;
  }
  if (message === "Setup script failed") {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript;
  }
  if (/permission denied \(publickey\)/i.test(message)) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitSshAuthentication;
  }
  // Matched against what the Docker CLI actually emits, not a paraphrase.
  if (
    /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect/i.test(
      message,
    )
  ) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable;
  }
  if (
    /unable to find image|pull access denied|manifest unknown|manifest for .* not found|no such image|repository does not exist/i.test(
      message,
    )
  ) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable;
  }
  if (/no space left on device/i.test(message)) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.diskFull;
  }
  return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown;
}

/**
 * Strips the credential shapes a subprocess failure realistically carries.
 *
 * `runCommand` already removes values the caller declared secret, but a child
 * echoes things the caller never named — most importantly the remote URL of a
 * failed clone or fetch, which carries its own credentials in userinfo.
 */
export function scrubLifecycleLogDetail(detail: string): string {
  const scrubbed = detail
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gi, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]{16,}\b/gi, "[redacted]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]+\b/gi, "[redacted]");

  return scrubbed.length > LIFECYCLE_LOG_DETAIL_MAX_CHARS
    ? `${scrubbed.slice(0, LIFECYCLE_LOG_DETAIL_MAX_CHARS)}…`
    : scrubbed;
}

/**
 * The persisted message is a fixed category, so without this the cause of a
 * failed start survives nowhere and "check the backend logs" is a dead end.
 *
 * The child's own text is the useful part, so it is logged — scrubbed, and
 * alongside the structured outcome, which is the only place a timeout or a
 * missing runtime is distinguishable from an ordinary non-zero exit.
 */
export function logEnvironmentLifecycleFailure(
  operation: string,
  environmentId: string,
  error: unknown,
): void {
  const detail = scrubLifecycleLogDetail(error instanceof Error ? error.message : String(error));
  const outcome =
    error instanceof CommandFailedError
      ? ` (timedOut=${error.timedOut} executableMissing=${error.executableMissing} exitCode=${error.exitCode} signal=${error.signal})`
      : "";
  console.error(
    `[environment-lifecycle] ${operation} failed for ${environmentId}: ${environmentLifecycleErrorMessage(error)}${outcome} — ${detail}`,
  );
}
